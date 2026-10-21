/**
 * ACP Control Plane — the owner's API.
 *
 * Responsibilities: first-run setup + session auth, computer CRUD and
 * lifecycle (through the lifecycle engine and the Docker supervisor —
 * this process never touches Docker itself), a wake-on-call proxy to
 * each guest supervisor, MCP token management, and the audit log.
 *
 * Zero-dependency Node http server. Mutating requests require the
 * session cookie AND an `x-acp-request: 1` header (CSRF guard for the
 * cookie-authenticated dashboard API).
 */
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Db, type ComputerRow } from "./db.ts";
import {
  hashPassword, verifyPassword, newSessionToken, sha256, newMcpToken,
  parseCookies, sessionCookie, clearSessionCookie,
} from "./auth.ts";
import { SupervisorClient, SupervisorDriver } from "./supervisorClient.ts";
import {
  LifecycleEngine, guestCall, type EngineState, type Store,
} from "./lifecycle.ts";
import { makeMcpHandler } from "./mcp.ts";

const PORT = Number(process.env.ACP_PORT ?? 8787);
const DB_FILE = process.env.ACP_DB ?? `${process.env.HOME}/.acp/control-plane.db`;
const SUP_SOCK = process.env.ACP_SUPERVISOR_SOCK ?? "/run/acp/supervisor.sock";
const SUP_SECRET = process.env.ACP_SUPERVISOR_SECRET ?? "";
const IDLE_TIMEOUT_S = Number(process.env.ACP_IDLE_TIMEOUT_S ?? 300);
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

if (!SUP_SECRET) {
  console.error("ACP_SUPERVISOR_SECRET is required");
  process.exit(1);
}

const db = new Db(DB_FILE);
// The database holds password hashes and token hashes: keep it (and its
// WAL sidecars) owner-only regardless of the process umask.
for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  try { fs.chmodSync(f, 0o600); } catch { /* created lazily; boot path re-applies */ }
}

process.on("unhandledRejection", (e) => {
  console.error("unhandled rejection (continuing):", e);
});
process.on("uncaughtException", (e) => {
  console.error("uncaught exception (exiting for a clean restart):", e);
  process.exit(1);
});
const sup = new SupervisorClient(SUP_SOCK, SUP_SECRET);

class SqliteStore implements Store {
  load(): EngineState {
    const raw = db.engineState();
    if (raw) {
      try { return JSON.parse(raw) as EngineState; } catch { /* fall through */ }
    }
    return { computers: {}, leases: {}, operations: {} };
  }
  save(state: EngineState): void { db.setEngineState(JSON.stringify(state)); }
}

const engine = new LifecycleEngine(new SqliteStore(), {
  driver: new SupervisorDriver(sup),
  idleTimeoutS: IDLE_TIMEOUT_S,
});

// ---- boot: register DB computers into the engine, reconcile with reality --
for (const row of db.computers()) {
  engine.register({
    id: row.id, container: row.container, socketPath: row.socketPath,
    guestToken: row.guestToken, state: "sleeping",
  });
}
async function reconcile(): Promise<void> {
  for (const row of db.computers()) {
    try {
      const insp = await sup.inspect(row.id);
      if (insp.running) {
        try {
          await engine.health(engine.get(row.id));
          engine.get(row.id).state = "ready";
          db.setComputerState(row.id, "ready");
        } catch {
          engine.get(row.id).state = "unhealthy";
          db.setComputerState(row.id, "unhealthy");
        }
      } else {
        engine.get(row.id).state = "sleeping";
        db.setComputerState(row.id, "sleeping");
      }
    } catch {
      // container missing entirely (deleted outside the platform)
      engine.get(row.id).state = "failed";
      db.setComputerState(row.id, "failed");
    }
  }
}

function syncState(id: string): void {
  try {
    db.setComputerState(id, engine.get(id).state);
  } catch { /* computer may have been deleted mid-flight */ }
}

