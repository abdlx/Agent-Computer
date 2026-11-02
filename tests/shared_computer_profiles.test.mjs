import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("shared computer mode, profile CRUD, and profile-scoped MCP tokens", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-shared-profiles-"));
  const supSocket = process.platform === "win32"
    ? String.raw`\\.\pipe\acp-profiles-${process.pid}`
    : path.join(dir, "supervisor.sock");
  const guestSocket = path.join(dir, "guest.sock");

  // Mock guest server that answers /health
  const guestServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, state: "ready", display: ":0" }));
  });
  await new Promise((r) => guestServer.listen(guestSocket, r));

  // Mock Docker supervisor
  const supervisor = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = req.url;
      if (p === "/create") {
        const parsed = JSON.parse(body || "{}");
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          container: `acp-${parsed.computerId}`,
          volume: `acp-${parsed.computerId}-home`,
          socketPath: guestSocket,
          guestToken: "mock-guest-token",
          limitsEnforced: true,
        }));
      }
      if (p === "/start") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, storageQuotaSupported: false }));
    });
  });
  await new Promise((r) => supervisor.listen(supSocket, r));

  const reservation = http.createServer();
  await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));

  const child = spawn(process.execPath, ["apps/control-plane/src/server.ts"], {
    env: {
      ...process.env,
      ACP_PORT: String(port),
      ACP_DB: path.join(dir, "test.db"),
      ACP_SUPERVISOR_SOCK: supSocket,
      ACP_SUPERVISOR_SECRET: "local-test-only",
      ACP_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      ACP_TRUST_PROXY: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stderr.on("data", (b) => (log += b));
  const base = `http://127.0.0.1:${port}`;
  const request = (route, method = "GET", body, headers = {}) =>
    fetch(base + route, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await request("/api/health")).status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(ready, log);

    // 1. Setup owner account
    const setupRes = await request("/api/setup", "POST", {
      username: "abdullah",
      password: "secure-dev-password-123",
    });
    assert.equal(setupRes.status, 200);
    const cookie = setupRes.headers.get("set-cookie").split(";")[0];
    const auth = { cookie, "x-acp-request": "1" };

    // 2. Settings API: read and update platform settings
    const getSettingsRes = await request("/api/settings", "GET", undefined, auth);
    assert.equal(getSettingsRes.status, 200);
    const setSettingsRes = await request("/api/settings", "POST", {
      idleTimeoutS: "600",
      defaultEngine: "camoufox",
    }, auth);
    assert.equal(setSettingsRes.status, 200);
    const settingsData = await setSettingsRes.json();
    assert.equal(settingsData.settings.idleTimeoutS, "600");

    // 3. Create a Shared Computer
    const createCompRes = await request("/api/computers", "POST", {
      name: "HOB-Cluster",
      cpuMillis: 2000,
      memoryMb: 4096,
      diskGb: 40,
      isShared: true,
    }, auth);
    if (createCompRes.status !== 201) {
      console.error("Create computer failed:", await createCompRes.json());
    }
    assert.equal(createCompRes.status, 201);
    const compData = await createCompRes.json();
    const comp = compData.computer;
    assert.equal(comp.isShared, true);
    assert.equal(comp.profileCount, 1);
    assert.equal(comp.profiles[0].slug, "default");

    // 4. Create multiple profiles under the shared computer (dex, kai, milo)
    const addDex = await request(`/api/computers/${comp.id}/profiles`, "POST", {
      name: "Dex",
      slug: "dex",
      description: "Builds websites, apps, APIs and maintains infra",
      color: "#3b82f6",
    }, auth);
    assert.equal(addDex.status, 201);
    const dexProf = (await addDex.json()).profile;
    assert.equal(dexProf.slug, "dex");

    const addKai = await request(`/api/computers/${comp.id}/profiles`, "POST", {
      name: "Kai",
      slug: "kai",
      description: "Social media and content publishing agent",
      color: "#10b981",
    }, auth);
    assert.equal(addKai.status, 201);
    const kaiProf = (await addKai.json()).profile;
    assert.equal(kaiProf.slug, "kai");

    const addMilo = await request(`/api/computers/${comp.id}/profiles`, "POST", {
      name: "Milo",
      slug: "milo",
      description: "Visual branding and graphic design agent",
      color: "#8b5cf6",
    }, auth);
    assert.equal(addMilo.status, 201);
    const miloProf = (await addMilo.json()).profile;
    assert.equal(miloProf.slug, "milo");

    // Duplicate slug should fail with 409
    const dupRes = await request(`/api/computers/${comp.id}/profiles`, "POST", {
      name: "Dex Copy",
      slug: "dex",
    }, auth);
    assert.equal(dupRes.status, 409);

    // List profiles
    const listProfRes = await request(`/api/computers/${comp.id}/profiles`, "GET", undefined, auth);
    assert.equal(listProfRes.status, 200);
    const profs = (await listProfRes.json()).profiles;
    assert.equal(profs.length, 4); // default, dex, kai, milo

    // Update profile
    const patchKai = await request(`/api/computers/${comp.id}/profiles/${kaiProf.id}`, "PATCH", {
      description: "Updated social media lead",
    }, auth);
    assert.equal(patchKai.status, 200);
    assert.equal((await patchKai.json()).profile.description, "Updated social media lead");

    // 5. Generate MCP access tokens bound to specific profiles
    const mintedDex = await request("/api/tokens", "POST", {
      name: "Dex Agent",
      scopes: ["read", "write", "browser", "files"],
      computerId: comp.id,
      profileId: dexProf.id,
    }, auth);
    assert.equal(mintedDex.status, 201);
    const dexToken = await mintedDex.json();
    assert.equal(dexToken.profileId, dexProf.id);

    const mintedKai = await request("/api/tokens", "POST", {
      name: "Kai Agent",
      scopes: ["read", "browser"],
      computerId: comp.id,
      profileId: kaiProf.id,
    }, auth);
    assert.equal(mintedKai.status, 201);
    const kaiToken = await mintedKai.json();

    // Verify token listing includes profile information
    const tokensRes = await request("/api/tokens", "GET", undefined, auth);
    assert.equal(tokensRes.status, 200);
    const allTokens = (await tokensRes.json()).tokens;
    const foundDexToken = allTokens.find((t) => t.id === dexToken.id);
    assert.ok(foundDexToken);
    assert.equal(foundDexToken.profile_name, "Dex");
    assert.equal(foundDexToken.profile_slug, "dex");

    // 6. Test MCP Tools: profile_current and profile_list
    const dexMcpHeaders = { authorization: `Bearer ${dexToken.token}` };
    const kaiMcpHeaders = { authorization: `Bearer ${kaiToken.token}` };

    const dexCurrentRes = await request("/mcp", "POST", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "profile_current", arguments: {} },
    }, dexMcpHeaders);
    assert.equal(dexCurrentRes.status, 200);
    const dexCurrentData = JSON.parse((await dexCurrentRes.json()).result.content[0].text);
    assert.equal(dexCurrentData.profileSlug, "dex");
    assert.equal(dexCurrentData.agentName, "Dex Agent");

    const kaiCurrentRes = await request("/mcp", "POST", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "profile_current", arguments: {} },
    }, kaiMcpHeaders);
    assert.equal(kaiCurrentRes.status, 200);
    const kaiCurrentData = JSON.parse((await kaiCurrentRes.json()).result.content[0].text);
    assert.equal(kaiCurrentData.profileSlug, "kai");

    const profListRes = await request("/mcp", "POST", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "profile_list", arguments: { computer: comp.id } },
    }, dexMcpHeaders);
    assert.equal(profListRes.status, 200);
    const profListData = JSON.parse((await profListRes.json()).result.content[0].text);
    assert.equal(profListData.isShared, true);
    assert.equal(profListData.currentProfile, "dex");
    assert.ok(profListData.profiles.length >= 4);

    // 7. Delete profile
    const delMilo = await request(`/api/computers/${comp.id}/profiles/${miloProf.id}`, "DELETE", {}, auth);
    assert.equal(delMilo.status, 200);
    const afterDelete = await request(`/api/computers/${comp.id}/profiles`, "GET", undefined, auth);
    assert.equal((await afterDelete.json()).profiles.length, 3);
  } finally {
    child.kill();
    await once(child, "exit");
    await new Promise((r) => supervisor.close(r));
    await new Promise((r) => guestServer.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});