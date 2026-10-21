import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

// Real supervisor process and protocol, fake Docker. Does not claim cgroup or Docker E2E evidence.
test("supervisor rejects spoofed ownership and serializes concurrent admission", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-security-"));
  const socket = (name) => process.platform === "win32" ? String.raw`\\.\pipe\acp-${process.pid}-${name}` : path.join(dir, `${name}.sock`);
  const dockerSocket = socket("docker"), supervisorSocket = socket("supervisor");
  const identities = Object.fromEntries(["box-one", "box-two"].map(id => [id, { containerId: `trusted-${id}`, volume: `acp-${id}-home`, mountpoint: `/volumes/${id}` }]));
  fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(identities));
  fs.writeFileSync(path.join(dir, "meminfo"), "MemAvailable:    3670016 kB\n".replace("\\n", "\n"));
  const running = new Set();
  const operations = [];
  let spoof = false;
  let controls = true;
  const docker = http.createServer(async (req, res) => {
    operations.push([req.method, req.url]);
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/info") return send(200, { MemTotal: 4096 * 1048576, NCPU: 4, MemoryLimit: controls, CpuCfsQuota: controls });
    const inspect = /^\/containers\/acp-(box-one|box-two)\/json$/.exec(req.url);
    if (inspect) {
      const id = inspect[1];
      return send(200, { Id: spoof ? "foreign-container" : `trusted-${id}`, Name: `/acp-${id}`,
        Config: { Labels: { "acp.managed": "true", "acp.computer": id }, Image: "test" },
        State: { Running: running.has(id), Status: "created" }, Mounts: [{ Name: `acp-${id}-home`, Destination: "/home/agent" }],
        HostConfig: { Privileged: false, Memory: 2048 * 1048576, NanoCpus: 1000000000 } });
    }
    const start = /^\/containers\/trusted-(box-one|box-two)\/start$/.exec(req.url);
    if (start) { await new Promise(r => setTimeout(r, 50)); running.add(start[1]); res.writeHead(204); return res.end(); }
    return send(404, { error: "not found" });
  });
  await new Promise(r => docker.listen(dockerSocket, r));
  const child = spawn(process.execPath, ["supervisor/src/server.ts"], { env: { ...process.env,
    ACP_SUPERVISOR_SOCK: supervisorSocket, ACP_DOCKER_SOCK: dockerSocket, ACP_SUPERVISOR_SECRET: "test-only-secret",
    ACP_REGISTRY_FILE: path.join(dir, "registry.json"), ACP_HOST_MEMINFO: path.join(dir, "meminfo"),
    ACP_STORAGE_PROBE: dir, ACP_MIN_FREE_DISK_GB: "1", ACP_HOST_RESERVE_MB: "1024" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stderr.on("data", b => log += b);
  const call = (route, body, secret = "test-only-secret") => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: supervisorSocket, path: route, method: "POST", headers: { "x-supervisor-secret": secret } }, res => {
      let text = ""; res.on("data", b => text += b); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on("error", reject); req.end(JSON.stringify(body));
  });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await call("/ping", {})).status === 200) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(ready, log);
    assert.equal((await call("/ping", {}, "wrong")).status, 401);
    assert.equal((await call("/inspect", { computerId: "foreign-box" })).status, 403);
    assert.equal((await call("/inspect", { computerId: "../foreign" })).status, 400);
    assert.equal((await call("/start", { computerId: "box-one", privileged: true })).status, 400);
    assert.equal((await call("/start", [])).status, 400);
    spoof = true;
    assert.equal((await call("/start", { computerId: "box-one" })).status, 403);
    spoof = false;
    assert.equal((await call("/remove", { computerId: "box-one", removeVolume: true })).status, 403);
    assert.equal(operations.some(([method]) => method === "DELETE"), false);
    controls = false;
    assert.equal((await call("/start", { computerId: "box-one" })).status, 503);
    controls = true;
    const starts = await Promise.all([call("/start", { computerId: "box-one" }), call("/start", { computerId: "box-two" })]);
    assert.deepEqual(starts.map(r => r.status).sort(), [200, 409]);
    assert.equal(running.size, 1);
    assert.equal(operations.filter(([method, url]) => method === "POST" && url.endsWith("/start")).length, 1);
  } finally {
    child.kill(); await once(child, "exit");
    await new Promise(r => docker.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