function publicComputer(row: ComputerRow): Record<string, unknown> {
  let state = row.state;
  try { state = engine.get(row.id).state; } catch { /* keep db state */ }
  return {
    id: row.id, name: row.name, state,
    cpuMillis: row.cpuMillis, memoryMb: row.memoryMb, diskGb: row.diskGb,
    limitsEnforced: row.limitsEnforced,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

// ---- http plumbing -----------------------------------------------------------
interface Ctx {
  user: { id: number; username: string } | null;
  sessionHash: string | null;
  body: Record<string, unknown>;
  params: Record<string, string>;
  secure: boolean;
}

const loginFails = new Map<string, number[]>();

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c) => {
      size += (c as Buffer).length;
      if (size > 1_000_000) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c as Buffer);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function authUser(req: http.IncomingMessage): Ctx["user"] {
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies.acp_session) return null;
  const u = db.sessionUser(sha256(cookies.acp_session));
  return u ? { id: u.id, username: u.username } : null;
}

type Handler = (ctx: Ctx) => Promise<{ status?: number; json?: unknown; headers?: Record<string, string> }>;

interface Route {
  method: string;
  pattern: string;
  auth: boolean;
  handler: Handler;
}

const routes: Route[] = [];
function route(method: string, pattern: string, auth: boolean, handler: Handler): void {
  routes.push({ method, pattern, auth, handler });
}

function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const a = path.split("/").filter(Boolean);
  if (p.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(a[i]);
    else if (p[i] !== a[i]) return null;
  }
  return params;
}

// ---- routes --------------------------------------------------------------------
route("GET", "/api/health", false, async () => ({ json: { ok: true } }));

route("GET", "/api/setup/status", false, async () => ({
  json: { needsSetup: db.userCount() === 0 },
}));

route("POST", "/api/setup", false, async (ctx) => {
  if (db.userCount() > 0) return { status: 409, json: { error: "setup already completed" } };
  const username = String(ctx.body.username ?? "").trim();
  const password = String(ctx.body.password ?? "");
  if (username.length < 3) return { status: 400, json: { error: "username must be at least 3 characters" } };
  if (password.length < 10) return { status: 400, json: { error: "password must be at least 10 characters" } };
  const user = db.createUser(username, hashPassword(password));
  const { token, hash } = newSessionToken();
  db.createSession(hash, user.id, SESSION_TTL_MS);
  db.audit(username, "auth.setup", null, {});
  return {
    json: { ok: true, username },
    headers: { "set-cookie": sessionCookie(token, SESSION_TTL_MS / 1000, ctx.secure) },
  };
});

route("POST", "/api/auth/login", false, async (ctx) => {
  const ip = "local";
  const nowMs = Date.now();
  const fails = (loginFails.get(ip) ?? []).filter((t) => nowMs - t < 5 * 60 * 1000);
  if (fails.length >= 5) return { status: 429, json: { error: "too many failed logins; wait a few minutes" } };
  const username = String(ctx.body.username ?? "");
  const password = String(ctx.body.password ?? "");
  const user = db.userByName(username);
  if (!user || !verifyPassword(password, user.pwHash)) {
    fails.push(nowMs);
    loginFails.set(ip, fails);
    db.audit(username || "?", "auth.login_failed", null, {});
    return { status: 401, json: { error: "invalid username or password" } };
  }
  loginFails.delete(ip);
  const { token, hash } = newSessionToken();
  db.createSession(hash, user.id, SESSION_TTL_MS);
  db.audit(username, "auth.login", null, {});
  return {
    json: { ok: true, username },
    headers: { "set-cookie": sessionCookie(token, SESSION_TTL_MS / 1000, ctx.secure) },
  };
});

route("POST", "/api/auth/logout", true, async (ctx) => {
  if (ctx.sessionHash) db.deleteSession(ctx.sessionHash);
  db.audit(ctx.user!.username, "auth.logout", null, {});
  return {
    json: { ok: true },
    headers: { "set-cookie": clearSessionCookie() },
  };
});

route("GET", "/api/auth/me", true, async (ctx) => ({ json: { username: ctx.user!.username } }));

route("GET", "/api/computers", true, async () => ({
  json: { computers: db.computers().map(publicComputer) },
}));

