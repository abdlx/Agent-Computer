/**
 * Control-plane database: SQLite (Node built-in), schema migrations,
 * and the small repository functions the API uses. Single-owner product:
 * one database file on the host volume.
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export interface User {
  id: number;
  username: string;
  pwHash: string;
  createdAt: number;
}

export interface ComputerRow {
  id: string;
  name: string;
  container: string;
  volume: string;
  socketPath: string;
  guestToken: string;
  state: string;
  cpuMillis: number;
  memoryMb: number;
  diskGb: number;
  limitsEnforced: boolean | null;
  createdAt: number;
  updatedAt: number;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  computerId: string | null;
  detail: string;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT UNIQUE NOT NULL,
     pw_hash TEXT NOT NULL,
     created_at INTEGER NOT NULL);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id),
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL);
   CREATE TABLE computers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     container TEXT NOT NULL,
     volume TEXT NOT NULL,
     socket_path TEXT NOT NULL,
     guest_token TEXT NOT NULL,
     state TEXT NOT NULL,
     cpu_millis INTEGER NOT NULL,
     memory_mb INTEGER NOT NULL,
     disk_gb INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL);
   CREATE TABLE mcp_tokens (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL,
     scopes TEXT NOT NULL,
     computer_id TEXT,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER,
     revoked INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ts INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     computer_id TEXT,
     detail TEXT NOT NULL DEFAULT '{}');
   CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
   CREATE TABLE engine_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);`,
  // v2: remember whether the host enforced this computer's CPU/RAM
  // limits at creation, so the UI can stay honest after restarts.
  `ALTER TABLE computers ADD COLUMN limits_enforced INTEGER;`,
  // Database-level singleton ownership holds across multiple server processes.
  `CREATE TRIGGER one_owner BEFORE INSERT ON users
   WHEN (SELECT COUNT(*) FROM users) >= 1
   BEGIN SELECT RAISE(ABORT, 'setup already completed'); END;`,
];

export class Db {
  private db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT v FROM schema_version LIMIT 1").get() as { v: number } | undefined;
    let v = row?.v ?? 0;
    if (!row) this.db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
    while (v < MIGRATIONS.length) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v]);
        v += 1;
        this.db.prepare("UPDATE schema_version SET v = ?").run(v);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  // ---- users & sessions -----------------------------------------------------
  userCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }
  createUser(username: string, pwHash: string): User {
    const info = this.db.prepare(
      "INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)")
      .run(username, pwHash, Date.now());
    return { id: Number(info.lastInsertRowid), username, pwHash, createdAt: Date.now() };
  }
  userByName(username: string): User | null {
    const r = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
      { id: number; username: string; pw_hash: string; created_at: number } | undefined;
    return r ? { id: r.id, username: r.username, pwHash: r.pw_hash, createdAt: r.created_at } : null;
  }
  createSession(tokenHash: string, userId: number, ttlMs: number): void {
    const t = Date.now();
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, userId, t, t + ttlMs);
  }
  sessionUser(tokenHash: string): User | null {
    const r = this.db.prepare(
      `SELECT u.id, u.username, u.pw_hash, u.created_at FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash, Date.now()) as
      { id: number; username: string; pw_hash: string; created_at: number } | undefined;
    return r ? { id: r.id, username: r.username, pwHash: r.pw_hash, createdAt: r.created_at } : null;
  }
  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  // ---- computers --------------------------------------------------------------
  private rowToComputer(r: Record<string, unknown>): ComputerRow {
    return {
      id: String(r.id), name: String(r.name), container: String(r.container),
      volume: String(r.volume), socketPath: String(r.socket_path),
      guestToken: String(r.guest_token), state: String(r.state),
      cpuMillis: Number(r.cpu_millis), memoryMb: Number(r.memory_mb),
      diskGb: Number(r.disk_gb),
      limitsEnforced: r.limits_enforced == null ? null : Number(r.limits_enforced) === 1,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
  insertComputer(c: ComputerRow): void {
    this.db.prepare(
      `INSERT INTO computers (id, name, container, volume, socket_path, guest_token,
        state, cpu_millis, memory_mb, disk_gb, limits_enforced, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.id, c.name, c.container, c.volume, c.socketPath, c.guestToken, c.state,
           c.cpuMillis, c.memoryMb, c.diskGb,
           c.limitsEnforced == null ? null : c.limitsEnforced ? 1 : 0,
           c.createdAt, c.updatedAt);
  }
  computer(id: string): ComputerRow | null {
    const r = this.db.prepare("SELECT * FROM computers WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    return r ? this.rowToComputer(r) : null;
  }
  computers(): ComputerRow[] {
    return (this.db.prepare("SELECT * FROM computers ORDER BY created_at").all() as
      Record<string, unknown>[]).map((r) => this.rowToComputer(r));
  }
  setComputerState(id: string, state: string): void {
    this.db.prepare("UPDATE computers SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, Date.now(), id);
  }
  deleteComputer(id: string): void {
    this.db.prepare("DELETE FROM computers WHERE id = ?").run(id);
  }

  // ---- mcp tokens (used by Phase 2) -------------------------------------------
  insertToken(t: { id: string; name: string; tokenHash: string; scopes: string[]; computerId: string | null }): void {
    this.db.prepare(
      "INSERT INTO mcp_tokens (id, name, token_hash, scopes, computer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(t.id, t.name, t.tokenHash, JSON.stringify(t.scopes), t.computerId, Date.now());
  }
  tokenByHash(hash: string): { id: string; name: string; scopes: string[]; computerId: string | null; revoked: boolean } | null {
    const r = this.db.prepare("SELECT * FROM mcp_tokens WHERE token_hash = ?").get(hash) as
      Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: String(r.id), name: String(r.name), scopes: JSON.parse(String(r.scopes)),
      computerId: r.computer_id ? String(r.computer_id) : null,
      revoked: Number(r.revoked) === 1,
    };
  }
  tokens(): Record<string, unknown>[] {
    return (this.db.prepare(
      "SELECT id, name, scopes, computer_id, created_at, last_used_at, revoked FROM mcp_tokens ORDER BY created_at")
      .all() as Record<string, unknown>[]).map((r) => ({
        ...r, scopes: JSON.parse(String(r.scopes)),
      }));
  }
  revokeToken(id: string): void {
    this.db.prepare("UPDATE mcp_tokens SET revoked = 1 WHERE id = ?").run(id);
  }
  touchToken(id: string): void {
    this.db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
  }

  // ---- audit -------------------------------------------------------------------
  audit(actor: string, action: string, computerId: string | null, detail: unknown = {}): void {
    this.db.prepare("INSERT INTO audit (ts, actor, action, computer_id, detail) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), actor, action, computerId, JSON.stringify(detail));
  }
  auditLog(limit = 100): AuditRow[] {
    return (this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as
      Record<string, unknown>[]).map((r) => ({
        id: Number(r.id), ts: Number(r.ts), actor: String(r.actor),
        action: String(r.action),
        computerId: r.computer_id ? String(r.computer_id) : null,
        detail: String(r.detail),
      }));
  }

  // ---- engine state --------------------------------------------------------------
  engineState(): string | null {
    const r = this.db.prepare("SELECT json FROM engine_state WHERE id = 1").get() as
      { json: string } | undefined;
    return r?.json ?? null;
  }
  setEngineState(json: string): void {
    this.db.prepare(
      "INSERT INTO engine_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(json);
  }
}
