/**
 * ACP Docker Supervisor — the ONLY component allowed to talk to Docker.
 *
 * It exists so the Docker socket is never exposed to the control plane,
 * the dashboard, MCP, or (especially) guests. The API is deliberately
 * narrow, and every operation is scoped to computers this platform owns:
 *
 *  - A computer's container/volume names are derived HERE from its id
 *    (`acp-<id>`, `acp-<id>-home`); callers never supply names.
 *  - Every start/stop/inspect/stats/remove first verifies the container
 *    carries labels acp.managed=true + acp.computer=<id> AND the expected
 *    name, otherwise it refuses (403). This closes the classic
 *    "regex-matched some other container" flaw.
 *  - Container creation is built from a fixed template; the caller picks
 *    only name/cpu/memory from validated ranges. There is no way to ask
 *    for privileged mode, extra mounts, devices, host networking, or a
 *    different image than the configured guest image. Unknown fields in
 *    the request are rejected, not ignored.
 *  - The single permitted bind is the computer's own home volume at
 *    /home/agent. The Docker socket is never mounted into a guest.
 *
 * Transport: HTTP over a unix socket (default /run/acp/supervisor.sock),
 * authenticated with a shared secret header. Backend: Docker Engine API
 * over /var/run/docker.sock.
 */
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createGuestNetwork } from "./network.ts";
import { admission, validateLimits } from "./resources.ts";

const SOCK = process.env.ACP_SUPERVISOR_SOCK ?? "/run/acp/supervisor.sock";
const SECRET = process.env.ACP_SUPERVISOR_SECRET || "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const DOCKER_SOCK = process.env.ACP_DOCKER_SOCK ?? "/var/run/docker.sock";
const GUEST_IMAGE = process.env.ACP_GUEST_IMAGE ?? "agentcomputer/guest:phase0";
const NETWORK = process.env.ACP_GUEST_NETWORK ?? "none"; // this dev VM has no bridge; production sets an internal bridge network name

function getRuntimeVolume(): string {
  try {
    const info = fs.readFileSync("/proc/self/mountinfo", "utf8");
    const m = /\/var\/lib\/docker\/volumes\/([^/]+)\/_data\s+\/run\/acp/.exec(info);
    if (m) return m[1];
  } catch {}
  return process.env.ACP_RUNTIME_VOLUME ?? "agentcomputer_acp-run";
}

