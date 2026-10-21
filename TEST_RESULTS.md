# Current hardening checkpoint ? 2026-10-21

Release verdict: **NOT PRODUCTION READY**. Windows local testing only. No Docker executable/Linux WSL distribution is available. User explicitly forbids SSH or remote hosts. Historical results below are retained but do not validate this branch.

Environment: Windows PowerShell, Node v25.3.0, Python 3.12.10. Branch `production-hardening`.

| Command | Observed result | Scope / limits |
| --- | --- | --- |
| `node --test tests/control_plane_http.test.mjs tests/resource_scheduler.test.mjs tests/supervisor_security.test.mjs tests/security_boundaries.test.mjs` | 17/17 pass | Real HTTP control-plane/SQLite/session/token flow, real supervisor against fake Docker, policy/ownership/security/lifecycle unit tests; no real guest |
| `node tests/engine_races.mjs` | 13 checks pass | Fake driver and real local HTTP socket; original Linux-only socket changed to portable named pipe on Windows |
| `python guest/supervisor/trajectory.py` | PASS | Existing cursor trajectory self-test |
| `node --check` for all control-plane/supervisor TypeScript files | Pass | Syntax only; not TypeScript type checking |
| `python -m py_compile guest/supervisor/supervisor.py guest/supervisor/browser_owner.py guest/supervisor/trajectory.py` | Pass | Syntax only; no X11 or browser execution |
| `npm ci --no-fund` in `apps/dashboard` | Pass, 63 packages installed | Dependency install, not vulnerability clearance |
| `npm run build` in `apps/dashboard` | Pass, 183 transformed modules | Production build; no visual/browser E2E proof |
| `npm audit --json` in `apps/dashboard` | FAILED: registry HTTP 503 | Vulnerability status unresolved |
| `git diff --check` | Pass | Patch whitespace validation |

The first baseline race-suite attempt failed with Windows EACCES on `/tmp/acp-race-guest.sock`. Only the test transport path was made platform-specific; original assertions were retained and all now pass. New tests cover malformed supervisor requests, forged IDs with valid-looking labels, foreign containers, unsupported resource controls, volume-identity rejection before deletion, and serialized competing starts. HTTP integration covers concurrent first-run requests (one success, two 409s), unauthorized requests, CSRF, foreign Origin, resource/readiness endpoints, token mint/revoke and logout invalidation.

Not run: historical Phase 0?7 Docker suites (hardcoded previous VM paths and Docker prerequisites), actual Linux cgroup enforcement, guest mount/network inspection, VNC shared desktop, Hermes, image build/scan, backups/restores, reboot/fault injection, Coolify and resource benchmarks. No release gate is inferred from fake-Docker tests.

Evidence summary: `tests/evidence/production-local-checkpoint.json`. Reproduce the commands above; benchmark and per-gate gaps are in `BENCHMARKS.md` and `RELEASE_CHECKLIST.md`.

---

## Historical results (superseded as release certification)

# TEST_RESULTS
Measured results only. Environment recorded per run.

## 2026-10-21 — guest trajectory module

