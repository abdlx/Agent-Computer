/**
 * MCP gateway: exposes ACP computers as MCP tools over Streamable HTTP
 * (JSON-RPC), authenticated by the scoped MCP tokens from Phase 1.
 *
 * - Transport: POST /mcp (single JSON-RPC messages + notifications).
 *   Stateless apart from the initialize handshake's session id header,
 *   which is issued and accepted but not required afterwards — any
 *   conforming client (official SDK, Hermes) can call tools directly.
 * - Auth: `Authorization: Bearer <acp_token>`. Scopes: read (observe),
 *   write (desktop input + lifecycle + terminal), browser, files,
 *   admin (everything, incl. computer create/delete and token ops are
 *   NOT exposed here — create/delete of computers is admin).
 * - Every guest-touching call goes through the lifecycle engine:
 *   wake-on-call, plus a rolling activity lease per (token, computer)
 *   so an actively-working agent's computer never sleeps mid-task.
 * - Tool errors return MCP-style { isError: true } results; auth and
 *   protocol errors return JSON-RPC errors / HTTP statuses.
 */
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { Db, ComputerRow } from "./db.ts";
import { sha256 } from "./auth.ts";
import {
  LifecycleEngine, guestCall, guestCallRaw, type Computer,
} from "./lifecycle.ts";
import type { SupervisorClient } from "./supervisorClient.ts";

const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const ALL_SCOPES = ["read", "write", "browser", "files", "admin"];

interface TokenInfo {
  id: string;
  name: string;
  scopes: string[];
  computerId: string | null;
}

interface CallCtx {
  db: Db;
  engine: LifecycleEngine;
  sup: SupervisorClient;
  token: TokenInfo;
  leases: Map<string, { leaseId: string; expiresAt: number }>;
}

function hasScope(token: TokenInfo, scope: string): boolean {
  return token.scopes.includes("admin") || token.scopes.includes(scope);
}

function resolveComputer(ctx: CallCtx, arg: unknown): ComputerRow {
  const rows = ctx.db.computers();
  let row: ComputerRow | undefined;
  if (ctx.token.computerId) {
    row = rows.find((r) => r.id === ctx.token.computerId);
    if (!row) throw new Error("the computer this token is bound to no longer exists");
    if (arg && String(arg) !== row.id && String(arg) !== row.name) {
      throw new Error(`token is bound to computer ${row.id}; it cannot access ${String(arg)}`);
    }
    return row;
  }
  if (arg) {
    row = rows.find((r) => r.id === String(arg) || r.name === String(arg));
    if (!row) throw new Error(`computer not found: ${String(arg)}`);
    return row;
  }
  if (rows.length === 1) return rows[0];
  throw new Error("specify which computer (id or name) — this token can access several");
}

/** Rolling lease: one live 120 s lease per (token, computer), renewed per call. */
function rollLease(ctx: CallCtx, computerId: string): void {
  const key = `${ctx.token.id}:${computerId}`;
  const cur = ctx.leases.get(key);
  const nowS = Date.now() / 1000;
  if (cur && cur.expiresAt > nowS + 30) return;
  if (cur) ctx.engine.releaseLease(cur.leaseId);
  const lease = ctx.engine.acquireLease(computerId, `mcp:${ctx.token.name}`, 120);
  ctx.leases.set(key, { leaseId: lease.id, expiresAt: lease.expiresAt });
}

async function guest<T = unknown>(
  ctx: CallCtx, row: ComputerRow, method: string, path: string,
  body?: unknown, timeoutMs = 90000,
): Promise<T> {
  rollLease(ctx, row.id);
  return ctx.engine.call(row.id, (c: Computer) =>
    guestCall<T>(c.socketPath, method, path, body, timeoutMs, c.guestToken));
}

type ToolResult = { content: unknown[]; isError?: boolean };
const text = (v: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});
const errText = (msg: string): ToolResult => ({
  content: [{ type: "text", text: `Error: ${msg}` }], isError: true,
});

interface ToolDef {
  name: string;
  description: string;
  scope: string;
  inputSchema: Record<string, unknown>;
  run: (ctx: CallCtx, args: Record<string, unknown>) => Promise<ToolResult>;
}

const COMPUTER_ARG = {
  computer: { type: "string", description: "Computer id or name. Optional when the token is bound to one computer or only one exists." },
};
const obj = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object", properties: props, required,
});