route("POST", "/api/computers", true, async (ctx) => {
  const name = String(ctx.body.name ?? "").trim();
  if (name.length < 1 || name.length > 60) return { status: 400, json: { error: "name must be 1..60 characters" } };
  const cpuMillis = Number(ctx.body.cpuMillis ?? 1000);
  const memoryMb = Number(ctx.body.memoryMb ?? 2048);
  const diskGb = Number(ctx.body.diskGb ?? 20);
  if (!Number.isFinite(diskGb) || diskGb < 5 || diskGb > 500) {
    return { status: 400, json: { error: "diskGb out of range 5..500" } };
  }
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "computer";
  const id = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
  let created;
  try {
    created = await sup.create({ computerId: id, displayName: name, cpuMillis, memoryMb });
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message } };
  }
  const row: ComputerRow = {
    id, name, container: created.container, volume: created.volume,
    socketPath: created.socketPath, guestToken: created.guestToken,
    state: "starting", cpuMillis, memoryMb, diskGb,
    limitsEnforced: created.limitsEnforced,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  db.insertComputer(row);
  engine.register({
    id, container: created.container, socketPath: created.socketPath,
    guestToken: created.guestToken, state: "starting",
  });
  db.audit(ctx.user!.username, "computer.create", id,
    { name, cpuMillis, memoryMb, diskGb, limitsEnforced: created.limitsEnforced });
  if (!created.limitsEnforced) {
    db.audit("system", "computer.limits_unenforced", id,
      { reason: "docker host kernel does not support CPU/memory cgroup limits" });
  }
  try {
    await sup.start(id);
    await engine.wake(id); // health-wait -> ready
  } catch (e) {
    engine.get(id).state = "failed";
    db.setComputerState(id, "failed");
    db.audit(ctx.user!.username, "computer.create_failed", id, { error: (e as Error).message });
    return { status: 502, json: { error: `computer created but failed to start: ${(e as Error).message}`, computer: publicComputer(db.computer(id)!) } };
  }
  syncState(id);
  db.audit(ctx.user!.username, "computer.ready", id, {});
  return {
    status: 201,
    json: {
      computer: publicComputer(db.computer(id)!),
      limitsEnforced: created.limitsEnforced,
    },
  };
});

route("GET", "/api/computers/:id", true, async (ctx) => {
  const row = db.computer(ctx.params.id);
  if (!row) return { status: 404, json: { error: "computer not found" } };
  return { json: { computer: publicComputer(row) } };
});

route("GET", "/api/computers/:id/stats", true, async (ctx) => {
  const row = db.computer(ctx.params.id);
  if (!row) return { status: 404, json: { error: "computer not found" } };
  try {
    const insp = await sup.inspect(row.id);
    if (!insp.running) return { json: { running: false, stats: null } };
    return { json: { running: true, stats: await sup.stats(row.id) } };
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message } };
  }
});

for (const action of ["start", "wake", "sleep", "stop"] as const) {
  route("POST", `/api/computers/:id/${action}`, true, async (ctx) => {
    const row = db.computer(ctx.params.id);
    if (!row) return { status: 404, json: { error: "computer not found" } };
    try {
      if (action === "start" || action === "wake") {
        await engine.wake(row.id);
      } else {
        await engine.sleep(row.id, `api-${action}`);
      }
      syncState(row.id);
      db.audit(ctx.user!.username, `computer.${action}`, row.id, {});
      return { json: { computer: publicComputer(db.computer(row.id)!) } };
    } catch (e) {
      syncState(row.id);
      return { status: 502, json: { error: (e as Error).message } };
    }
  });
}

route("DELETE", "/api/computers/:id", true, async (ctx) => {
  const row = db.computer(ctx.params.id);
  if (!row) return { status: 404, json: { error: "computer not found" } };
  // Typed-confirmation at the API level: the caller must repeat the name.
  if (String(ctx.body.confirmName ?? "") !== row.name) {
    return { status: 400, json: { error: "confirmName must exactly match the computer name" } };
  }
  try {
    await sup.remove(row.id, true);
  } catch (e) {
    return { status: 502, json: { error: (e as Error).message } };
  }
  engine.unregister(row.id);
  db.deleteComputer(row.id);
  db.audit(ctx.user!.username, "computer.delete", row.id, { name: row.name });
  return { json: { ok: true } };
});

route("POST", "/api/computers/:id/leases", true, async (ctx) => {
  const row = db.computer(ctx.params.id);
  if (!row) return { status: 404, json: { error: "computer not found" } };
  const lease = engine.acquireLease(row.id, String(ctx.body.owner ?? ctx.user!.username),
    ctx.body.ttlS ? Number(ctx.body.ttlS) : undefined);
  return { status: 201, json: { lease } };
});

route("DELETE", "/api/computers/:id/leases/:leaseId", true, async (ctx) => {
  engine.releaseLease(ctx.params.leaseId);
  return { json: { ok: true } };
});

