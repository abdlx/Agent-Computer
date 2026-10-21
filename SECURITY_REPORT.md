# Security report

Release verdict: **NOT PRODUCTION READY**. See `PRODUCTION_AUDIT.md` for severity, impact and required verification.

Implemented and locally regression tested: persistent supervisor identity checks; forged-label/foreign-ID rejection; request operation and field allowlists; concurrent admission serialization; memory reserve and CPU commitment validation; single-owner database trigger; foreign browser Origin rejection; denial of create through a computer-bound admin MCP token; refusal to sleep/delete active operations and clearing dead-process operation records.

Implemented but Linux validation pending: dedicated per-guest socket directories, read-only runtime mount into control plane, no Docker volume-tree mounts, fail-closed Docker limits, no-swap/PID limits, actual desktop transport, authenticated VNC and session revocation renewal. Unit/protocol tests are not proof of Docker isolation or cgroup enforcement.

Unresolved high risks: backup consistency/integrity and safe restore; interrupted provision/delete recovery; legacy identity migration; guest network access to host/private services; guest filesystem symlink races; incomplete immediate human takeover/cancellation; browser/build provenance and dependency vulnerability clearance. Login throttling still uses a global bucket. Detailed error messages need review. No penetration test, container escape assessment or current image scan has been completed.

`npm audit --json` returned registry HTTP 503 on 2026-10-21. This is failed verification, not a clean vulnerability result. MIT project license exists; third-party notices remain incomplete.

No remote hosts accessed; no destructive fault injection run. Linux Docker/Compose, Coolify, TLS proxy and external Hermes tests remain pending.
