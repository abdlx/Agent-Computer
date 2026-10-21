/**
 * Lifecycle engine CLI — the Phase 0 harness around lifecycle.ts.
 *
 *   node cli.ts register <id> <container> <socketPath>
 *   node cli.ts status <id>
 *   node cli.ts tick <id>                      (one idle evaluation)
 *   node cli.ts sleep <id>
 *   node cli.ts wake <id>
 *   node cli.ts wake-parallel <id> <n>         (single-flight proof)
 *   node cli.ts lease <id> <owner> [ttlS]      -> prints lease id
 *   node cli.ts release-lease <leaseId>
 *   node cli.ts begin-op <id> <kind> <label>   -> prints op id
 *   node cli.ts end-op <opId>
 *   node cli.ts call-health <id>               (wake-on-call, then /health)
 *
 * Engine options come from env: ACP_IDLE_TIMEOUT_S, ACP_STATE_FILE.
 */
import { JsonFileStore, LifecycleEngine, guestCall } from "./lifecycle.ts";

const stateFile = process.env.ACP_STATE_FILE ?? "/tmp/acp-lifecycle-state.json";
const engine = new LifecycleEngine(new JsonFileStore(stateFile), {
  idleTimeoutS: Number(process.env.ACP_IDLE_TIMEOUT_S ?? 300),
});

const [cmd, ...args] = process.argv.slice(2);
const out = (v: unknown) => console.log(JSON.stringify(v));

try {
  switch (cmd) {
    case "register":
      out(engine.register({ id: args[0], container: args[1], socketPath: args[2], state: "ready" }));
      break;
    case "status":
      out(engine.get(args[0]));
      break;
    case "tick":
      out(await engine.tick(args[0]));
      break;
    case "sleep":
      out(await engine.sleep(args[0], "cli"));
      break;
    case "wake":
      out(await engine.wake(args[0]));
      break;
    case "wake-parallel": {
      const n = Number(args[1] ?? 5);
      const t0 = Date.now();
      const results = await Promise.all(
        Array.from({ length: n }, () => engine.wake(args[0])));
      out({ callers: n, states: results.map((r) => r.state),
            elapsedMs: Date.now() - t0 });
      break;
    }
    case "lease":
      out(engine.acquireLease(args[0], args[1], args[2] ? Number(args[2]) : undefined));
      break;
    case "release-lease":
      engine.releaseLease(args[0]); out({ released: args[0] });
      break;
    case "begin-op":
      out(engine.beginOperation(args[0], args[1], args[2] ?? ""));
      break;
    case "end-op":
      engine.endOperation(args[0]); out({ ended: args[0] });
      break;
    case "call-health": {
      const health = await engine.call(args[0], (c) =>
        guestCall(c.socketPath, "GET", "/health", undefined, 8000));
      out(health);
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exit(2);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
