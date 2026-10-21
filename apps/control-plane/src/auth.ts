/**
 * Owner authentication: scrypt password hashing, opaque session tokens
 * (stored hashed), HttpOnly cookies. Single-owner product, but the
 * primitives are the real ones — no plaintext passwords, no session ids
 * in storage, constant-time comparisons.
 */
import * as crypto from "node:crypto";

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

export function newSessionToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, hash: sha256(token) };
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function newMcpToken(): { token: string; hash: string } {
  const token = `acp_${crypto.randomBytes(24).toString("base64url")}`;
  return { token, hash: sha256(token) };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = rest.join("=");
  }
  return out;
}

export function sessionCookie(token: string, maxAgeS: number, secure = false): string {
  // Secure is set when the request arrived over HTTPS (directly or via a
  // TLS-terminating proxy), so local plain-HTTP development still works
  // while production-behind-TLS gets a transport-bound cookie.
  return `acp_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(): string {
  return "acp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}