const RUNTIME_VOLUME = getRuntimeVolume();
const RUNTIME_DIR = process.env.ACP_RUNTIME_DIR ?? path.dirname(SOCK);
const REGISTRY_FILE = process.env.ACP_REGISTRY_FILE ?? "/data/supervisor/registry.json";
type Identity = { containerId: string; volume: string; mountpoint: string; networkId?: string; proxyId?: string; deleting?: boolean; deleteVolume?: boolean };
let identities: Record<string, Identity> = {};
try {
  identities = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  if (!identities || Array.isArray(identities) || typeof identities !== "object") throw new Error("invalid registry");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
}
function saveIdentities() {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${REGISTRY_FILE}.tmp`, JSON.stringify(identities), { mode: 0o600 });
  fs.renameSync(`${REGISTRY_FILE}.tmp`, REGISTRY_FILE);
}

const idOk = (id: string) => /^[a-z0-9][a-z0-9-]{2,40}$/.test(id);
const containerName = (id: string) => `acp-${id}`;
const volumeName = (id: string) => `acp-${id}-home`;

function dockerCall<T = unknown>(
  method: string, path: string, body?: unknown, timeoutMs = 60000,
): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCK, method, path, timeout: timeoutMs,
        headers: { "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data: unknown = text;
          try { data = JSON.parse(text); } catch { /* keep text */ }
          resolve({ status: res.statusCode ?? 0, data: data as T });
        });
      });
    req.on("timeout", () => req.destroy(new Error("docker call timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

interface InspectData {
  Id: string;
  Name: string;
  Config: { Labels?: Record<string, string>; Image: string };
  State: { Running: boolean; Status: string; StartedAt: string };
  Mounts: { Name?: string; Destination: string }[];
  HostConfig: { Privileged: boolean };
}

async function inspectManaged(id: string): Promise<InspectData> {
  if (!idOk(id)) throw Object.assign(new Error("invalid computerId"), { code: 400 });
  const identity = Object.hasOwn(identities, id) ? identities[id] : undefined;
  if (!identity) throw Object.assign(new Error("computer is not registered with this supervisor"), { code: 403 });
  const name = containerName(id);
  const { status, data } = await dockerCall<InspectData>("GET", `/containers/${name}/json`);
  if (status === 404) throw Object.assign(new Error(`computer ${id} not found`), { code: 404 });
  if (status !== 200) throw Object.assign(new Error(`inspect failed: ${status}`), { code: 502 });
  const labels = data.Config.Labels ?? {};
  if (data.Id !== identity.containerId || data.Name !== `/${name}` || labels["acp.managed"] !== "true" || labels["acp.computer"] !== id) {
    throw Object.assign(new Error(`container ${name} is not an ACP-managed computer`), { code: 403 });
  }
  const home = data.Mounts.find((m) => m.Destination === "/home/agent");
  if (home?.Name !== identity.volume || data.HostConfig.Privileged) {
    throw Object.assign(new Error("managed container configuration changed"), { code: 403 });
  }
  return data;
}

async function createComputer(body: Record<string, unknown>) {
  const allowed = new Set(["computerId", "displayName", "cpuMillis", "memoryMb"]);
  for (const k of Object.keys(body)) {
    if (!allowed.has(k)) {
      throw Object.assign(new Error(`field not allowed in create payload: ${k}`), { code: 400 });
    }
  }
  const id = String(body.computerId ?? "");
  if (!idOk(id)) throw Object.assign(new Error("invalid computerId"), { code: 400 });
  const cpuMillis = Number(body.cpuMillis ?? 1000);
  const memoryMb = Number(body.memoryMb ?? 2048);
  if (!Number.isFinite(cpuMillis) || cpuMillis < 250 || cpuMillis > 8000) {
    throw Object.assign(new Error("cpuMillis out of range 250..8000"), { code: 400 });
  }
  if (!Number.isFinite(memoryMb) || memoryMb < 256 || memoryMb > 16384) {
    throw Object.assign(new Error("memoryMb out of range 256..16384"), { code: 400 });
  }
  if (Object.hasOwn(identities, id)) throw Object.assign(new Error("computer already registered"), { code: 409 });
  const existing = await dockerCall("GET", `/containers/${containerName(id)}/json`);
  if (existing.status !== 404) throw Object.assign(new Error("container name unavailable"), { code: 409 });
  const existingVolume = await dockerCall("GET", `/volumes/${volumeName(id)}`);
  if (existingVolume.status !== 404) throw Object.assign(new Error("volume name unavailable"), { code: 409 });
  const runtime = await dockerCall<{ Mountpoint: string }>("GET", `/volumes/${encodeURIComponent(RUNTIME_VOLUME)}`);
  if (runtime.status !== 200 || !path.isAbsolute(runtime.data.Mountpoint)) {
    throw Object.assign(new Error("runtime volume unavailable"), { code: 503 });
  }
  validateLimits(memoryMb, cpuMillis);
  const decision = await resources({ memoryMb, cpuMillis });
  if (!decision.allowed) throw Object.assign(new Error(decision.reason), { code: 409 });
  const localRuntime = path.join(RUNTIME_DIR, "guests", id);
  fs.mkdirSync(localRuntime, { recursive: true, mode: 0o700 });
  fs.chownSync(localRuntime, 1000, 1000);
  const guestRuntime = `${runtime.data.Mountpoint}/guests/${id}`;
  validateLimits(memoryMb, cpuMillis);
  const guestToken = crypto.randomBytes(24).toString("hex");

  // Home volume first.
  const vol = await dockerCall("POST", "/volumes/create",
    { Name: volumeName(id), Labels: { "acp.managed": "true", "acp.computer": id } });
  if (vol.status !== 201) throw Object.assign(new Error(`volume create failed: ${vol.status}`), { code: 502 });
  const volInfo = await dockerCall<{ Mountpoint: string }>("GET", `/volumes/${volumeName(id)}`);
  const mountpoint = (volInfo.data as { Mountpoint: string }).Mountpoint;

  // Fail closed: network isolation must never depend on a daemon default.
  const isolated = NETWORK !== "none" ? await createGuestNetwork(id, dockerCall, process.env.ACP_EGRESS_CONTAINER ?? "agentcomputer-egress-1") : null;
  const guestNetwork = isolated?.name ?? "none";
  const useNetwork = isolated !== null;
  const payload = {
    Image: GUEST_IMAGE,
    Env: [
      `GUEST_TOKEN=${guestToken}`,
      "GUEST_SUPERVISOR_SOCK=/run/acp-guest/api.sock",
      ...(process.env.ACP_ENABLE_EGRESS_PROXY === "true" && process.env.ACP_EGRESS_PROXY_URL ? [
        `HTTP_PROXY=${process.env.ACP_EGRESS_PROXY_URL}`,
        `HTTPS_PROXY=${process.env.ACP_EGRESS_PROXY_URL}`,
        `http_proxy=${process.env.ACP_EGRESS_PROXY_URL}`,
        `https_proxy=${process.env.ACP_EGRESS_PROXY_URL}`,
        "NO_PROXY=localhost,127.0.0.1",
        "no_proxy=localhost,127.0.0.1",
        `ACP_BROWSER_PROXY=${process.env.ACP_EGRESS_PROXY_URL}`,
      ] : [])
    ],
    Labels: {
      "acp.managed": "true",
      "acp.computer": id,
      "acp.name": String(body.displayName ?? id).slice(0, 80),
    },
    HostConfig: {
      Binds: [`${volumeName(id)}:/home/agent`, `${guestRuntime}:/run/acp-guest`],
      NanoCpus: Math.round(cpuMillis * 1_000_000),
      Memory: Math.round(memoryMb * 1024 * 1024),
      NetworkMode: guestNetwork,
      MemorySwap: Math.round(memoryMb * 1024 * 1024),
      PidsLimit: 512,
      Privileged: false,
      // Minimal capability set the guest actually needs: supervisord
      // drops to the agent user (SETUID/SETGID), the entrypoint fixes
      // ownership of runtime dirs (CHOWN/FOWNER), root reads its own
      // tree (DAC_OVERRIDE). Everything else is dropped; in particular
      // no SYS_ADMIN, no NET_ADMIN, no devices, no host mounts.
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
      SecurityOpt: ["no-new-privileges"],
      AutoRemove: false,
    },
    NetworkingConfig: useNetwork ? {
      EndpointsConfig: { [guestNetwork]: {} },
    } : undefined,
  };
  const created = await dockerCall<{ Id: string }>(
    "POST", `/containers/create?name=${containerName(id)}`, payload);
  if (created.status !== 201 || !created.data.Id) {
    throw Object.assign(new Error(`container creation rejected: ${created.status}; resource enforcement is required`), { code: 502 });
  }
  identities[id] = { containerId: created.data.Id, volume: volumeName(id), mountpoint, networkId: isolated?.id, proxyId: isolated?.proxyId };
  saveIdentities();
  const limitsEnforced = true;
  return {
    computerId: id,
    container: containerName(id),
    volume: volumeName(id),
    guestToken,
    limitsEnforced,
    // Dev-VM guest channel: the supervisor's unix socket in the home volume.
    socketPath: `${localRuntime}/api.sock`,
  };
}

async function stats(id: string) {
  const managed = await inspectManaged(id);
  const { status, data } = await dockerCall<Record<string, unknown>>(
    "GET", `/containers/${managed.Id}/stats?stream=false`, undefined, 30000);
  if (status !== 200) throw Object.assign(new Error(`stats failed: ${status}`), { code: 502 });
  const d = data as {
    cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
    precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
    memory_stats?: { usage?: number; limit?: number };
    networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
  };
  const cpuDelta = (d.cpu_stats?.cpu_usage?.total_usage ?? 0) - (d.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (d.cpu_stats?.system_cpu_usage ?? 0) - (d.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = d.cpu_stats?.online_cpus ?? 1;
  const cpuPercent = sysDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
  let rx = 0, tx = 0;
  for (const n of Object.values(d.networks ?? {})) { rx += n.rx_bytes; tx += n.tx_bytes; }
  return {
    cpuPercent: Number(cpuPercent.toFixed(2)),
    memoryUsageMb: Math.round((d.memory_stats?.usage ?? 0) / 1048576),
    memoryLimitMb: Math.round((d.memory_stats?.limit ?? 0) / 1048576),
    networkRxMb: Number((rx / 1048576).toFixed(2)),
    networkTxMb: Number((tx / 1048576).toFixed(2)),
  };
}

async function resources(requested = { memoryMb: 256, cpuMillis: 250 }) {
  const info = await dockerCall<{ MemTotal: number; NCPU: number; Architecture: string; CgroupVersion: string; MemoryLimit: boolean; CpuCfsQuota: boolean }>("GET", "/info");
  if (info.status !== 200 || !info.data.MemoryLimit || !info.data.CpuCfsQuota) {
    throw Object.assign(new Error("Docker CPU and memory enforcement unavailable"), { code: 503 });
  }
  const meminfo = fs.readFileSync(process.env.ACP_HOST_MEMINFO ?? "/proc/meminfo", "utf8");
  const available = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  if (!available) throw Object.assign(new Error("host available memory unavailable"), { code: 503 });
  const st = fs.statfsSync(process.env.ACP_STORAGE_PROBE ?? "/docker-storage");
  const running: { memoryMb: number; cpuMillis: number }[] = [];
  for (const id of Object.keys(identities)) {
    let d: InspectData;
    try { d = await inspectManaged(id); }
    catch (error) { if ((error as { code?: number }).code === 404) continue; throw error; }
    if (d.State.Running) {
      const hc = d.HostConfig as unknown as { Memory: number; NanoCpus: number };
      if (!(hc.Memory > 0) || !(hc.NanoCpus > 0)) throw Object.assign(new Error("running computer lacks enforced limits"), { code: 503 });
      running.push({ memoryMb: hc.Memory / 1048576, cpuMillis: hc.NanoCpus / 1000000 });
    }
  }
  return admission({ totalMemoryMb: info.data.MemTotal / 1048576,
    availableMemoryMb: Number(available[1]) / 1024, cpuMillis: info.data.NCPU * 1000,
    freeDiskGb: Number(st.bavail) * Number(st.bsize) / 1e9 }, running, requested,
    { reserveMemoryMb: Number(process.env.ACP_HOST_RESERVE_MB ?? Math.max(1024, Math.ceil(info.data.MemTotal / 1048576 * 0.2))),
      minFreeDiskGb: Number(process.env.ACP_MIN_FREE_DISK_GB ?? 5),
      maxRunning: Number(process.env.ACP_MAX_RUNNING ?? 4), cpuOvercommit: Number(process.env.ACP_CPU_OVERCOMMIT ?? 1) });
}

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  "/resources": () => resources(),
  "/create": (b) => createComputer(b),
  "/start": async (b) => {
    const id = String(b.computerId ?? "");
    const d = await inspectManaged(id);
    if (!d.State.Running) {
      const hc = d.HostConfig as unknown as { Memory: number; NanoCpus: number };
      const decision = await resources({ memoryMb: hc.Memory / 1048576, cpuMillis: hc.NanoCpus / 1000000 });
      if (!decision.allowed) throw Object.assign(new Error(decision.reason), { code: 409 });
    }
    const r = await dockerCall("POST", `/containers/${d.Id}/start`);
    if (r.status !== 204 && r.status !== 304) throw Object.assign(new Error(`start failed: ${r.status}`), { code: 502 });
    return { ok: true };
  },
  "/stop": async (b) => {
    const id = String(b.computerId ?? "");
    const managed = await inspectManaged(id);
    const grace = Math.min(60, Math.max(1, Number(b.graceS ?? 20)));
    const r = await dockerCall("POST", `/containers/${managed.Id}/stop?t=${grace}`, undefined, (grace + 30) * 1000);
    if (r.status !== 204 && r.status !== 304) throw Object.assign(new Error(`stop failed: ${r.status}`), { code: 502 });
    return { ok: true };
  },
  "/remove": async (b) => {
    const id = String(b.computerId ?? "");
    const identity = Object.hasOwn(identities, id) ? identities[id] : undefined;
    if (!identity) throw Object.assign(new Error("computer is not registered"), { code: 403 });
    try { await inspectManaged(id); }
    catch (error) { if (!(identity.deleting && (error as { code?: number }).code === 404)) throw error; }
    const removeVolume = identity.deleting ? identity.deleteVolume === true : b.removeVolume === true;
    if (removeVolume) {
      const volume = await dockerCall<{ Mountpoint: string; Labels: Record<string, string> }>("GET", `/volumes/${volumeName(id)}`);
      if (!(volume.status === 404 && identity.deleting) &&
          (volume.status !== 200 || volume.data.Mountpoint !== identity.mountpoint ||
          volume.data.Labels?.["acp.computer"] !== id || volume.data.Labels?.["acp.managed"] !== "true")) {
        throw Object.assign(new Error("volume identity mismatch; refusing deletion"), { code: 403 });
      }
    }
    identity.deleting = true;
    identity.deleteVolume = removeVolume;
    saveIdentities();
    const r = await dockerCall("DELETE", `/containers/${identity.containerId}?force=true`);
    if (r.status !== 204 && r.status !== 404) throw Object.assign(new Error(`remove failed: ${r.status}`), { code: 502 });
    if (removeVolume) {
      const v = await dockerCall("DELETE", `/volumes/${volumeName(id)}`);
      if (v.status !== 204 && v.status !== 404) throw Object.assign(new Error(`volume remove failed: ${v.status}`), { code: 502 });
    }
    if (identity.networkId) {
      if (identity.proxyId) {
        const disconnected = await dockerCall("POST", `/networks/${identity.networkId}/disconnect`, { Container: identity.proxyId, Force: true });
        if (![200, 404].includes(disconnected.status)) throw Object.assign(new Error("network disconnect failed"), { code: 502 });
      }
      const removedNetwork = await dockerCall("DELETE", `/networks/${identity.networkId}`);
      if (![204, 404].includes(removedNetwork.status)) throw Object.assign(new Error("network cleanup failed"), { code: 502 });
    }
    delete identities[id];
    saveIdentities();
    return { ok: true };
  },
  "/inspect": async (b) => {
    const id = String(b.computerId ?? "");
    const d = await inspectManaged(id);
    return {
      running: d.State.Running, status: d.State.Status, startedAt: d.State.StartedAt,
      image: d.Config.Image, privileged: d.HostConfig.Privileged,
    };
  },
  "/stats": (b) => stats(String(b.computerId ?? "")),
  "/ping": async () => ({ ok: true, image: GUEST_IMAGE, network: NETWORK }),
};

// Serialize privileged mutations, including create, to prevent ownership races.
let requestChain: Promise<unknown> = Promise.resolve();
const server = http.createServer((req, res) => {
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const provided = String(req.headers["x-supervisor-secret"] ?? "");
  const a = Buffer.from(provided);
  const b = Buffer.from(SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return send(401, { error: "unauthorized" });
  }
  const routeName = (req.url ?? "").split("?")[0];
  const handler = Object.hasOwn(routes, routeName) ? routes[routeName] : undefined;
  if (req.method !== "POST" || !handler) return send(404, { error: "no such route" });
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 65536) { req.destroy(); return; }
    chunks.push(c as Buffer);
  });
  req.on("end", async () => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {
      return send(400, { error: "invalid JSON" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { error: "body must be an object" });
    const fields: Record<string, string[]> = {
      "/create": ["computerId", "displayName", "cpuMillis", "memoryMb"],
      "/start": ["computerId"], "/stop": ["computerId", "graceS"],
      "/remove": ["computerId", "removeVolume"], "/inspect": ["computerId"],
      "/stats": ["computerId"], "/ping": [], "/resources": [],
    };
    if (Object.keys(body).some((key) => !fields[routeName].includes(key))) return send(400, { error: "unknown request field" });
    if ("computerId" in body && (typeof body.computerId !== "string" || !idOk(body.computerId))) return send(400, { error: "invalid computerId" });
    if (routeName === "/stop" && body.graceS !== undefined && (!Number.isInteger(body.graceS) || Number(body.graceS) < 1 || Number(body.graceS) > 60)) return send(400, { error: "invalid stop grace" });
    if (routeName === "/remove" && body.removeVolume !== undefined && typeof body.removeVolume !== "boolean") return send(400, { error: "invalid removeVolume" });
    try {
      const operation = requestChain.then(() => handler(body));
      requestChain = operation.catch(() => undefined);
      send(200, await operation);
    } catch (e) {
      const err = e as Error & { code?: number };
      send(err.code ?? 500, { error: err.message });
    }
  });
});

try { fs.unlinkSync(SOCK); } catch { /* fresh path */ }
fs.mkdirSync(path.dirname(SOCK), { recursive: true });
process.on("unhandledRejection", (e) => {
  console.error("unhandled rejection (continuing):", e);
});
process.on("uncaughtException", (e) => {
  console.error("uncaught exception (exiting for a clean restart):", e);
  process.exit(1);
});

server.listen(SOCK, () => {
  try { fs.chmodSync(SOCK, 0o660); } catch { /* best effort */ }
  console.log(`acp-supervisor listening on ${SOCK} (image=${GUEST_IMAGE}, network=${NETWORK})`);
});
