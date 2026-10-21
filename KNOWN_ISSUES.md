# Current release blockers ? 2026-10-21

**Not production-ready.** See `PRODUCTION_AUDIT.md` and `RELEASE_CHECKLIST.md`.

- No Linux Docker runtime is available locally; SSH/remote access is prohibited by the user. Current branch Docker, desktop, cgroup, Compose, reboot and Coolify behavior is untested.
- Legacy containers and socket paths need an offline identity migration. They are intentionally not adopted based on labels. Do not upgrade existing installations blindly.
- Backup/restore scripts lack the new registry, integrity/path validation and consistent live-profile handling. Interrupted provisioning/deletion recovery remains incomplete.
- Effective CPU/cgroup quotas, swap telemetry, filesystem quota detection, resizing, measured presets and full resource usage history are unfinished. Host disk probe backing device is operator-selected.
- Single supervisor/installation only. Supervisor queue is process-local; fixed runtime/network names do not support multiple installations on one daemon.
- Guest-to-host/private-network isolation, filesystem symlink races, immediate input cancellation and throttling need further hardening.
- Browser binaries still occupy persisted home cache. Third-party notices and supply-chain audit remain incomplete. npm audit returned HTTP 503.
- Original Python Docker harnesses hardcode the previous VM paths and need portability work. Historical evidence below does not certify the current branch.

---

# KNOWN_ISSUES
- Dev VM is an nspawn container in a user namespace: no bridge networking, no cgroup controllers, vfs storage, dockerd cannot pull (Go TLS stalls via egress proxy). Workarounds live in tools/dev-vm/ and do NOT ship in the product; resource limits and bridge networking must be re-validated on a normal host.
- Guest image on this VM is built by chroot + `docker import` (docker build sandbox not permitted); `docker import` cannot set HEALTHCHECK — the Dockerfile carries it for normal hosts.
- OpenCode free models: DeepSeek V4.1 Flash Free rate-limited (2026-10-21); LongCat 2.5 Preview Free working.
- Sandbox blocks setns into container namespaces: `docker exec`, `--network container:` joins, and `--network host` all fail with EPERM despite full capabilities. On this VM the guest supervisor is reached via its Unix socket in the home volume; on normal hosts the control plane uses the container network. Product code must not depend on `docker exec`.
- `docker stats` returns 0 on this VM (no cgroup controllers delegated) — resource measurements must be taken on a normal host.
- Building the rootfs under the sandbox FS squashes the top directory's mode (2770) and some group ids; the import step must normalize `/` to 755 or non-root users in the guest get EACCES on every exec.
- Camoufox browser binaries (2.4 GB) live under /home/agent/.cache (the persisted home), so every computer's volume starts with a full copy. Revisit before Phase 5 (candidate: keep the browser cache in the image outside the volume path).
- Dev VM: explicit NetworkMode "none" breaks container start (dockerd libnetwork prestart hook re-executes the daemon via /proc/<pid>/exe, blocked by the sandbox). Supervisor omits NetworkMode when the configured network is "none" — same effective isolation. Normal hosts unaffected.
- Dev VM: no delegated cgroup controllers -> CPU/memory limits unenforceable and stats read 0; supervisor reports limitsEnforced=false instead of failing creates. Re-validate limits + stats on a normal Docker host (Phase 7 environment note).
