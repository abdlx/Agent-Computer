# Deployment ? hardening development branch

**Not production-ready.** Fresh Linux Docker/Compose deployment has not been run for this branch. No SSH or remote operations are authorized in the current session. See `RELEASE_CHECKLIST.md` for release gates and `BACKUP_RESTORE.md` before touching an existing installation.

## Fresh disposable Linux test installation

Requires a local Linux Docker Engine 24+ with Compose v2, working CPU/memory cgroups, sufficient disk/RAM and outbound build access. Windows native Node tests do not validate this deployment. ARM64 images are unverified. Only one supervisor instance is supported.

```bash
cp .env.example .env
# Set ACP_SUPERVISOR_SECRET to the output of:
openssl rand -hex 32
# Adjust ACP_HOST_RESERVE_MB, ACP_MAX_RUNNING, ACP_CPU_OVERCOMMIT for the host in .env if needed.
# The compose stack automatically provisions the dedicated acp-storage-probe named volume.
docker compose config --quiet
docker compose --profile build build guest-image
docker compose build supervisor
docker compose up -d
```

The disk capacity probe uses a dedicated named volume `acp-storage-probe` located on the Docker data root filesystem. It is mounted read-only and visible only to the supervisor. Automatic backing-device verification remains a release blocker.

Open `http://127.0.0.1:8787`, create the owner, and inspect host resource capacity before creating a computer. A computer requires enough uncommitted and currently available memory **after** the host reserve. Requests are refused when Docker controls or host measurements are unavailable. CPU/memory limits cannot be disabled as an environment workaround.

## Trust boundaries

Only the supervisor receives `/var/run/docker.sock`. Its registry is in `acp-supervisor-data`, never mounted into the control plane. Both supervisor and control plane see `acp-run`, read-only in the control plane. Each guest receives only its generated subdirectory of that volume and its own home volume. No service mounts `/var/lib/docker/volumes`.

The fixed runtime volume `agentcomputer_acp-run` and fixed guest network `agentcomputer_guests` currently restrict deployment to one installation per Docker daemon. Do not run multiple copies against these resources.

Docker shares the host kernel; it does not provide VM-equivalent isolation. Guest-to-host/private-network isolation remains under review. Keep this branch on a disposable development host.

## HTTPS proxy

Keep the direct dashboard binding on loopback. Configure your own TLS reverse proxy, for example Caddy:

```caddy
computers.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Set `ACP_PUBLIC_ORIGIN=https://computers.example.com`. Set `ACP_TRUST_PROXY=true` only when direct access is restricted to your trusted proxy, which must overwrite forwarded headers. WebSocket upgrade support is required for `/api/computers/*/vnc`. Browser Origins must match the configured origin. TLS cookies and proxy WebSockets still require real deployment testing.

## Verification required

Verify guest readiness, real desktop/RFB handshake, shared browser, authenticated external MCP/Hermes, token revocation, sleep/wake, Docker inspect and actual cgroup CPU/RAM/swap/PID limits, concurrent admission, reboot reconciliation and the complete persistence/restore contract. `GET /api/health` is only liveness; authenticated `/api/ready` checks supervisor/resource availability. Neither is release certification.

## Existing installations / upgrades

Do not apply this Compose change to an existing deployment without a verified offline backup and an identity migration plan. The new supervisor intentionally refuses unregistered legacy containers even when their names/labels match. Old stored guest socket paths also require migration. Automated migration and restore tooling are not complete. Existing volumes must not be deleted or automatically adopted to bypass this boundary.

Coolify: see `COOLIFY.md`; untested, not one-click validated. Hard disk quotas are unsupported. Legacy `diskGb` metadata is not allocation enforcement.

## Local developer verification

```powershell
node --test tests/resource_scheduler.test.mjs tests/supervisor_security.test.mjs tests/security_boundaries.test.mjs
node tests/engine_races.mjs
python guest/supervisor/trajectory.py
cd apps/dashboard
npm ci --no-fund
npm run build
npm audit --json
```

The supervisor tests use a fake Docker daemon and cannot prove Linux enforcement. The historical Phase 0?7 Python harnesses still need environment portability work. Security audit registry failure is not a clean result.
