/**
 * Phase 4 engine race tests — no Docker: a scripted fake driver + a fake
 * guest supervisor on a unix socket exercise the lifecycle engine's
 * concurrency guarantees directly.
 *
 *   node tests/engine_races.mjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import { LifecycleEngine } from "../apps/control-plane/src/lifecycle.ts";

const SOCK = "/tmp/acp-race-guest.sock";
try { fs.unlinkSync(SOCK); } catch { /* fresh */ }

// ---- fake guest: /health reports ancient activity; /browser/close ok ----
const guest = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url === "/health") {
    res.end(JSON.stringify({ ok: true, activity: { last_any: 0, last_input: 0, last_browser: 0 } }));
  } else {
    res.end(JSON.stringify({ ok: true }));
  }
});
await new Promise((r) => guest.listen(SOCK, r));

// ---- fake docker driver with a slow stop --------------------------------
class FakeDriver {
  constructor() { this.running = new Map(); this.starts = 0; this.stops = 0; }
  async isRunning(name) { return this.running.get(name) ?? false; }
  async start(name) { this.starts++; this.running.set(name, true); }
  async stop(name) {
    this.stops++;
    await new Promise((r) => setTimeout(r, 900)); // slow graceful stop
    this.running.set(name, false);
  }
  async remove(name) { this.running.delete(name); }
}

// ---- in-memory store ------------------------------------------------------
const store = {
  state: { computers: {}, leases: {}, operations: {} },
  load() { return this.state; },
  save(s) { this.state = s; },
};

const driver = new FakeDriver();
const engine = new LifecycleEngine(store, { idleTimeoutS: 60, wakeTimeoutS: 10, driver });
engine.register({
  id: "race-box", container: "acp-race-box", socketPath: SOCK,
  guestToken: "t", state: "ready",
});
driver.running.set("acp-race-box", true);

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) wake issued DURING an in-flight sleep must end with the computer
//    actually running and ready — never "ready" then slept underneath.
const sleepP = engine.sleep("race-box");
await sleep(150); // stop is now in flight (900ms)
const wakeP = engine.wake("race-box");
const [, woken] = await Promise.all([sleepP, wakeP]);
check("wake during sleep: final state ready", woken.state === "ready", woken.state);
check("wake during sleep: container actually running",
  (await driver.isRunning("acp-race-box")) === true);
check("wake during sleep: serialized (1 stop, then a real start)",
  driver.stops === 1 && driver.starts === 1, `stops=${driver.stops} starts=${driver.starts}`);

// 2) call() during a sleep: wakes after the stop and runs the function.
const sleepP2 = engine.sleep("race-box");
await sleep(150);
let fnRan = false;
const callP = engine.call("race-box", async () => { fnRan = true; return "done"; });
const [, callResult] = await Promise.all([sleepP2, callP]);
check("call during sleep: function ran after wake", fnRan && callResult === "done");
check("call during sleep: computer ready", engine.get("race-box").state === "ready");

// 3) concurrent sleeps are single-flighted (one stop only).
const stopsBefore = driver.stops;
await Promise.all([engine.sleep("race-box"), engine.sleep("race-box"), engine.sleep("race-box")]);
check("concurrent sleeps single-flight", driver.stops === stopsBefore + 1,
  `stops delta=${driver.stops - stopsBefore}`);
check("after sleeps: state sleeping", engine.get("race-box").state === "sleeping");

// 4) wake on a deleting computer is refused.
engine.get("race-box").state = "deleting";
let refused = false;
try { await engine.wake("race-box"); } catch (e) { refused = /being deleted/.test(e.message); }
check("wake refused while deleting", refused);
engine.get("race-box").state = "sleeping";

// 5) lease blocks tick; after expiry the idle computer sleeps.
await engine.wake("race-box");
const lease = engine.acquireLease("race-box", "test", 1); // 1s TTL
let r = await engine.tick("race-box");
check("tick blocked by live lease", r.action === "blocked", r.detail);
await sleep(1300);
r = await engine.tick("race-box");
check("tick sleeps once the lease has lapsed", r.action === "slept", r.detail);
check("lease pruned after expiry", engine.liveLeases("race-box").length === 0);

// 6) an in-flight operation blocks tick.
await engine.wake("race-box");
const op = engine.beginOperation("race-box", "long-task");
r = await engine.tick("race-box");
check("tick blocked by active operation", r.action === "blocked", r.detail);
engine.endOperation(op.id);
r = await engine.tick("race-box");
check("tick sleeps after the operation ends", r.action === "slept", r.detail);

guest.close();
console.log(failures === 0 ? "\nENGINE RACES: all passed" : `\nENGINE RACES: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
