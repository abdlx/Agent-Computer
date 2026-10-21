# ARCHITECTURE

Agent Computer Platform (ACP): a self-hosted, single-owner platform that
gives a human and their AI agents persistent Linux desktops with a real
browser, reachable from a dashboard and over MCP.

Design provenance: `../agent-computer-research/AGENT_COMPUTER_RESEARCH.md`
(source-audited study of Screenbox, taw-computer, Webtop, Camoufox, noVNC).
No code was copied from AGPL sources; patterns were re-implemented.

## Components

```
┌────────────┐   HTTPS    ┌──────────────────┐  unix sock  ┌────────────────────┐
│ Dashboard  │ ─────────▶ │ Control plane     │ ──────────▶ │ Docker supervisor  │
│ (React)    │            │ (Node, SQLite)    │  secret hdr │ (Node, narrow API) │
└────────────┘            │  auth, CRUD,      │             └─────────┬──────────┘
                          │  lifecycle engine,│                       │ Docker
┌────────────┐  MCP/HTTP  │  MCP gateway,     │              Engine API (socket)
│ AI agents  │ ─────────▶ │  audit log        │                       │
│ (Hermes…)  │            └───┬───────────────┘                       ▼
└────────────┘                │ guest socket / TCP          ┌────────────────────┐
                              └───────────────────────────▶ │ Computer (Docker)  │
                                                            │ Debian + Xvnc +    │
                                                            │ Openbox + Camoufox │
                                                            │ + guest supervisor │
                                                            └────────────────────┘
```

### Docker supervisor (`supervisor/`)
The ONLY component that talks to Docker. Narrow POST API over a unix
socket, gated by a shared-secret header:
- Container/volume names are derived from the computer id server-side.
- Every operation re-verifies the container's identity (labels
  `acp.managed=true`, `acp.computer=<id>`, expected name) — it cannot be
  aimed at foreign containers.
- Create payloads are built from a fixed template. Callers choose only a
  display name and CPU/memory within validated ranges; unknown fields
  are rejected. Guests are never privileged, get a minimal capability
  set (CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID), `no-new-privileges`,
  and exactly one bind: their own home volume at `/home/agent`. The
  Docker socket is never mounted into a guest.
- If the host kernel rejects CPU/memory limits (sandboxed hosts without
  delegated cgroup controllers), create retries without limits and
  reports `limitsEnforced: false` — surfaced by the control plane,
  never silent.

### Control plane (`apps/control-plane/`)
Node (zero-dependency) + SQLite (`node:sqlite`, WAL, migrations).
- Auth: single owner. First-run setup creates the account (scrypt
  password hashing), then cookie sessions (opaque tokens, stored
  hashed, HttpOnly + SameSite=Strict). Login is rate-limited.
  Mutations additionally require an `x-acp-request: 1` header (CSRF
  guard). Logout invalidates the session server-side.
- Computers: CRUD + lifecycle via the engine and supervisor; delete
  requires typing the exact computer name; audit log records auth,
  lifecycle, and token events.
- Guest proxy: `/api/computers/:id/guest/*` forwards to the guest
  supervisor with the per-computer guest token, waking the computer
  first (wake-on-call).
- MCP tokens: scoped (`read`, `write`, `browser`, `files`, `admin`
  vocabulary), optionally bound to one computer, shown once, revocable.

### Lifecycle engine (`apps/control-plane/src/lifecycle.ts`)
Owns sleep/wake policy for every computer:
- **Leases**: short-lived (90 s TTL) claims by agent sessions/viewers;
  a live lease blocks sleep. Leases auto-expire.
- **Operation registry**: long work (downloads, batches) registers;
  active operations block sleep.
- **Idle evaluation**: ready + no leases + no ops + guest-reported last
  activity older than the idle timeout (default 300 s) → sleep.
- **Sleep** = graceful stop: the guest browser is closed first (profile
  flush), then `docker stop`. Never pause (RAM stays resident), never
  CRIU. Zero CPU/RAM while asleep; the home volume persists.
- **Wake** is single-flight per computer; any guest call wakes first.

State machine: `creating → starting → ready → idle → stopping →
sleeping → waking → ready`, plus `failed`, `unhealthy`, `deleting`,
`deleted`. On control-plane boot, states are reconciled against Docker
reality.