- Command: `python3 guest/supervisor/trajectory.py`
- Result: PASS (the module's assertions cover precise/natural endpoints, monotonic timestamps, ~120 Hz sample count, seeded reproducibility, duration clamps, minimum-jerk endpoints, and drag contract).
- Scope: pure-Python unit test on the host; it does not yet prove X11/XTest integration inside the guest.

## 2026-10-21 — Phase 0 guest bring-up (dev VM: nspawn userns, crun, overlay2 on /home/hatch)

Environment caveats: no bridge networking, no cgroup controllers (resource
limits + `docker stats` not measurable here), setns into containers blocked
by the sandbox (no `docker exec`, no netns join) — the guest supervisor is
reached over its Unix socket in the home volume
(`/home/hatch/docker-data/volumes/guest1-home/_data/.supervisor/api.sock`).

- Image `agentcomputer/guest:phase0`: 3.89 GB (Debian bookworm-slim base;
  includes Camoufox 156.0.1-beta.36 browser cache, 2.4 GB, under /home/agent).
- Boot: entrypoint reports "guest ready" ~3 s after supervisord start;
  container stays up (earlier exits were two real bugs, both fixed:
  image root dir mode squashed to 2770 by the sandbox FS -> non-root EACCES
  on every exec; entrypoint `wait` returning because supervisord daemonized
  -> now `--nodaemon` + `wait $SUP_PID`).
- GET /health via Unix socket: ok, display :0, 1280x800, cursor (640,400),
  control owner=agent, browser_engine=camoufox.
- GET /screenshot: valid PNG 1280x800 (evidence: tests/evidence/phase0-desktop.png;
  320 distinct colors with tint2 panel + pcmanfm desktop windows present).
- GET /windows at boot: tint2 panel + pcmanfm desktop (openbox-session runs
  the autostart; bare `openbox` did not).
- POST /launch {terminal, files}: xterm and pcmanfm windows appear with real
  geometry.
- Input smoke: POST /input/move (natural) -> /cursor confirms (300,300);
  click focuses xterm; POST /input/type 50 chars incl. punctuation (after the
  keysym-name fix: '-' etc. now map via _CHAR_KEYSYMS, xdotool fallback);
  POST /input/key Return executes; the guest shell wrote
  "hello-from-supervisor" to ~/smoke.txt, read back via the volume.
- GET /selftest/desktop: X ok, websockify HTTP 200, WebSocket upgrade 101,
  VNC banner "RFB 003.008" read through the tunnel — the noVNC viewer path
  works end to end inside the guest (host-side authenticated proxy is the
  Phase 1/3 component).
- NOT measured here: idle RAM / CPU (cgroup stats unavailable on this VM),
  bridge-network reachability, resource-limit enforcement. Re-validate on a
  normal host.

## 2026-10-21 — Phase 0 browser + arbitration (same dev-VM environment)

- Browser owner rewritten on Playwright's ASYNC API (Camoufox 0.5.8's sync
  wrapper internally runs an asyncio loop and breaks with a separate
  sync_playwright start: "Sync API inside the asyncio loop"). The owner
  thread runs its own event loop; the supervisor-facing API is unchanged.
- POST /browser/start {camoufox}: running in ~16 s, profile
  ~/.camoufox-profile (persistent, in the home volume).
- Desktop focus race found and fixed as a product feature: POST
  /windows/focus (EWMH _NET_ACTIVE_WINDOW + set_input_focus); GET /windows
  now reports the active window. (Before this, API typing could land in
  whichever window happened to be on top.)
- In-guest HTTP origin for tests: python3 -m http.server on 127.0.0.1:8123
  serving ~/browser-test.html (Camoufox denies file:// navigation from a
  non-file origin: NS_ERROR_FILE_ACCESS_DENIED).
- Snapshot parser fix: leaf ARIA nodes have no trailing colon; refs are now
  parsed by regex. Result on the test page: e1 textbox "Your name",
  e2 button "Submit form", e3 link "Click this link".
- Agent leg: fill e1 "Ada Lovelace" -> click e2 -> page reads
  "submitted:Ada Lovelace"; click e3 -> "link-clicked" (via /browser/content).
- Human leg (same instance): raw XTest move+click on the VISIBLE window's
  link at (53,261) -> /browser/content reads "link-clicked". The agent and
  the human share one browser instance, one profile.
  Evidence: tests/evidence/phase0-browser-page.png (Camoufox window on the
  guest desktop showing the test page).
