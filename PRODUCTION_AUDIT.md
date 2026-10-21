# Production audit — 2026-10-21

Verdict: **NOT PRODUCTION READY**. Historical phase results are retained as prior evidence, not proof of the current release. Audit is in progress on branch `production-hardening`.

Current environment: Windows, Node 25.3.0, Python 3.12.10; Docker executable and a Linux WSL distribution are unavailable. The designated development VPS has not yet been identified. No remote infrastructure has been changed.

| ID | Severity | Component / root cause | Impact | Correction | Required regression / status |
| --- | --- | --- | --- | --- | --- |
| S01 | Critical | Compose mounts all Docker volumes writable into public control plane | Compromise can overwrite unrelated workload data | Dedicated per-computer runtime socket directory; remove host volume-tree mounts | Compose mount inspection and real guest HTTP/VNC round trip; pending |
| S02 | High | Supervisor trusts names and caller-spoofable labels | Foreign containers can be mistaken for owned resources | Persistent supervisor-owned identity registry, exact Docker ID and volume checks | Spoofed labels and foreign IDs rejected; pending |
| S03 | High | Supervisor retries creation without resource controls | Host OOM and CPU starvation | Fail closed if controls unavailable; verify Docker inspect | Unsupported cgroup rejection; pending |
| R01 | High | No admission control or host memory reservation | Concurrent starts exhaust host | Serialized supervisor admission against host capacity and running commitments | Concurrent wakes, external pressure, reserve and restart; pending |
| R02 | High | diskGb is metadata without quota | Misleading allocation; disk exhaustion | Explicit unsupported quota capability; disk safety guard | API and dashboard truthfulness; pending |
| L01 | High | Deletion bypasses lifecycle transitions | Data removal during active work | Serialize deletion and reject active operations | Delete/call/wake races; pending |
| L02 | High | Persisted operations never expire after restart | Computers remain awake indefinitely | Clear dead-process operations at boot; bounded operation lifetime | Crash/restart recovery; pending |
| L03 | Medium | Stop and sleep share one state | Automatic wake overrides intentional stop | Explicit stopped state and manual-start policy | Human/MCP wake after manual stop; pending |
| A01 | High | VNC upgrades have no Origin validation | Cross-origin desktop access risk | Validate configured public origin before upgrade | Foreign origin rejected; pending |
| A02 | Medium | Login throttle uses one global key | One attacker locks out every user | Bounded per-client throttle plus global ceiling | Independent clients / proxy trust; pending |
| A03 | Medium | Setup closure is process-local count check | Multiple processes can race onboarding | Database transaction and singleton owner constraint | Concurrent first-run workers; pending |
| P01 | High | Backup archives live guest profiles; restore extracts unverified archives | Inconsistent backup and unsafe restore | Quiesce guests; integrity manifest; validate paths; scoped volume access | Corrupt archive, interrupted restore, profile recovery; pending |
| P02 | Medium | Browser binary cache inside persistent home | ~2.4 GB duplicated per computer, upgrades retain old runtime | Immutable browser binaries outside home | Real browser startup, volume size, upgrade; pending |
| D01 | High | Deployment and benchmark evidence belongs to constrained historical sandbox | Production networking and actual limits remain unproven | Fresh Linux Compose, external MCP and cgroup validation | Release gates remain blocked |
| D02 | Medium | Dependencies lack current security audit and provenance report | Unknown supply chain exposure | Registry audit, pinned runtime provenance and third-party notices | Dependency audit and clean builds; pending |

Baseline reproduction: `python guest/supervisor/trajectory.py` passed. `node tests/engine_races.mjs` failed before executing checks because `/tmp/acp-race-guest.sock` is a Linux-only socket path on Windows. Existing Python integration suites also hardcode the historical `/home/hatch` VM and require Docker. These are environment failures, not passing release evidence.

Audit scope inspected: architecture, deployment, known issues and historical test claims; Compose and Dockerfiles; control-plane auth, database, HTTP/VNC routing, lifecycle and MCP; guest supervisor/browser/input; dashboard creation/viewer/token flows; backup and restore; test harness setup. Full dependency/provenance and every test assertion review remain open.

## Corrections at the local checkpoint

- S01: implemented dedicated runtime subdirectories and removed both Docker volume-tree mounts. Real Docker mount/VNC tests pending.
- S02: implemented private persistent identity registry, exact-ID operations and volume validation before removal. Real supervisor/fake Docker regression passes spoofed/foreign ownership and rejected volume removal. Legacy identity migration remains blocked.
- S03: removed unenforced retry; requires daemon CPU/memory capabilities and explicit memory/swap/PID/CPU settings. Fake Docker unsupported-capability rejection passes; cgroup enforcement untested.
- R01: initial serialized admission/reserve/commitment policy implemented and tested with fake Docker; host effective quotas and real pressure still pending.
- R02: API/UI explicitly report unsupported storage quotas; capacity display and disabled allocation choices implemented. Real UI visual verification pending.
- L01/L02: active-operation sleep/delete rejection, serialized deletion, transition-chain cleanup and dead-process operation cleanup implemented; local regression tests pass. Interrupted deletion recovery remains open.
- A01/A03: Origin checks and database singleton-owner trigger implemented. Real local HTTP concurrent setup, CSRF, logout and token-revocation journey passes; real VNC/HTTPS pending.
- Added bound-admin-token create denial, malformed JSON/path handling, static-path boundary correction, explicit proxy trust and session validation at viewer lease renewal. Local tests cover the key auth boundaries; broad security review remains incomplete.

No claim that all Critical/High issues are closed. Backup safety, legacy migration, guest network boundaries, filesystem races, cancellation, supply chain and real deployment tests remain release blockers. No remote infrastructure was accessed.
