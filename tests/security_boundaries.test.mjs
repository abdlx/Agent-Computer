import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db } from "../apps/control-plane/src/db.ts";
import { originAllowed } from "../apps/control-plane/src/security.ts";
import { LifecycleEngine } from "../apps/control-plane/src/lifecycle.ts";
import { TOOLS } from "../apps/control-plane/src/mcp.ts";

test("foreign and opaque browser origins rejected", () => {
  assert.equal(originAllowed("https://evil.example", "computer.example", true), false);
  assert.equal(originAllowed("null", "computer.example", true), false);
  assert.equal(originAllowed("https://computer.example", "computer.example", true), true);
  assert.equal(originAllowed(undefined, "computer.example", true), true);
  assert.equal(originAllowed("https://computer.example", "internal:8787", false, "https://computer.example"), true);
});
test("first-run owner constraint applies across connections", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-db-"));
  try {
    const db1 = new Db(path.join(dir, "test.db"));
    const db2 = new Db(path.join(dir, "test.db"));
    db1.createUser("owner", "test-only-hash");
    assert.throws(() => db2.createUser("attacker", "test-only-hash"), /setup already completed/);
    assert.equal(db2.userCount(), 1);
  } finally {
    // SQLite connections stay open until process exit; on Windows avoid deleting live DB handles.
    if (process.platform !== "win32") fs.rmSync(dir, { recursive: true, force: true });
  }
});
const makeEngine = (operations = {}) => {
  const state = { computers: { box: { id: "box", container: "acp-box", socketPath: "unused", state: "ready" } }, leases: {}, operations };
  return new LifecycleEngine({ load: () => state, save: () => {} }, { driver: { isRunning: async () => true, start: async () => {}, stop: async () => { throw new Error("must not stop active work"); } } });
};
test("sleep and delete refuse active operations", async () => {
  const engine = makeEngine();
  const op = engine.beginOperation("box", "test", "active");
  await assert.rejects(engine.sleep("box"), /active operations/);
  let removed = false;
  await assert.rejects(engine.delete("box", async () => { removed = true; }), /active operations/);
  assert.equal(removed, false);
  engine.endOperation(op.id);
  await engine.delete("box", async () => { removed = true; });
  assert.equal(removed, true);
  assert.throws(() => engine.get("box"), /unknown computer/);
});
test("restart clears dead-process operation records", () => {
  const engine = makeEngine({ stale: { id: "stale", computerId: "box", startedAt: 1 } });
  assert.deepEqual(engine.activeOperations("box"), []);
});
test("computer-bound admin token cannot create another computer", async () => {
  let called = false;
  const tool = TOOLS.find(t => t.name === "computer_create");
  await assert.rejects(tool.run({ token: { computerId: "box", scopes: ["admin"] }, sup: { create: async () => { called = true; } } }, { name: "escape" }), /bound tokens/);
  assert.equal(called, false);
});

test("manual stop rejects automatic wake and idle evaluation preserves it", async () => {
  const engine = makeEngine();
  engine.get("box").state = "stopped";
  await assert.rejects(engine.wake("box"), /manually stopped/);
  await assert.rejects(engine.call("box", async () => "must not run"), /manually stopped/);
  assert.deepEqual(engine.activeOperations("box"), []);
  assert.equal((await engine.tick("box")).detail, "manually stopped");
});
