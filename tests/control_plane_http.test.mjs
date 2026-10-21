import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("real control-plane HTTP onboarding, sessions, origins and token revocation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-http-"));
  const supSocket = process.platform === "win32" ? String.raw`\\.\pipe\acp-http-${process.pid}` : path.join(dir, "supervisor.sock");
  const supervisor = http.createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, storageQuotaSupported: false })); });
  await new Promise(r => supervisor.listen(supSocket, r));
  const reservation = http.createServer();
  await new Promise(r => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise(r => reservation.close(r));
  const child = spawn(process.execPath, ["apps/control-plane/src/server.ts"], { env: { ...process.env,
    ACP_PORT: String(port), ACP_DB: path.join(dir, "test.db"), ACP_SUPERVISOR_SOCK: supSocket,
    ACP_SUPERVISOR_SECRET: "local-test-only", ACP_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    ACP_TRUST_PROXY: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stderr.on("data", b => log += b);
  const base = `http://127.0.0.1:${port}`;
  const request = (route, method = "GET", body, headers = {}) => fetch(base + route, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await request("/api/health")).status === 200) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(ready, log);
    assert.equal((await request("/api/computers")).status, 401);
    assert.equal((await request("/api/setup", "POST", [])).status, 400);
    assert.equal((await request("/api/setup", "POST", { username: "owner", password: "local-test-password" }, { origin: "https://foreign.invalid" })).status, 403);
    const attempts = await Promise.all([0, 1, 2].map(i => request("/api/setup", "POST", { username: `owner${i}`, password: "local-test-password" })));
    assert.deepEqual(attempts.map(r => r.status).sort(), [200, 409, 409]);
    const success = attempts.find(r => r.status === 200);
    const cookie = success.headers.get("set-cookie").split(";")[0];
    const auth = { cookie, "x-acp-request": "1" };
    assert.equal((await request("/api/resources", "GET", undefined, auth)).status, 200);
    assert.equal((await request("/api/ready", "GET", undefined, auth)).status, 200);
    assert.equal((await request("/api/tokens", "POST", { name: "missing-csrf" }, { cookie })).status, 403);
    const minted = await request("/api/tokens", "POST", { name: "agent", scopes: ["read"] }, auth);
    assert.equal(minted.status, 201);
    const token = await minted.json();
    const agent = { authorization: `Bearer ${token.token}` };
    assert.equal((await request("/mcp", "POST", null, agent)).status, 400);
    assert.equal((await request("/mcp", "POST", [], agent)).status, 400);
    assert.equal((await request("/mcp", "POST", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "computer_list", arguments: { hostMount: "/" } } }, agent)).status, 200);
    const invalidTool = await request("/mcp", "POST", { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "computer_list", arguments: { hostMount: "/" } } }, agent);
    assert.equal((await invalidTool.json()).result.isError, true);
    assert.equal((await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, agent)).status, 200);
    assert.equal((await request(`/api/tokens/${token.id}`, "DELETE", {}, auth)).status, 200);
    assert.equal((await request("/mcp", "POST", { jsonrpc: "2.0", id: 2, method: "tools/list" }, agent)).status, 401);
    assert.equal((await request("/api/auth/logout", "POST", {}, auth)).status, 200);
    assert.equal((await request("/api/auth/me", "GET", undefined, { cookie })).status, 401);
  } finally {
    child.kill(); await once(child, "exit");
    await new Promise(r => supervisor.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