// Guest proxy: any guest-supervisor path, with wake-on-call.
route("GET", "/api/computers/:id/guest/*", true, proxyHandler("GET"));
route("POST", "/api/computers/:id/guest/*", true, proxyHandler("POST"));
function proxyHandler(method: string): Handler {
  return async (ctx) => {
    const row = db.computer(ctx.params.id);
    if (!row) return { status: 404, json: { error: "computer not found" } };
    const rest = ctx.params["*"];
    try {
      const result = await engine.call(row.id, (c) =>
        guestCall(c.socketPath, method, `/${rest}`, method === "POST" ? ctx.body : undefined,
          60000, c.guestToken));
      syncState(row.id);
      return { json: result };
    } catch (e) {
      syncState(row.id);
      return { status: 502, json: { error: (e as Error).message } };
    }
  };
}

// MCP tokens (consumed by the Phase 2 gateway).
route("GET", "/api/tokens", true, async () => ({ json: { tokens: db.tokens() } }));
route("POST", "/api/tokens", true, async (ctx) => {
  const name = String(ctx.body.name ?? "").trim();
  if (!name) return { status: 400, json: { error: "name is required" } };
  if (name.length > 60) return { status: 400, json: { error: "name too long (60 chars max)" } };
  const scopes = Array.isArray(ctx.body.scopes) ? ctx.body.scopes.map(String) : ["read"];
  const KNOWN_SCOPES = ["read", "write", "browser", "files", "admin"];
  if (scopes.length === 0 || scopes.some((s) => !KNOWN_SCOPES.includes(s))) {
    return { status: 400, json: { error: `scopes must be a non-empty subset of: ${KNOWN_SCOPES.join(", ")}` } };
  }
  const computerId = ctx.body.computerId ? String(ctx.body.computerId) : null;
  if (computerId && !db.computer(computerId)) {
    return { status: 400, json: { error: "computerId does not exist" } };
  }
  const { token, hash } = newMcpToken();
  const id = `tok_${crypto.randomBytes(4).toString("hex")}`;
  db.insertToken({ id, name, tokenHash: hash, scopes, computerId });
  db.audit(ctx.user!.username, "token.create", computerId, { tokenId: id, name, scopes });
  return { status: 201, json: { id, name, scopes, computerId, token } }; // token shown once
});
route("DELETE", "/api/tokens/:id", true, async (ctx) => {
  db.revokeToken(ctx.params.id);
  db.audit(ctx.user!.username, "token.revoke", null, { tokenId: ctx.params.id });
  return { json: { ok: true } };
});

route("GET", "/api/audit", true, async () => ({ json: { entries: db.auditLog(100) } }));

// ---- server --------------------------------------------------------------------
const mcpHandler = makeMcpHandler({ db, engine, sup });

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
};

const server = http.createServer(async (req, res) => {
  const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path === "/mcp") {
    await mcpHandler(req, res);
    return;
  }
  let body: Record<string, unknown> = {};
  if (req.method === "POST" || req.method === "DELETE") {
    try { body = await readBody(req); } catch (e) {
      return send(400, { error: (e as Error).message });
    }
  }
  for (const r of routes) {
    const params = match(r.pattern, path) ??
      (r.pattern.endsWith("/*") ? matchWildcard(r.pattern, path) : null);
    if (!params || r.method !== req.method) continue;
    const user = authUser(req);
    if (r.auth && !user) return send(401, { error: "not signed in" });
    if (r.auth && req.method !== "GET" && req.headers["x-acp-request"] !== "1") {
      return send(403, { error: "missing x-acp-request header" });
    }
    try {
      const cookies = parseCookies(req.headers.cookie);
      const sessionHash = cookies.acp_session ? sha256(cookies.acp_session) : null;
      const secure = Boolean((req.socket as { encrypted?: boolean }).encrypted)
        || req.headers["x-forwarded-proto"] === "https";
      const out = await r.handler({ user, body, params, sessionHash, secure });
      return send(out.status ?? 200, out.json ?? {}, out.headers ?? {});
    } catch (e) {
      return send(500, { error: (e as Error).message });
    }
  }
  // Static dashboard (SPA): served for non-API GETs when a build exists.
  if (req.method === "GET" && !path.startsWith("/api") && serveStatic(path, res)) {
    return;
  }
  return send(404, { error: "no such route" });
});

const DASH_DIR = process.env.ACP_DASHBOARD_DIR ?? "apps/dashboard/dist";
const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".json": "application/json", ".woff2": "font/woff2", ".map": "application/json",
};

