/**
 * Lifecycle engine for Agent Computers.
 *
 * Owns the sleep/wake policy for every computer:
 *  - Activity leases: short-lived (default 90 s TTL), auto-expiring claims
 *    held by agent sessions / human viewers. A live lease blocks sleep.
 *  - Operation registry: long-running work (downloads, batches, terminal
 *    sessions) registers an operation; an active operation blocks sleep.
 *  - Idle evaluation: when a computer is `ready`, has no live lease, no
 *    active operation, and its guest-reported last activity is older than
 *    the idle timeout, the engine sleeps it.
 *  - Sleep is a GRACEFUL container stop (never pause, never CRIU): the
 *    guest browser is closed first so profile state flushes, then the
 *    container is stopped. The home volume persists everything.
 *  - Wake is single-flight per computer: concurrent wake requests share
 *    one start + health-wait, and wake-on-call wraps any guest operation.
 *
 * State is kept behind a tiny store interface; the Phase 0 harness uses a
 * JSON file, the control plane uses SQLite (Phase 1).
 *
 * Guest clock note: containers share the host clock on Linux, so the
 * guest supervisor's activity timestamps are directly comparable to the
 * engine's clock.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as http from "node:http";

const run = promisify(execFile);

export type ComputerState =
  | "creating" | "starting" | "ready" | "idle" | "stopping"
  | "sleeping" | "waking" | "failed" | "unhealthy" | "deleting" | "deleted";

export interface Computer {
  id: string;
  container: string;      // docker container name
  socketPath: string;     // guest supervisor unix socket (dev/VM channel)
  guestToken?: string;    // X-Guest-Token for the guest supervisor
  state: ComputerState;
}

export interface Lease {
  id: string;
  computerId: string;
  owner: string;          // e.g. "agent:<token-id>" or "human:<user>"
  acquiredAt: number;     // epoch seconds
  expiresAt: number;      // epoch seconds
}

export interface Operation {
  id: string;
  computerId: string;
  kind: string;           // e.g. "download", "batch", "terminal"
  label: string;
  startedAt: number;
}

export interface EngineState {
  computers: Record<string, Computer>;
  leases: Record<string, Lease>;
  operations: Record<string, Operation>;
}

export interface Store {
  load(): EngineState;
  save(state: EngineState): void;
}

export class JsonFileStore implements Store {
  private path: string;
  constructor(path: string) { this.path = path; }
  load(): EngineState {
    try {
      return JSON.parse(fs.readFileSync(this.path, "utf8")) as EngineState;
    } catch {
      return { computers: {}, leases: {}, operations: {} };
    }
  }
  save(state: EngineState): void {
    fs.writeFileSync(this.path, JSON.stringify(state, null, 2));
  }
}

/** Minimal HTTP-over-unix-socket client for the guest supervisor. */
export function guestCall<T = unknown>(
  socketPath: string, method: string, path: string,
  body?: unknown, timeoutMs = 30000, token?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["x-guest-token"] = token;
    // Content-Length is set explicitly: without it Node sends chunked
    // transfer encoding, which the guest's Python http.server cannot
    // read — POSTs then fail with a malformed-response parse error.
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    if (payload !== undefined) headers["content-length"] = String(Buffer.byteLength(payload));
    const req = http.request(
      { socketPath, method, path, timeout: timeoutMs, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* keep text */ }
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`guest ${method} ${path} -> ${res.statusCode}: ${text.slice(0, 300)}`));
          } else {
            resolve(parsed as T);
          }
        });
      });
    req.on("timeout", () => req.destroy(new Error("guest call timed out")));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

interface GuestHealth {
  ok: boolean;
  activity: { last_any: number; last_agent: number; last_human: number };
  browser_engine: string;
}

const now = () => Date.now() / 1000;
let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/**
 * How the engine operates containers. The Phase 0 harness uses the CLI
 * driver; the control plane injects a driver that routes everything
 * through the restricted Docker supervisor service.
 */
export interface DockerDriver {
  isRunning(container: string): Promise<boolean>;
  start(container: string): Promise<void>;
  stop(container: string, graceS: number): Promise<void>;
}

export class CliDockerDriver implements DockerDriver {
  async isRunning(container: string): Promise<boolean> {
    try {
      const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Running}}", container]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }
  async start(container: string): Promise<void> {
    await run("docker", ["start", container], { timeout: 120000 });
  }
  async stop(container: string, graceS: number): Promise<void> {
    await run("docker", ["stop", "-t", String(graceS), container], { timeout: 120000 });
  }
}

export interface EngineOptions {
  idleTimeoutS?: number;    // product default 300
  leaseTtlS?: number;       // product default 90
  stopGraceS?: number;      // docker stop grace, default 20
  wakeTimeoutS?: number;    // health-wait budget, default 90
  driver?: DockerDriver;    // default: CLI driver
}