### Guest (`guest/`)
Debian bookworm-slim container: Xvnc (TigerVNC), Openbox + tint2 +
pcmanfm, Camoufox (Playwright, persistent profile under `/home/agent`),
noVNC/websockify bound to localhost only, and the guest supervisor
(Python): XTest input, Bézier/minimum-jerk trajectory mouse, window
management with root coordinates, screenshots, browser control
(snapshot refs by accessible name, fill/click/press/content), and
human/agent control arbitration — unissued pointer motion takes
control from the agent (agent input gets a 409) and returns it after
~3 s idle. The supervisor listens on TCP 8731 inside the container
network and on a unix socket in the home volume (the dev-VM channel);
when `GUEST_TOKEN` is set, every request needs `X-Guest-Token`.

### Persistence contract
- `/home/agent` (named volume): survives stop/start AND container
  recreation/image upgrade. Browser profile, files, user-installed
  tools live here.
- Container layer: survives stop/start only. System packages installed
  by hand are lost on recreation — documented, and pinned by a test.

## Trust boundaries
- Guests are untrusted workloads: no Docker socket, no host mounts, no
  privileged mode, network-isolated per deployment topology.
- The Docker socket is held by exactly one small service with a
  validating API; a control-plane compromise does not yield raw Docker
  access (only managed-computer operations).
- MCP tokens are scoped and per-computer; the dashboard session is a
  separate credential domain from MCP tokens and guest tokens.
- Docker containers are convenient isolation, NOT a hard security
  boundary equivalent to VMs; operators exposing ACP beyond their own
  use should read the deployment guide's security notes.

## Dev-VM notes (this build environment)
This sandbox blocks setns/`docker exec` and bridge networking, and
delegates no cgroup controllers. Consequences, all verified empirically:
guests are reached via the home-volume unix socket; CPU/RAM stats read
0; resource limits are accepted but reported `limitsEnforced: false`;
explicit `NetworkMode: "none"` triggers a dockerd libnetwork hook the
sandbox blocks, so the supervisor omits it. None of these change the
product design — they are environment adapters, and the Phase 7
clean-deployment run re-validates on the same footing.

## Security posture (Phase 6)

- **Passwords** are scrypt-hashed; session tokens and MCP tokens are
  stored only as SHA-256 hashes; MCP tokens carry 192 bits of entropy.
  Login failures are throttled per IP (5 per 5 minutes → 429) and both
  successful and failed logins are audit-logged.
- **Session cookies**: HttpOnly, SameSite=Strict, and `Secure` whenever
  the request arrived over HTTPS (direct TLS or `X-Forwarded-Proto`
  from a TLS-terminating proxy). Mutations additionally require the
  `x-acp-request: 1` header, blunting cross-site request forgery.
- **Response headers**: `nosniff`, `X-Frame-Options: DENY`, a CSP with
  `frame-ancestors 'none'`, and `Referrer-Policy: no-referrer` on both
  API and dashboard responses.
- **Supervisor secret** is compared in constant time; the supervisor
  and guest unix sockets are mode 0660; the control-plane database
  file is chmod 0600 (it holds the credential hashes).
- **MCP gateway**: per-token sliding-window rate limit
  (`ACP_MCP_RATE_PER_MIN`, default 600) on top of scope checks, token
  binding, and audit.
- **Guest confinement**: `/fs/*` resolves every path with `realpath`
  and refuses anything outside the home directory — traversal,
  absolute paths, and symlink escapes are all rejected (fuzz-tested).
  Request bodies are capped at every layer (CP 1 MB, MCP 2 MB, guest
  8 MB) and a single `/fs/write` is capped at 5 MB. The guest's TCP
  supervisor port binds loopback only (HEALTHCHECK); the platform
  path is the unix socket. Validation errors are 400s, not 500s.
- **Dependencies**: the shipped runtime (control plane, supervisor,
  MCP gateway) has **zero npm dependencies** — Node built-ins only.
  npm packages exist solely in the dashboard build toolchain
  (react/vite/noVNC) and the test client; guest binaries are Debian
  packages plus version-pinned Playwright/Camoufox. (`npm audit`
  could not be run from the development sandbox — its registry proxy
  denies the audit endpoint — so the audit step belongs in CI/release,
  and the zero-runtime-dependency posture keeps the shipped surface
  minimal in the meantime.)
