# Coolify

Status: **untested; one-click support is not claimed**.

This stack requires a Docker-authorized supervisor, a private persistent identity registry, a fixed runtime volume named `agentcomputer_acp-run`, a dedicated empty read-only disk probe named volume (`acp-storage-probe`) on Docker's storage filesystem, and the guest network `agentcomputer_guests`. Coolify must preserve these settings and route only the authenticated control-plane port through HTTPS with WebSocket upgrades.

No Coolify installation is available in this session. Validate fresh deployment, setup, guest socket mounts, MCP, desktop, restart, cgroup enforcement, backup/restore and upgrade before advertising support. The old full Docker volume-tree identity mount is no longer supported.
