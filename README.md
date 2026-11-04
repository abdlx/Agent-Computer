<div align="center">
  <img src="assets/logo.png" alt="Agent Computer Logo" width="130" height="130" />
  <h1>Agent Computer</h1>
  <p><strong>Self-hosted, persistent Linux desktops for AI agents and human operators.</strong></p>
  <p><code>Deploy</code> → <code>Create owner</code> → <code>Create computer</code> → <code>Connect agent over MCP</code> → <code>Work in the same desktop</code></p>
</div>

---

## What it does

Agent Computer is a single-owner management platform that provisions persistent Linux desktop computers as isolated Docker containers. AI agents operate through authenticated MCP tools; humans can view and interact with the live desktop through the dashboard's noVNC viewer. Browsers, files, and workspace data persist across normal container stop/start cycles.

- **Desktop and browser:** TigerVNC/Xvnc, Openbox, Camoufox through Playwright, screenshots, browser snapshots, mouse/keyboard actions, terminal and file access.
- **MCP gateway:** Scoped and optionally computer-bound tokens for lifecycle, desktop, browser, file, terminal and batch operations; designed for Hermes and other MCP-capable agents.
- **Same-session human takeover:** Human and agent share a computer. The guest input controller arbitrates physical human input against agent actions, rather than showing an unrelated preview.
- **Lifecycle management:** Wake-on-call, idle sleep, operation/lease protection, restart reconciliation, and persistent home volumes.
- **Dashboard:** Owner setup and authentication, computer provisioning and management, live desktop view, resource reporting, token administration and audit history.
- **Host controls:** Narrow Docker supervisor with a private Unix-socket API; exact container-ID ownership verification; resource-aware admission, CPU/memory/PID/swap restrictions and serialized privileged operations.

## Architecture

```text
AI agents ── MCP / scoped tokens ──┐
                                  ▼
Human ── HTTPS dashboard ── Control plane (Node + SQLite)
                                  │ private runtime socket
                                  ▼
                         Docker supervisor
                                  │ Docker Engine API
                    ┌─────────────┴──────────────┐
                    ▼                            ▼
              Guest computer A              Guest computer B
              Linux + Xvnc                  Linux + Xvnc
              Camoufox + files              Camoufox + files
              persistent home               persistent home
```

The control plane does not mount the Docker socket. Only the supervisor talks to Docker. Each guest receives its own home volume and generated runtime directory, not access to sibling runtime directories. Docker containers share the host kernel and are **not equivalent to full virtual machines**.

## Deployment and status

**Status: development / production hardening — not production certified.** The current branch documents unfinished normal-Linux end-to-end verification, network-boundary review, existing-installation migration and backup/restore release gates. Earlier Phase 0–7 successes were obtained under a constrained development environment and are not a substitute for production acceptance.

Requirements: Linux with Docker Engine 24+ and Docker Compose v2, working host resource controls, and sufficient RAM/disk. The stack is intended for one installation per Docker daemon. For a fresh, disposable test host:

```bash
cp .env.example .env
# Set ACP_SUPERVISOR_SECRET to a securely generated value:
openssl rand -hex 32
# Put the generated secret in .env before starting.
docker compose config --quiet
docker compose --profile build build guest-image
docker compose build supervisor
docker compose up -d
```

Open `http://127.0.0.1:8787` for owner setup on a loopback-bound deployment. For access beyond localhost, use a properly configured HTTPS reverse proxy, exact `ACP_PUBLIC_ORIGIN`, controlled `ACP_TRUST_PROXY`, and WebSocket forwarding. Follow [DEPLOYMENT.md](DEPLOYMENT.md) rather than treating this summary as a production playbook.

## Integrations

- [HOB](https://github.com/abdlx/hob) — multi-agent Hermes dashboard and computer integration.
- [Portal](https://github.com/abdlx/Portal) — complementary physical-Linux agent computer using a compatible MCP/REST surface and per-bot persistent Camoufox browser profiles.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Deployment](DEPLOYMENT.md) and [Coolify notes](COOLIFY.md)
- [Security report](SECURITY_REPORT.md) and [production audit](PRODUCTION_AUDIT.md)
- [Resource scheduler](RESOURCE_SCHEDULER.md)
- [Backup and restore](BACKUP_RESTORE.md)
- [Release checklist](RELEASE_CHECKLIST.md) and [known issues](KNOWN_ISSUES.md)
- [Tests and build progress](TEST_RESULTS.md)

## License

MIT — see [LICENSE](LICENSE).