- Arbitration race found and fixed: position-matching in the human watcher
  could misattribute agent trajectory motion as human under CPU load (the
  agent's follow-up click got a spurious 409). Replaced with an explicit
  agent-motion window (mark-before-flush in warp(), planned-duration
  window in move_to()). Verified after the fix: the identical move+click
  sequence succeeds.
- Takeover (test 16 substance): unissued pointer motion (xdotool from a
  guest shell — the same X signal a VNC human produces) flips control to
  human/pointer-activity; agent input is rejected 409; after ~3.4 s idle
  control returns (human-idle) and agent input succeeds.
- Build-environment contamination (dev VM only): files created under the
  sandbox's umask 0007 land mode 660/770 in the image; a chmod a+rX pass
  over the pip tree + umask 022 in finish-build.sh fixes it. Do NOT use
  `docker cp` to hot-patch code into a running guest (ownership/mode
  squash + the supervisor caches the import error); rebuild the image.

## 2026-10-21 — Phase 0 battery: 18/18 PASS (tests/phase0_battery.py)

Full report: tests/evidence/phase0-battery-report.json (single run, fresh
container, ~75 s). Highlights beyond the earlier incremental proofs:
- Lifecycle engine (apps/control-plane/src/lifecycle.ts, Node, zero deps):
  activity leases (90 s TTL) and the operation registry each independently
  block idle sleep; idle past timeout -> graceful stop (browser close
  first, then docker stop -t 20); wake-on-call returns guest health;
  8-way concurrent wake is single-flight (all callers ready, one start).
- Drag: xterm moved exactly (+150,+100) by its title bar via the
  trajectory drag endpoint.
- Smooth cursor: 18 distinct positions sampled during one natural move,
  progressive approach, exact endpoint.
- Human browser control is aimed VISUALLY in the battery (link located
  by its blue pixels in a screenshot) — window geometry varies between
  runs because the browser restores window state from its profile.
- Persistence contract pinned by test 12: /home/agent survives
  recreation; container-layer files survive stop/start but NOT recreation.
- Battery bugs fixed along the way (kept honest): snapshot refs must be
  selected by accessible NAME (a page can have several buttons); cursor
  sampling needs an authoritative final read; the drag target window
  must be raised first.

## 2026-10-21 — supervisor fix: /windows reports ROOT coordinates

list_windows used get_geometry() (parent-relative: a centered xterm
reported (1,20)). Callers aiming input from those numbers pressed the
wrong place. translate_coords() under Xvnc returned sign-flipped
values (-278,-174 for a window at (278,174)), so positions are now
computed by walking the parent chain. Verified: reported position
matches the rendered desktop, and the window-drag test passes.

## 2026-10-21 — Phase 1 control plane: 32/32 API tests PASS (tests/phase1_api_test.py)

Spawns the real Docker supervisor + control plane with throwaway state and
drives the HTTP API: setup gating (short password 400, second setup 409),
unauthenticated 401, CSRF header guard 403, computer create -> ready
through the supervisor, guest proxy (health/input/cursor with guest
token), stats shape, sleep/stop/start via API, wake-on-call through the
guest proxy, token create/list/revoke (secret shown once, never listed),
audit coverage, typed-name delete (container + volume actually gone),
logout invalidating the session server-side, wrong-password 401, login.
Supervisor abuse cases pass: wrong secret 401; create payloads carrying
`Privileged` or a caller-chosen `image` rejected 400; foreign-container
targeting impossible (names derived server-side + label identity check);
created containers verified not privileged.

Bugs found and fixed during Phase 1:
- Node's HTTP client sends chunked request bodies by default; the
  guest's Python http.server cannot read them, so every Node->guest POST
  failed with a response parse error (GETs worked, hiding it; the
  engine's graceful browser-close had silently failed through this path
  too — its error was caught and ignored). guestCall now always sets
  Content-Length.
- Explicit `NetworkMode: "none"` in a create payload makes dockerd run
  a libnetwork prestart hook that re-executes the daemon binary
  (/proc/<dockerd-pid>/exe); this sandbox blocks it and EVERY start
  failed with "error executing hook". Omitting NetworkMode yields the
  same no-network container through the normal path. The supervisor now
  omits it when the configured network is "none".
- The dev-VM kernel rejects NanoCpus ("kernel does not support CPU CFS
  scheduler") because no cgroup controllers are delegated. The
  supervisor retries create once without limits ONLY on that explicit
  error and returns limitsEnforced=false; the control plane surfaces it
  in the create response and audit log (`computer.limits_unenforced`).
  On normal hosts limits are enforced and this path never triggers.
- Token list endpoint returned scopes as a raw JSON string; now parsed.

## 2026-10-21 — Phase 2 MCP gateway: 21/21 PASS (tests/phase2_mcp_test.py)

Validation client is the OFFICIAL MCP TypeScript SDK 1.32.1
(StreamableHTTPClientTransport), connecting the way a real agent would.
Full scenario passes end to end: computer_list -> fs_write a page ->
terminal_exec serves it over HTTP -> browser_start/navigate/snapshot ->
fill + click -> page reads "revealed:s3cret"; screenshot returns a real
image content block; mouse_move lands the cursor exactly; a batch
(focus + type + key) writes a file verified through fs_read; fs_delete
verified by a failing read. Scope enforcement: a read-only token's
tools/list contains only the 5 read tools, keyboard_type returns a
scope error, screenshot still works. Binding: a computer-bound token is
refused for any other computer. Wake-on-call: after an API sleep, an
MCP screenshot wakes the computer and succeeds. Auth: missing/bogus/
revoked tokens -> 401. MCP calls are audit-logged.

Guest additions for this phase: /exec (login-shell command as the
computer's user, timeout + output caps) and /fs/list|read|write|mkdir|
delete, with paths confined to the home directory by realpath prefix
check. These are activity (they hold the computer awake through the
gateway's rolling lease) but are not desktop input, so they are not
blocked by human takeover arbitration.

Regressions after the Phase 2 changes: Phase 1 suite 32/32, Phase 0
battery 18/18.

## 2026-10-21 — Phase 3 dashboard: 10/10 PASS (tests/phase3_dashboard_test.py)

React + Vite dashboard (apps/dashboard, built bundle served by the
control plane with SPA fallback): first-run owner setup, sign-in,
computers grid (live state polling, create with CPU/RAM/disk choices,
sleep/wake, typed-name delete), workspace, agents, audit.

The embedded desktop works end to end and was verified at the byte
level: a session-cookie-authenticated WebSocket upgrade to
/api/computers/:id/vnc passes the control-plane proxy -> guest unix
socket -> guest /vnc bridge -> websockify -> Xvnc and streams a real
"RFB 003.008" frame. Unauthenticated upgrades get 401. Connecting to a
sleeping computer wakes it first and holds an owner presence lease for
the connection's lifetime (renewed every 30s), so a computer never
sleeps under its watching owner. Desktop connections are audited
(computer.vnc_open).

Supporting guest change: Xvnc now runs -SecurityTypes None -localhost —
VNC is reachable only from inside the guest, where websockify is the
sole consumer and websockify itself is reached only through this
authenticated chain; a random per-boot VNC password the owner could
never see would have been friction, not security. The guest gained a
/vnc bridge endpoint in its supervisor for the same reason.

Regressions: Phase 0 battery 18/18, Phase 1 32/32, Phase 2 21/21.

## 2026-10-21 — Phase 4 hardening: API 13/13 + engine races 12/12

tests/phase4_hardening_test.py: control-plane restart reconciles a
running computer to ready and reachable; supervisor restart is
transparent (stateless); a CP restart after the container was deleted
externally reports the computer honestly as "failed"; a hand-built v1
database migrates in place to v2 and serves; a live lease holds a
computer awake and, once it lapses, the idle engine sleeps it; the
supervisor's host-disk guard (ACP_MIN_FREE_DISK_GB, default 5) refuses
creation with a clear 507 and leaves nothing half-created.

tests/engine_races.mjs (fake driver + fake guest, no Docker): wake
issued during an in-flight sleep is serialized behind the stop and
then really starts the computer (1 stop, 1 start, final state ready,
container running); call() during a sleep waits out the transition;
concurrent sleeps single-flight; wake on a deleting computer is
refused; leases and operations each block idle sleep and release it
when they end.

Fixes this phase: lifecycle transitions are serialized per computer
(a promise chain in the engine); engine.call() waits out transitional
states and registers an operation for the call's duration, so idle
sleep can never land mid-call in any code path; limitsEnforced is now
persisted (schema v2) and shown in the API and on dashboard cards;
dashboard tick interval is configurable (ACP_TICK_MS).

Regressions: Phase 0 18/18, Phase 1 32/32, Phase 2 21/21, Phase 3 10/10.

## 2026-10-21 — Phase 5 deployment: smoke 10/11 (1 sandbox-blocked)

Deliverables: docker-compose.yml (supervisor + control-plane +
build-only guest-image profile, guests bridge network, identity mount
of the Docker volumes directory, localhost-only dashboard port),
deploy/Dockerfile (multi-stage platform image: dashboard build + node
runtime), .env.example, ops/backup.sh + ops/restore.sh, DEPLOYMENT.md
(quick start, wiring rationale, backup/restore, updating, honest
Coolify + validation-status sections), guest Dockerfile dependency
pins (playwright 1.62.0 / camoufox 0.5.8).

Validation performed here: `docker compose config` renders cleanly;
the platform image was built by executing the Dockerfile's steps
(chroot assembly on this sandbox, which cannot run docker build) and
the stack ran as containers: the containerized supervisor created,
started, inspected, stopped and removed a real guest computer, and
its guest supervisor answered healthy through the volume socket;
the containerized control plane booted and initialized a v2 database
in its data volume. The one non-pass is environmental: this sandbox's
containers are loopback-only, so the CP's published TCP port is
unreachable from the host — the check records that with its evidence
instead of passing silently (the API itself is covered by Phases 1–4
against the same code).

Bug found by this phase's test and fixed: the guest supervisor
required its token for /health, which silently broke the guest
image's Docker HEALTHCHECK (a plain curl). /health is now public
(liveness only); every other endpoint still requires the token.
Regressions: Phase 0 battery 18/18, Phase 1 32/32.

## 2026-10-21 — Phase 6 security: 21/21 PASS (tests/phase6_security_test.py)

Verified: session cookie is HttpOnly + SameSite=Strict, gains `Secure`
when the request arrives via a TLS proxy (X-Forwarded-Proto), and
stays usable over local plain HTTP; API and dashboard responses carry
nosniff / X-Frame-Options DENY / CSP(frame-ancestors 'none') /
no-referrer; token creation rejects unknown and empty scope lists;
the MCP gateway rate-limits per token (12/min configured for the run:
exactly 12 successes, then 429s); login throttling trips to 429 after
5 failures while the stack stays healthy.

Guest confinement fuzzing through the owner API: ../../etc/passwd and
absolute /etc/passwd reads refused, ../ writes refused, a planted
symlink (~/evil-link -> /etc) refuses both reads and writes through
it, and an in-guest check confirms nothing was written outside the
home. Oversized writes are refused by the layered body caps.

Hardening applied this phase: conditional Secure cookie; security
headers everywhere; scope allowlist validation; constant-time
supervisor-secret comparison; 0660 socket permissions (supervisor +
guest); 0600 database file; per-token MCP rate limiting
(ACP_MCP_RATE_PER_MIN, default 600); guest request-body cap (8 MB)
and per-write cap (5 MB); guest TCP supervisor port bound to loopback
only; guest validation errors return 400; crash handlers log and exit
cleanly for orchestrated restart in both Node services.

Dependency review: the shipped runtime has zero npm dependencies
(Node built-ins only). Dashboard build toolchain and the MCP test
client hold the only npm packages (react/vite/noVNC; the official MCP
SDK in tests). npm audit itself is policy-blocked by this sandbox's
registry proxy and is noted as a CI/release step in ARCHITECTURE.md.

Regressions: Phase 0 18/18, Phase 1 32/32, Phase 2 21/21, Phase 3
10/10, Phase 4 13/13.

## 2026-10-21 — Phase 7 end-to-end journey: 24/24 PASS (tests/phase7_e2e_test.py)

One fresh stack runs the whole product story: deployment boots with
setup open → dashboard served → owner created (setup then 409s) →
logout/login round trip → computer A ready → live desktop completes
a real RFB handshake through the authenticated proxy → MCP gateway
accepts the agent → **the official MCP SDK client completes a real
task** (write page → serve it from the guest terminal → browse →
snapshot → fill → submit → revealed state → batch tools → screenshot
image block) → computer B joins → **isolation**: B cannot read A's
files and a token bound to A is refused for B → **human takeover**:
pointer motion sent over the real RFB connection seizes control
(agent input gets 409 human_control) and auto-releases when the human
goes idle → sleep stops the container → **an MCP call wakes it** →
files and the browser profile survive the cycle → **auto-sleep** on
idleness (45s configured for the run; shipped default 300s) → the
platform services restart and state reconciles (B wakes clean, A
stays asleep) → **backup & restore** rolls a marker file and the
token table back exactly (post-backup token: 401; pre-backup: 200) →
both computers delete with container+volume verifiably gone → the
audit log covers the journey → teardown leaves nothing behind.

Run notes: the journey stack sets ACP_IDLE_TIMEOUT_S=45/TICK 5s so
auto-sleep is observable; the first attempt also exposed two
test-harness bugs (an RFB SecurityResult message and a /tmp tmpfs
too small for the backup tar) — both fixed in the harness, and the
guest gained proper 404s for missing files in the process.
Backup/restore here exercises the same artifacts ops/backup.sh
produces (database copy + volume tar); the compose-shaped scripts
themselves are covered by the Phase 5 container evidence.

## Definition-of-Done sweep (2026-10-21)

Proven with running code in this environment:
- Deploy → account → computer → agent (official MCP SDK) → task
  completes; human and agent share one desktop/cursor/browser with
  working takeover both directions (Phases 0, 2, 3, 7).
- Persistent browser profile and files across recreation, sleep and
  wake; auto-sleep; wake on dashboard, API and MCP use (0, 1, 7).
- Multi-computer isolation: files, tokens, desktops (7).
- Restricted Docker supervisor: a compromised control plane cannot
  create arbitrary containers (payload + identity checks, abuse
  cases in Phase 1).
- Security posture fuzzed: confinement, throttling, headers, cookie
  flags, rate limits (6). Restart recovery (4, 7). Backup/restore
  round trip (7). Typed-confirmation deletion really removes
  container + volume (1, 7).
- Hermes-class agents: the gateway is standard MCP Streamable HTTP
  and passes with the protocol's official SDK client; Hermes itself
  was not run here (no Hermes install in this sandbox) — the
  dashboard emits a ready-to-paste config for it.

Not validatable in this sandbox (stated, not hidden):
- Production `docker compose up` networking: guests on the bridge
  network and the published dashboard port — sandbox containers are
  loopback-only. The identical services ran containerized in
  Phase 5; only host→container published-port reachability and
  guest bridge egress await a normal host.
- CPU/RAM limit enforcement (no cgroup controllers here); the
  platform reports `limitsEnforced` truthfully per computer.
- Coolify: not validated as one-click; DEPLOYMENT.md lists exactly
  what a Coolify deploy must preserve.
