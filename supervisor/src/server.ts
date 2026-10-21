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

const SOCK = process.env.ACP_SUPERVISOR_SOCK ?? "/run/acp/supervisor.sock";
const SECRET = process.env.ACP_SUPERVISOR_SECRET ?? "";
const DOCKER_SOCK = process.env.ACP_DOCKER_SOCK ?? "/var/run/docker.sock";
const GUEST_IMAGE = process.env.ACP_GUEST_IMAGE ?? "agentcomputer/guest:phase0";
const NETWORK = process.env.ACP_GUEST_NETWORK ?? "none"; // this dev VM has no bridge; production sets an internal bridge network name

if (!SECRET) {
  console.error("ACP_SUPERVISOR_SECRET is required");
  process.exit(1);
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
  const name = containerName(id);
  const { status, data } = await dockerCall<InspectData>("GET", `/containers/${name}/json`);
  if (status === 404) throw Object.assign(new Error(`computer ${id} not found`), { code: 404 });
  if (status !== 200) throw Object.assign(new Error(`inspect failed: ${status}`), { code: 502 });
  const labels = data.Config.Labels ?? {};
  if (data.Name !== `/${name}` || labels["acp.managed"] !== "true" || labels["acp.computer"] !== id) {
    throw Object.assign(new Error(`container ${name} is not an ACP-managed computer`), { code: 403 });
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
  const guestToken = crypto.randomBytes(24).toString("hex");

  // Host disk guard: refuse creation when the Docker data filesystem is
  // nearly full — a guest home volume starts at ~2.4GB (browser cache
  // copy) and a full host disk damages every computer at once.
  const minFreeGb = Number(process.env.ACP_MIN_FREE_DISK_GB ?? 5);
  if (minFreeGb > 0) {
    const info = await dockerCall<{ DockerRootDir?: string }>("GET", "/info");
    const root = info.data?.DockerRootDir || "/var/lib/docker";
    // In containerized deployments only the volumes subtree may be
    // visible at the host's path; measure the first candidate that
    // exists. All candidates live on the filesystem that holds the
    // guest volumes on any standard Docker install.
    let freeGb: number | null = null;
    for (const candidate of [`${root}/volumes`, root, "/"]) {
      try {
        const st = fs.statfsSync(candidate);
        freeGb = (Number(st.bavail) * Number(st.bsize)) / 1e9;
        break;
      } catch { /* try the next candidate */ }
    }
    if (freeGb !== null && freeGb < minFreeGb) {
      throw Object.assign(new Error(
        `insufficient free disk on host: ${freeGb.toFixed(1)} GB free on the Docker volumes filesystem; ` +
        `${minFreeGb} GB minimum (ACP_MIN_FREE_DISK_GB)`), { code: 507 });
    }
  }

  // Home volume first.
  const vol = await dockerCall("POST", "/volumes/create",
    { Name: volumeName(id), Labels: { "acp.managed": "true", "acp.computer": id } });
  if (vol.status !== 201) throw Object.assign(new Error(`volume create failed: ${vol.status}`), { code: 502 });
  const volInfo = await dockerCall<{ Mountpoint: string }>("GET", `/volumes/${volumeName(id)}`);
  const mountpoint = (volInfo.data as { Mountpoint: string }).Mountpoint;

  // NOTE: NetworkMode "none" is OMITTED, not set. Measured on the dev VM:
  // explicitly setting it makes dockerd program the (null) network via a
  // libnetwork prestart hook that re-executes the daemon binary — which
  // sandboxed hosts block, failing every start. Omitting it yields the
  // same no-network result through the normal path. A real bridge
  // network name is set explicitly, as production uses.
  const useNetwork = NETWORK !== "none";
  const payload = {
    Image: GUEST_IMAGE,
    Env: [`GUEST_TOKEN=${guestToken}`],
    Labels: {
      "acp.managed": "true",
      "acp.computer": id,
      "acp.name": String(body.displayName ?? id).slice(0, 80),
    },
    HostConfig: {
      Binds: [`${volumeName(id)}:/home/agent`],
      NanoCpus: Math.round(cpuMillis * 1_000_000),
      Memory: Math.round(memoryMb * 1024 * 1024),
      ...(useNetwork ? { NetworkMode: NETWORK } : {}),
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
      EndpointsConfig: { [NETWORK]: {} },
    } : undefined,
  };
  const created = await dockerCall<{ Id: string }>(
    "POST", `/containers/create?name=${containerName(id)}`, payload);
  let limitsEnforced = true;
  if (created.status !== 201) {
    const msg = JSON.stringify(created.data);
    // Some kernels (notably sandboxed dev hosts without delegated cgroup
    // controllers) reject CPU/memory limits outright. That is an
    // environment capability, not a caller error: retry once WITHOUT
    // limits and report limitsEnforced=false so the control plane can
    // surface it — never silently.
    if (created.status === 400 && /NanoCPUs|CFS|memory.*cgroup|cgroup.*(cpu|memory)/i.test(msg)) {
      const bare = JSON.parse(JSON.stringify(payload)) as typeof payload;
      delete (bare.HostConfig as Record<string, unknown>).NanoCpus;
      delete (bare.HostConfig as Record<string, unknown>).Memory;
      const retry = await dockerCall<{ Id: string }>(
        "POST", `/containers/create?name=${containerName(id)}`, bare);
      if (retry.status !== 201) {
        throw Object.assign(
          new Error(`container create failed after limits fallback: ${retry.status} ${JSON.stringify(retry.data).slice(0, 300)}`),
          { code: 502 });
      }
      limitsEnforced = false;
    } else {
      throw Object.assign(
        new Error(`container create failed: ${created.status} ${msg.slice(0, 300)}`),
        { code: 502 });
    }
  }
  return {
    computerId: id,
    container: containerName(id),
    volume: volumeName(id),
    guestToken,
    limitsEnforced,
    // Dev-VM guest channel: the supervisor's unix socket in the home volume.
    socketPath: `${mountpoint}/.supervisor/api.sock`,
  };
}

async function stats(id: string) {
  await inspectManaged(id);
  const { status, data } = await dockerCall<Record<string, unknown>>(
    "GET", `/containers/${containerName(id)}/stats?stream=false`, undefined, 30000);
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

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  "/create": (b) => createComputer(b),
  "/start": async (b) => {
    const id = String(b.computerId ?? "");
    await inspectManaged(id);
    const r = await dockerCall("POST", `/containers/${containerName(id)}/start`);
    if (r.status !== 204 && r.status !== 304) throw Object.assign(new Error(`start failed: ${r.status}`), { code: 502 });
    return { ok: true };
  },
  "/stop": async (b) => {
    const id = String(b.computerId ?? "");
    await inspectManaged(id);
    const grace = Math.min(60, Math.max(1, Number(b.graceS ?? 20)));
    const r = await dockerCall("POST", `/containers/${containerName(id)}/stop?t=${grace}`, undefined, (grace + 30) * 1000);
    if (r.status !== 204 && r.status !== 304) throw Object.assign(new Error(`stop failed: ${r.status}`), { code: 502 });
    return { ok: true };
  },
  "/remove": async (b) => {
    const id = String(b.computerId ?? "");
    await inspectManaged(id);
    const r = await dockerCall("DELETE", `/containers/${containerName(id)}?force=true`);
    if (r.status !== 204 && r.status !== 404) throw Object.assign(new Error(`remove failed: ${r.status}`), { code: 502 });
    if (b.removeVolume === true) {
      const v = await dockerCall("DELETE", `/volumes/${volumeName(id)}?force=true`);
      if (v.status !== 204 && v.status !== 404) throw Object.assign(new Error(`volume remove failed: ${v.status}`), { code: 502 });
    }
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
  const handler = routes[(req.url ?? "").split("?")[0]];
  if (req.method !== "POST" || !handler) return send(404, { error: "no such route" });
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", async () => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {
      return send(400, { error: "invalid JSON" });
    }
    try {
      send(200, await handler(body));
    } catch (e) {
      const err = e as Error & { code?: number };
      send(err.code ?? 500, { error: err.message });
    }
  });
});

try { fs.unlinkSync(SOCK); } catch { /* fresh path */ }
fs.mkdirSync(SOCK.split("/").slice(0, -1).join("/"), { recursive: true });
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
