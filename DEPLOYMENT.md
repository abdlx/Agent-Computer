# Deployment Guide

Agent Computer Platform — one owner, one host, a handful of computers.
Everything below was validated as far as this development environment
allows; the "Validation status" section at the end says exactly what
was and was not run, so you can decide what to check on your own host.

## What you need

- A Linux host (x86_64 or arm64) with **Docker Engine 24+** and the
  **Compose v2** plugin. That's the only hard dependency — no Kubernetes,
  no external database, no cloud account.
- Sizing: the platform services themselves are tiny (~150 MB RAM). Each
  *running* computer wants the RAM you configure for it (1–2 GB is a
  good default) plus ~2.5 GB of disk for its home volume before your
  files. Sleeping computers cost no CPU/RAM, just disk.
- Outbound internet for guests (they NAT through a bridge network) and
  for building images.

## Quick start

```bash
git clone <this repo> && cd agent-computer
cp .env.example .env
# set a real secret:
sed -i "s/^ACP_SUPERVISOR_SECRET=$/ACP_SUPERVISOR_SECRET=$(openssl rand -hex 32)/" .env

docker compose --profile build build guest-image   # ~4 GB, a few minutes
docker compose build supervisor                    # platform image
docker compose up -d
```

Open **http://127.0.0.1:8787** — the first screen creates the owner
account (setup closes permanently afterwards). Then:

1. **Add Computer** from the Computers page.
2. **Connect an agent**: on the "Connect an agent" page, mint a token
   and paste the shown MCP configuration into your agent (Hermes or
   any MCP client). The gateway URL is `http://<host>:8787/mcp`.

The dashboard port binds to **127.0.0.1 only** by default. For access
from other machines, put a TLS reverse proxy in front (recommended) or
change the port binding in `docker-compose.yml` to `"8787:8787"` on a
network you trust — the login is a real password login, but the session
cookie is only as safe as the transport.

Minimal Caddy example:

```
computers.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

(Caddy terminates TLS; WebSocket proxying for the live desktop works
out of the box. nginx needs the standard `Upgrade`/`Connection` header
passthrough for `/api/computers/*/vnc`.)

## How it is wired (why the mounts look like that)

- The **supervisor** service is the only thing holding
  `/var/run/docker.sock`. It exposes a deliberately narrow API over a
  unix socket in the shared `acp-run` volume and refuses anything
  outside the computers it manages.
- The **control plane** never touches Docker. It reaches each
  computer's in-guest supervisor through a unix socket inside that
  computer's home volume, which is why the host's
  `/var/lib/docker/volumes` directory is mounted at the *identical
  path* in both services — the socket paths come from the Docker API
  and must mean the same thing everywhere.
- Guest computers are ordinary Docker containers on the
  `agentcomputer_guests` bridge network, created by the supervisor
  from the guest image — never by Compose.
- Both platform services run as root inside their containers. For the
  supervisor that is inherent (a Docker socket is root-equivalent);
  the control plane shares the volumes for the socket paths above.
  The images are minimal (Node + this source) and publish nothing but
  the one dashboard port.

## Configuration

Set in `.env` (see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACP_SUPERVISOR_SECRET` | *(required)* | Shared secret between control plane and supervisor. |
| `ACP_GUEST_IMAGE` | `agentcomputer/guest:phase0` | Image instantiated per computer. |
| `ACP_IDLE_TIMEOUT_S` | `300` | Idle seconds before a computer auto-sleeps. |
| `ACP_MIN_FREE_DISK_GB` | `5` | Creation is refused below this much free disk on the Docker volumes filesystem. |

## Backup and restore

```bash
ops/backup.sh                 # -> ./backups/<timestamp>/
ops/restore.sh ./backups/<timestamp> --yes
```

Backup stops the control plane briefly for a consistent database
snapshot, copies its data volume, and tars every computer's home
volume. It needs read access to Docker's volumes directory (run with
sudo on most hosts). Restore replaces the database and volume
contents, then starts the stack; computers reconcile on boot.

What a backup contains: the owner account, computer definitions, MCP
tokens (hashed), the audit log, and the full home volumes (files,
browser profile and cookies, app data). It does **not** contain the
guest image or the platform image — rebuild those from the repo.

## Updating

```bash
git pull
docker compose --profile build build guest-image   # if the guest changed
docker compose build supervisor
docker compose up -d
```

The database migrates in place on startup (schema is versioned; a v1
database upgrades to v2 automatically — that path is covered by the
test suite). Existing computers keep their volumes and keep working;
a new guest image only affects computers created afterwards.

## Coolify

The deployment is a plain Docker Compose stack, which is the shape
Coolify's "Docker Compose" deployment type consumes. **It has not been
validated on Coolify in this environment**, and two requirements are
easy for a compose abstraction to break, so verify them after a
Coolify deploy before trusting it:

1. **The volumes-directory identity mount.** The control plane must
   see the host's `/var/lib/docker/volumes` at that exact absolute
   path. If Coolify rewrites volume paths, guest sockets will not
   resolve and computers will show as unreachable.
2. **The raw Docker socket mount** for the supervisor service, and
   the fixed network name `agentcomputer_guests`.

If either cannot be satisfied under Coolify's model, deploy the same
compose file directly on the host (or a small VM) instead — the stack
has no other platform needs. "One-click on Coolify" is deliberately
*not* claimed until someone runs it there end to end.

## Troubleshooting

- **A computer shows "limits not enforced on this host"** — your
  kernel/cgroup setup did not accept the CPU/RAM limits (common in
  nested/containerized dev environments). On a normal Docker host
  limits apply. The platform always tells you the truth about this
  per computer.
- **Creating a computer fails with "insufficient free disk"** — the
  guard is doing its job. Free space on the Docker volumes filesystem
  or lower `ACP_MIN_FREE_DISK_GB`.
- **Dashboard loads but the desktop never connects** — check that your
  reverse proxy passes WebSocket upgrades, and that the computer is
  awake (opening its workspace wakes it automatically).
- **Everything is down after a host reboot** — `docker compose up -d`
  (the services also have `restart: unless-stopped`). Computers that
  were running reconcile on control-plane boot; wake them from the
  dashboard or let an agent call do it.

## Validation status (honest)

- The exact application code in these images is the code exercised by
  the full test suites (guest battery, API, MCP with the official SDK
  client, dashboard, hardening) on the development VM.
- `docker compose config` renders this compose file cleanly, and the
  platform image built from `deploy/Dockerfile`'s steps runs the stack
  as containers (the Phase 5 deployment smoke test drives setup →
  create → desktop → MCP against the containerized services).
- What could **not** be validated in the development sandbox (it has
  no bridge networking and no cgroup controllers): `docker compose
  up` itself with guest bridge networking, and CPU/RAM limit
  enforcement. On a standard Docker host both are the well-trodden
  path — but they are first-run checks for you, not claims.
- Coolify: unvalidated, see above.