function serveStatic(urlPath: string, res: http.ServerResponse): boolean {
  let indexHtml: Buffer;
  try {
    indexHtml = fs.readFileSync(path.join(DASH_DIR, "index.html"));
  } catch {
    return false; // dashboard not built
  }
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const file = path.resolve(DASH_DIR, rel);
  if (file.startsWith(path.resolve(DASH_DIR))) {
    try {
      const data = fs.readFileSync(file);
      const ext = path.extname(file);
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", ...SECURITY_HEADERS });
      res.end(data);
      return true;
    } catch { /* fall through to SPA index */ }
  }
  res.writeHead(200, { "content-type": "text/html", ...SECURITY_HEADERS });
  res.end(indexHtml);
  return true;
}

// ---- live desktop (noVNC) WebSocket proxy -----------------------------------
// Authenticated by the dashboard session cookie. Wakes the computer,
// holds a presence lease while connected, and pipes raw bytes to the
// guest supervisor's /vnc bridge over its unix socket. The RFB stream
// is never terminated here — this is a byte pipe with auth + wake.
server.on("upgrade", async (req, socket, head) => {
  const fail = (code: number, msg: string) => {
    try {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nContent-Length: 0\r\n\r\n`);
    } catch { /* gone */ }
    socket.destroy();
  };
  const m = /^\/api\/computers\/([^/]+)\/vnc$/.exec((req.url ?? "").split("?")[0]);
  if (!m) return fail(404, "Not Found");
  const cookies = parseCookies(req.headers.cookie);
  const user = cookies.acp_session ? db.sessionUser(sha256(cookies.acp_session)) : null;
  if (!user) return fail(401, "Unauthorized");
  const row = db.computer(decodeURIComponent(m[1]));
  if (!row) return fail(404, "Not Found");
  let leaseId: string | null = null;
  let renew: ReturnType<typeof setInterval> | null = null;
  try {
    await engine.wake(row.id);
    syncState(row.id);
    const lease = engine.acquireLease(row.id, `human:${user.username}`, 120);
    leaseId = lease.id;
    renew = setInterval(() => {
      try {
        engine.releaseLease(leaseId!);
        leaseId = engine.acquireLease(row.id, `human:${user.username}`, 120).id;
      } catch { /* computer may be gone */ }
    }, 30000);
    db.audit(user.username, "computer.vnc_open", row.id, {});
  } catch (e) {
    return fail(502, "Bad Gateway");
  }
  const upstream = net.createConnection(row.socketPath);
  const cleanup = () => {
    if (renew) clearInterval(renew);
    if (leaseId) engine.releaseLease(leaseId);
    upstream.destroy();
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
  upstream.on("error", () => socket.destroy());
  upstream.on("connect", () => {
    const key = req.headers["sec-websocket-key"];
    const lines = [
      "GET /vnc HTTP/1.1",
      "Host: localhost",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] ?? "13"}`,
      `Sec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"] ?? "binary"}`,
      `X-Guest-Token: ${row.guestToken}`,
      "\r\n",
    ];
    upstream.write(lines.join("\r\n"));
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
});

function matchWildcard(pattern: string, path: string): Record<string, string> | null {
  // pattern like /api/computers/:id/guest/*
  const base = pattern.slice(0, -1); // keep trailing slash
  const pSegs = base.split("/").filter(Boolean);
  const aSegs = path.split("/").filter(Boolean);
  if (aSegs.length <= pSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    if (pSegs[i].startsWith(":")) params[pSegs[i].slice(1)] = decodeURIComponent(aSegs[i]);
    else if (pSegs[i] !== aSegs[i]) return null;
  }
  params["*"] = aSegs.slice(pSegs.length).join("/");
  return params;
}

// Idle loop: evaluate every computer periodically; audit sleeps.
setInterval(async () => {
  for (const row of db.computers()) {
    try {
      const r = await engine.tick(row.id);
      if (r.action === "slept") {
        db.audit("system", "computer.auto_sleep", row.id, { detail: r.detail });
      }
      syncState(row.id);
    } catch { /* transient; next round retries */ }
  }
}, Number(process.env.ACP_TICK_MS ?? 20000));

reconcile().then(() => {
  server.listen(PORT, () => {
    console.log(`acp control plane listening on :${PORT} (db=${DB_FILE}, idle=${IDLE_TIMEOUT_S}s)`);
  });
});