export class LifecycleEngine {
  private store: Store;
  private driver: DockerDriver;
  private state: EngineState;
  private wakeFlights = new Map<string, Promise<Computer>>();
  private sleepFlights = new Map<string, Promise<Computer>>();
  // Per-computer chain serializing lifecycle transitions: a wake issued
  // while a sleep is stopping the container must run AFTER the stop
  // completes (and then really start it), never race it — otherwise the
  // wake reports "ready" and the in-flight stop then puts the computer
  // to sleep underneath the caller.
  private transitions = new Map<string, Promise<void>>();
  private opts: Required<Omit<EngineOptions, "driver">>;

  constructor(store: Store, opts: EngineOptions = {}) {
    this.store = store;
    this.driver = opts.driver ?? new CliDockerDriver();
    this.state = store.load();
    // Operations belong to the previous process; none can still execute after restart.
    this.state.operations = {};
    this.persist();
    this.opts = {
      idleTimeoutS: opts.idleTimeoutS ?? 300,
      leaseTtlS: opts.leaseTtlS ?? 90,
      stopGraceS: opts.stopGraceS ?? 20,
      wakeTimeoutS: opts.wakeTimeoutS ?? 90,
    };
  }

  private persist(): void { this.store.save(this.state); }

  register(computer: Computer): Computer {
    this.state.computers[computer.id] = computer;
    this.persist();
    return computer;
  }

  unregister(id: string): void {
    delete this.state.computers[id];
    for (const [lid, l] of Object.entries(this.state.leases)) {
      if (l.computerId === id) delete this.state.leases[lid];
    }
    for (const [oid, o] of Object.entries(this.state.operations)) {
      if (o.computerId === id) delete this.state.operations[oid];
    }
    this.persist();
  }

  get(id: string): Computer {
    const c = this.state.computers[id];
    if (!c) throw new Error(`unknown computer ${id}`);
    return c;
  }

  // ---- leases -------------------------------------------------------------
  acquireLease(computerId: string, owner: string, ttlS?: number): Lease {
    const lease: Lease = {
      id: nextId("lease"), computerId, owner,
      acquiredAt: now(), expiresAt: now() + (ttlS ?? this.opts.leaseTtlS),
    };
    this.state.leases[lease.id] = lease;
    this.persist();
    return lease;
  }

  releaseLease(leaseId: string): void {
    delete this.state.leases[leaseId];
    this.persist();
  }

  liveLeases(computerId: string): Lease[] {
    const t = now();
    return Object.values(this.state.leases)
      .filter((l) => l.computerId === computerId && l.expiresAt > t);
  }

  // ---- operations -----------------------------------------------------------
  beginOperation(computerId: string, kind: string, label: string): Operation {
    const op: Operation = {
      id: nextId("op"), computerId, kind, label, startedAt: now(),
    };
    this.state.operations[op.id] = op;
    this.persist();
    return op;
  }

  endOperation(opId: string): void {
    delete this.state.operations[opId];
    this.persist();
  }

  activeOperations(computerId: string): Operation[] {
    return Object.values(this.state.operations)
      .filter((o) => o.computerId === computerId);
  }

  // ---- guest/docker primitives ---------------------------------------------
  async health(computer: Computer): Promise<GuestHealth> {
    return guestCall<GuestHealth>(computer.socketPath, "GET", "/health", undefined, 8000, computer.guestToken);
  }

  async containerRunning(container: string): Promise<boolean> {
    return this.driver.isRunning(container);
  }

  // ---- lifecycle -------------------------------------------------------------
  /** Evaluate one computer once: sleep it if it is idle and unblocked. */
  async tick(computerId: string): Promise<{ action: string; detail?: string }> {
    const c = this.get(computerId);
    // prune expired leases opportunistically
    const t = now();
    let pruned = false;
    for (const [lid, l] of Object.entries(this.state.leases)) {
      if (l.expiresAt <= t) { delete this.state.leases[lid]; pruned = true; }
    }
    if (pruned) this.persist();

    if (c.state === "sleeping") return { action: "none", detail: "already sleeping" };
    if (!(await this.containerRunning(c.container))) {
      c.state = "sleeping"; this.persist();
      return { action: "none", detail: "container not running; state synced to sleeping" };
    }
    if (c.state !== "ready" && c.state !== "idle") {
      return { action: "none", detail: `state=${c.state}` };
    }
    const leases = this.liveLeases(computerId);
    if (leases.length > 0) {
      return { action: "blocked", detail: `${leases.length} live lease(s)` };
    }
    const ops = this.activeOperations(computerId);
    if (ops.length > 0) {
      return { action: "blocked", detail: `${ops.length} active operation(s)` };
    }
    let health: GuestHealth;
    try {
      health = await this.health(c);
    } catch (e) {
      c.state = "unhealthy"; this.persist();
      return { action: "none", detail: `health check failed: ${(e as Error).message}` };
    }
    const idleFor = t - (health.activity.last_any || 0);
    if (idleFor < this.opts.idleTimeoutS) {
      c.state = idleFor > 0 ? "idle" : c.state;
      this.persist();
      return { action: "none", detail: `idle for ${idleFor.toFixed(1)}s of ${this.opts.idleTimeoutS}s` };
    }
    await this.sleep(computerId, `idle ${idleFor.toFixed(0)}s`);
    return { action: "slept", detail: `idle for ${idleFor.toFixed(1)}s` };
  }

