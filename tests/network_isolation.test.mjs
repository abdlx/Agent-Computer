import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuestNetwork } from "../supervisor/src/network.ts";
test("isolated per-guest bridge is connected only to trusted proxy", async () => {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.startsWith("/networks/")) return { status: 404 };
    if (path.startsWith("/containers/")) return { status: 200, data: { Id: "trusted-proxy-id", State: { Running: true }, Config: { Labels: { "com.docker.compose.project": "agentcomputer", "com.docker.compose.service": "egress" } } } };
    return { status: path === "/networks/create" ? 201 : 200, data: { Id: "exact-network-id" } };
  };
  const result = await createGuestNetwork("test-box", api, "agentcomputer-egress-1");
  assert.equal(result.id, "exact-network-id");
  const creation = calls.find(c => c.path === "/networks/create");
  assert.equal(creation.body.Internal, true);
  assert.equal(creation.body.Options["com.docker.network.bridge.gateway_mode_ipv4"], "isolated");
  assert.equal(calls.at(-1).body.Container, "trusted-proxy-id");
});
test("foreign proxy and existing network fail closed", async () => {
  await assert.rejects(createGuestNetwork("test-box", async () => ({ status: 200 }), "proxy"), /network name unavailable/);
  await assert.rejects(createGuestNetwork("test-box", async (method, path) => path.startsWith("/networks/") ? { status: 404 } : { status: 200, data: { State: { Running: true }, Config: { Labels: {} } } }, "proxy"), /trusted egress/);
});