export const TOOLS: ToolDef[] = [
  // ---- lifecycle / discovery -------------------------------------------------
  {
    name: "computer_list", scope: "read",
    description: "List the computers this token can access, with their lifecycle state.",
    inputSchema: obj({}),
    run: async (ctx) => {
      const rows = ctx.db.computers()
        .filter((r) => !ctx.token.computerId || r.id === ctx.token.computerId)
        .map((r) => {
          let state = r.state;
          try { state = ctx.engine.get(r.id).state; } catch { /* db state */ }
          return { id: r.id, name: r.name, state, cpuMillis: r.cpuMillis, memoryMb: r.memoryMb };
        });
      return text(rows);
    },
  },
  {
    name: "computer_status", scope: "read",
    description: "Detailed status of one computer: lifecycle state, guest health, control owner, activity.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      const row = resolveComputer(ctx, args.computer);
      let health: unknown = null;
      try { health = await guest(ctx, row, "GET", "/health", undefined, 10000); } catch { /* sleeping */ }
      return text({ id: row.id, name: row.name, state: health ? "ready" : row.state, health });
    },
  },
  {
    name: "computer_wake", scope: "write",
    description: "Wake a sleeping computer and wait until it is ready.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      const row = resolveComputer(ctx, args.computer);
      const c = await ctx.engine.wake(row.id);
      return text({ id: row.id, state: c.state });
    },
  },
  {
    name: "computer_sleep", scope: "write",
    description: "Gracefully sleep a computer (browser state flushes; files and profile persist).",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      const row = resolveComputer(ctx, args.computer);
      const c = await ctx.engine.sleep(row.id, "mcp");
      return text({ id: row.id, state: c.state });
    },
  },
  {
    name: "computer_create", scope: "admin",
    description: "Create a new computer (admin scope). Returns its id once ready.",
    inputSchema: obj({ name: { type: "string" }, cpuMillis: { type: "number" }, memoryMb: { type: "number" } }, ["name"]),
    run: async (ctx, args) => {
      const name = String(args.name);
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "computer";
      const id = `${slug}-${crypto.randomBytes(3).toString("hex")}`;
      const cpuMillis = Number(args.cpuMillis ?? 1000);
      const memoryMb = Number(args.memoryMb ?? 2048);
      const created = await ctx.sup.create({ computerId: id, displayName: name, cpuMillis, memoryMb });
      ctx.db.insertComputer({
        id, name, container: created.container, volume: created.volume,
        socketPath: created.socketPath, guestToken: created.guestToken,
        state: "starting", cpuMillis, memoryMb, diskGb: 20,
        limitsEnforced: created.limitsEnforced,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      ctx.engine.register({
        id, container: created.container, socketPath: created.socketPath,
        guestToken: created.guestToken, state: "starting",
      });
      await ctx.sup.start(id);
      await ctx.engine.wake(id);
      ctx.db.setComputerState(id, "ready");
      ctx.db.audit(`mcp:${ctx.token.name}`, "computer.create", id, { name });
      return text({ id, name, state: "ready", limitsEnforced: created.limitsEnforced });
    },
  },
  {
    name: "computer_delete", scope: "admin",
    description: "Delete a computer and its home volume (admin scope, irreversible).",
    inputSchema: obj({ ...COMPUTER_ARG, confirmName: { type: "string" } }, ["confirmName"]),
    run: async (ctx, args) => {
      const row = resolveComputer(ctx, args.computer);
      if (String(args.confirmName) !== row.name) {
        return errText("confirmName must exactly match the computer name");
      }
      await ctx.sup.remove(row.id, true);
      ctx.engine.unregister(row.id);
      ctx.db.deleteComputer(row.id);
      ctx.db.audit(`mcp:${ctx.token.name}`, "computer.delete", row.id, { name: row.name });
      return text({ deleted: row.id });
    },
  },
  // ---- desktop ---------------------------------------------------------------
  {
    name: "screenshot", scope: "read",
    description: "Take a screenshot of the computer's desktop (PNG image).",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => {
      const row = resolveComputer(ctx, args.computer);
      rollLease(ctx, row.id);
      const raw = await ctx.engine.call(row.id, (c: Computer) =>
        guestCallRaw(c.socketPath, "/screenshot", c.guestToken, 30000));
      return { content: [{ type: "image", data: raw.data.toString("base64"), mimeType: "image/png" }] };
    },
  },
  {
    name: "cursor_get", scope: "read",
    description: "Current mouse cursor position.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "GET", "/cursor")),
  },
  {
    name: "windows_list", scope: "read",
    description: "List open windows with root coordinates, sizes, and the active flag.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "GET", "/windows")),
  },
  {
    name: "window_focus", scope: "write",
    description: "Bring a window to the front and focus it (by window id from windows_list).",
    inputSchema: obj({ ...COMPUTER_ARG, id: { type: "number" } }, ["id"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/windows/focus", { id: args.id })),
  },
  {
    name: "app_launch", scope: "write",
    description: "Launch an application: 'terminal' (xterm) or 'files' (file manager).",
    inputSchema: obj({ ...COMPUTER_ARG, app: { type: "string", enum: ["terminal", "files"] } }, ["app"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/launch", { app: args.app })),
  },
  {
    name: "mouse_move", scope: "write",
    description: "Move the real cursor to (x, y) — smooth Bézier trajectory by default (mode 'natural'), or 'precise' for a direct move.",
    inputSchema: obj({ ...COMPUTER_ARG, x: { type: "number" }, y: { type: "number" }, mode: { type: "string", enum: ["natural", "precise"] } }, ["x", "y"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/input/move",
      { x: args.x, y: args.y, mode: args.mode ?? "natural" }, 60000)),
  },
  {
    name: "mouse_click", scope: "write",
    description: "Click at (x, y) — or at the current position when coordinates are omitted.",
    inputSchema: obj({ ...COMPUTER_ARG, x: { type: "number" }, y: { type: "number" }, button: { type: "number" }, clicks: { type: "number" } }),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/input/click",
      { x: args.x, y: args.y, button: args.button ?? 1, clicks: args.clicks ?? 1 }, 60000)),
  },
  {
    name: "mouse_drag", scope: "write",
    description: "Drag from one point to another with the mouse button held (trajectory path).",
    inputSchema: obj({ ...COMPUTER_ARG, from: { type: "array", items: { type: "number" } }, to: { type: "array", items: { type: "number" } } }, ["from", "to"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/input/drag",
      { from: args.from, to: args.to }, 60000)),
  },
  {
    name: "mouse_scroll", scope: "write",
    description: "Scroll by dy (vertical) / dx (horizontal) steps.",
    inputSchema: obj({ ...COMPUTER_ARG, dy: { type: "number" }, dx: { type: "number" } }),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/input/scroll",
      { dy: args.dy ?? 0, dx: args.dx ?? 0 })),
  },
  {
    name: "keyboard_type", scope: "write",
    description: "Type text into the focused window (real key events).",
    inputSchema: obj({ ...COMPUTER_ARG, text: { type: "string" } }, ["text"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/input/type",
      { text: args.text }, 120000)),
  },
  {
    name: "keyboard_key", scope: "write",
    description: "Press a key or combination, e.g. ['Return'], ['ctrl','l'], ['alt','Tab'].",
    inputSchema: obj({ ...COMPUTER_ARG, keys: { type: "array", items: { type: "string" } } }, ["keys"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/input/key", { keys: args.keys })),
  },
  // ---- browser -----------------------------------------------------------------
  {
    name: "browser_start", scope: "browser",
    description: "Start the persistent browser (Camoufox) on the desktop. The profile (cookies, logins) persists across restarts and sleeps.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/browser/start", { engine: "camoufox" }, 180000)),
  },
  {
    name: "browser_navigate", scope: "browser",
    description: "Navigate the browser to a URL.",
    inputSchema: obj({ ...COMPUTER_ARG, url: { type: "string" } }, ["url"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/browser/navigate", { url: args.url }, 120000)),
  },
  {
    name: "browser_snapshot", scope: "browser",
    description: "Accessibility snapshot of the page: interactive elements with refs (e1, e2, …) to use with browser_click / browser_fill.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "GET", "/browser/snapshot")),
  },
  {
    name: "browser_click", scope: "browser",
    description: "Click an element by its snapshot ref.",
    inputSchema: obj({ ...COMPUTER_ARG, ref: { type: "string" } }, ["ref"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/browser/click", { ref: args.ref }, 60000)),
  },
  {
    name: "browser_fill", scope: "browser",
    description: "Fill a text field (by snapshot ref) with text.",
    inputSchema: obj({ ...COMPUTER_ARG, ref: { type: "string" }, text: { type: "string" } }, ["ref", "text"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/browser/fill", { ref: args.ref, text: args.text }, 60000)),
  },
  {
    name: "browser_press", scope: "browser",
    description: "Press a key in the page, e.g. 'Enter', 'Tab', 'Escape'.",
    inputSchema: obj({ ...COMPUTER_ARG, key: { type: "string" } }, ["key"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/browser/press", { key: args.key }, 60000)),
  },
  {
    name: "browser_content", scope: "browser",
    description: "The page's visible text content and title.",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "GET", "/browser/content")),
  },
  {
    name: "browser_close", scope: "browser",
    description: "Close the browser (profile state flushes to disk).",
    inputSchema: obj({ ...COMPUTER_ARG }),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/browser/close", {}, 60000)),
  },
  // ---- files ---------------------------------------------------------------------
  {
    name: "fs_list", scope: "files",
    description: "List a directory inside the computer's home directory.",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/fs/list", { path: args.path ?? "." })),
  },
  {
    name: "fs_read", scope: "files",
    description: "Read a file from the home directory (utf-8, or base64 when binary; 256 KB cap).",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }, ["path"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/fs/read", { path: args.path })),
  },
  {
    name: "fs_write", scope: "files",
    description: "Write a file in the home directory (creates parent directories).",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" }, content: { type: "string" }, encoding: { type: "string", enum: ["utf-8", "base64"] } }, ["path", "content"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/fs/write",
      { path: args.path, content: args.content, encoding: args.encoding ?? "utf-8" })),
  },
  {
    name: "fs_mkdir", scope: "files",
    description: "Create a directory (and parents) in the home directory.",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }, ["path"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/fs/mkdir", { path: args.path })),
  },
  {
    name: "fs_delete", scope: "files",
    description: "Delete a file or directory tree from the home directory.",
    inputSchema: obj({ ...COMPUTER_ARG, path: { type: "string" } }, ["path"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/fs/delete", { path: args.path })),
  },
  // ---- terminal ---------------------------------------------------------------------
  {
    name: "terminal_exec", scope: "write",
    description: "Run a shell command on the computer (as its user, in a login shell) and return stdout/stderr/exit code. Long-running processes should use nohup/setsid and return.",
    inputSchema: obj({ ...COMPUTER_ARG, command: { type: "string" }, timeout_s: { type: "number" } }, ["command"]),
    run: async (ctx, args) => text(await guest(ctx, resolveComputer(ctx, args.computer), "POST", "/exec",
      { command: args.command, timeout_s: args.timeout_s ?? 30 }, 135000)),
  },
  // ---- batch ---------------------------------------------------------------------
  {
    name: "batch", scope: "write",
    description: "Run a sequence of tool steps in order (each step: {tool, args}). Stops at the first failing step unless stopOnError is false. Cannot call batch, computer_create, or computer_delete.",
    inputSchema: obj({
      ...COMPUTER_ARG,
      steps: { type: "array", items: { type: "object" } },
      stopOnError: { type: "boolean" },
    }, ["steps"]),
    run: async (ctx, args) => {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      if (steps.length === 0 || steps.length > 50) return errText("steps must contain 1..50 items");
      const results: unknown[] = [];
      for (const rawStep of steps) {
        const step = rawStep as { tool?: string; args?: Record<string, unknown> };
        const def = TOOLS.find((t) => t.name === step.tool);
        if (!def || def.name === "batch" || def.scope === "admin") {
          results.push({ tool: step.tool, error: "tool not allowed in batch" });
          if (args.stopOnError !== false) break;
          continue;
        }
        if (!hasScope(ctx.token, def.scope)) {
          results.push({ tool: def.name, error: `missing scope: ${def.scope}` });
          if (args.stopOnError !== false) break;
          continue;
        }
        const stepArgs = { ...(step.args ?? {}) };
        if (args.computer && !stepArgs.computer) stepArgs.computer = args.computer;
        try {
          const r = await def.run(ctx, stepArgs);
          results.push({ tool: def.name, result: r.content, isError: r.isError ?? false });
          if (r.isError && args.stopOnError !== false) break;
        } catch (e) {
          results.push({ tool: def.name, error: (e as Error).message });
          if (args.stopOnError !== false) break;
        }
      }
      return text({ steps: results });
    },
  },
];

const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

export function makeMcpHandler(deps: { db: Db; engine: LifecycleEngine; sup: SupervisorClient }) {
  const leases = new Map<string, { leaseId: string; expiresAt: number }>();
  // Per-token sliding-window rate limit: a runaway or compromised agent
  // must not be able to hammer the guest/computer fleet unbounded.
  const RATE_PER_MIN = Number(process.env.ACP_MCP_RATE_PER_MIN ?? 600);
  const callLog = new Map<string, number[]>();
  const rateOk = (tokenId: string): boolean => {
    const t = Date.now();
    const arr = (callLog.get(tokenId) ?? []).filter((x) => t - x < 60000);
    arr.push(t);
    callLog.set(tokenId, arr);
    return arr.length <= RATE_PER_MIN;
  };

  return async function handleMcp(
    req: http.IncomingMessage, res: http.ServerResponse,
  ): Promise<void> {
    const sendJson = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" || req.method === "DELETE") {
      // No server-initiated stream in this gateway.
      return sendJson(405, { jsonrpc: "2.0", error: { code: -32000, message: "method not allowed" }, id: null });
    }
    // ---- auth ----------------------------------------------------------
    const authz = req.headers.authorization ?? "";
    const bearer = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
    const tokenRow = bearer ? deps.db.tokenByHash(sha256(bearer)) : null;
    if (!tokenRow || tokenRow.revoked) {
      return sendJson(401, { jsonrpc: "2.0", error: { code: -32001, message: "unauthorized: valid MCP token required" }, id: null });
    }
    const token: TokenInfo = {
      id: tokenRow.id, name: tokenRow.name,
      scopes: tokenRow.scopes, computerId: tokenRow.computerId,
    };
    deps.db.touchToken(token.id);
    if (!rateOk(token.id)) {
      return sendJson(429, { jsonrpc: "2.0", error: { code: -32029, message: "rate limit exceeded for this token" }, id: null });
    }

    // ---- body ------------------------------------------------------------
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 2_000_000) return sendJson(413, { error: "request too large" });
      chunks.push(c as Buffer);
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return sendJson(400, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null });
    }
    const id = (msg.id ?? null) as unknown;
    const method = String(msg.method ?? "");
    if (id === null || method.startsWith("notifications/")) {
      res.writeHead(202);
      return res.end();
    }
    const rpcError = (code: number, message: string) =>
      sendJson(200, { jsonrpc: "2.0", error: { code, message }, id });
    const rpcResult = (result: unknown, headers: Record<string, string> = {}) =>
      sendJson(200, { jsonrpc: "2.0", result, id }, headers);

    const ctx: CallCtx = { db: deps.db, engine: deps.engine, sup: deps.sup, token, leases };

    try {
      switch (method) {
        case "initialize": {
          const params = (msg.params ?? {}) as { protocolVersion?: string };
          const version = params.protocolVersion && PROTOCOL_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion : "2025-03-26";
          return rpcResult({
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo: { name: "acp", version: "0.1.0" },
          }, { "mcp-session-id": crypto.randomBytes(16).toString("hex") });
        }
        case "ping":
          return rpcResult({});
        case "tools/list":
          return rpcResult({
            tools: TOOLS
              .filter((t) => hasScope(token, t.scope))
              .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          });
        case "tools/call": {
          const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const def = params.name ? toolByName.get(params.name) : undefined;
          if (!def) return rpcError(-32602, `unknown tool: ${params.name}`);
          if (!hasScope(token, def.scope)) {
            return rpcResult(errText(`this token lacks the '${def.scope}' scope required by ${def.name}`));
          }
          deps.db.audit(`mcp:${token.name}`, `mcp.call.${def.name}`, null,
            { tool: def.name, computer: params.arguments?.computer ?? token.computerId ?? null });
          try {
            const result = await def.run(ctx, params.arguments ?? {});
            return rpcResult(result);
          } catch (e) {
            return rpcResult(errText((e as Error).message));
          }
        }
        default:
          return rpcError(-32601, `method not found: ${method}`);
      }
    } catch (e) {
      return rpcError(-32603, (e as Error).message);
    }
  };
}