  private enqueueTransition(computerId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.transitions.get(computerId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.transitions.set(computerId, settled);
    void settled.then(() => {
      if (this.transitions.get(computerId) === settled) this.transitions.delete(computerId);
    });
    return next;
  }

  /** Graceful stop: flush the browser profile, then docker stop. */
  async sleep(computerId: string, reason = "manual"): Promise<Computer> {
    const existing = this.sleepFlights.get(computerId);
    if (existing) return existing;
    const flight = (async () => {
      let result!: Computer;
      await this.enqueueTransition(computerId, async () => {
        result = await this.doSleep(computerId, reason);
      });
      return result;
    })().finally(() => this.sleepFlights.delete(computerId));
    this.sleepFlights.set(computerId, flight);
    return flight;
  }

  private async doSleep(computerId: string, reason = "manual"): Promise<Computer> {
    const c = this.get(computerId);
    if (c.state === "deleting" || c.state === "deleted") throw new Error("computer is being deleted");
    if (this.activeOperations(computerId).length) throw new Error("computer has active operations; retry after they finish");
    if (c.state === "sleeping") return c;
    c.state = "stopping"; this.persist();
    try {
      // Best effort: close the browser so cookies/session flush to the
      // profile before the container stops. The guest also does this on
      // SIGTERM; doing it explicitly orders it before the stop begins.
      await guestCall(c.socketPath, "POST", "/browser/close", {}, 15000, c.guestToken).catch(() => undefined);
      await this.driver.stop(c.container, this.opts.stopGraceS);
      c.state = "sleeping";
    } catch (e) {
      c.state = "failed";
      this.persist();
      throw e;
    }
    this.persist();
    return c;
  }

  /** Single-flight wake: concurrent callers share one start + health-wait. */
  wake(computerId: string): Promise<Computer> {
    const existing = this.wakeFlights.get(computerId);
    if (existing) return existing;
    const flight = (async () => {
      let result!: Computer;
      await this.enqueueTransition(computerId, async () => {
        result = await this.doWake(computerId);
      });
      return result;
    })().finally(() => {
      this.wakeFlights.delete(computerId);
    });
    this.wakeFlights.set(computerId, flight);
    return flight;
  }

  private async doWake(computerId: string): Promise<Computer> {
    const c = this.get(computerId);
    if (c.state === "deleting" || c.state === "deleted") {
      throw new Error("computer is being deleted");
    }
    if (await this.containerRunning(c.container)) {
      try {
        await this.health(c);
        c.state = "ready"; this.persist();
        return c;
      } catch { /* running but unhealthy: fall through to start path */ }
    }
    c.state = "waking"; this.persist();
    try {
      await this.driver.start(c.container);
      const deadline = now() + this.opts.wakeTimeoutS;
      for (;;) {
        try {
          await this.health(c);
          c.state = "ready"; this.persist();
          return c;
        } catch {
          if (now() > deadline) throw new Error(`wake timed out after ${this.opts.wakeTimeoutS}s`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    } catch (e) {
      c.state = "failed";
      this.persist();
      throw e;
    }
  }

  /** Wake-on-call: ensure the computer is ready, then run the guest call. */
  async call<T>(computerId: string, fn: (c: Computer) => Promise<T>): Promise<T> {
    this.get(computerId);
    const op = this.beginOperation(computerId, "guest-call", "");
    try {
      await this.wake(computerId);
      return await fn(this.get(computerId));
    } finally {
      this.endOperation(op.id);
    }
  }

  /** Deletion shares the transition queue with sleep/wake and refuses active work. */
  async delete(computerId: string, remove: () => Promise<unknown>): Promise<void> {
    await this.enqueueTransition(computerId, async () => {
      const c = this.get(computerId);
      if (this.activeOperations(computerId).length) throw new Error("computer has active operations; retry after they finish");
      c.state = "deleting";
      this.persist();
      try {
        await remove();
        this.unregister(computerId);
      } catch (e) {
        c.state = "failed";
        this.persist();
        throw e;
      }
    });
  }
}

/** Raw-bytes GET (screenshots are binary; the JSON path would corrupt them). */
export function guestCallRaw(
  socketPath: string, path: string, token?: string, timeoutMs = 30000,
): Promise<{ contentType: string; data: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers["x-guest-token"] = token;
    const req = http.request(
      { socketPath, method: "GET", path, timeout: timeoutMs, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`guest GET ${path} -> ${res.statusCode}`));
          } else {
            resolve({
              contentType: String(res.headers["content-type"] ?? "application/octet-stream"),
              data: Buffer.concat(chunks),
            });
          }
        });
      });
    req.on("timeout", () => req.destroy(new Error("guest call timed out")));
    req.on("error", reject);
    req.end();
  });
}
