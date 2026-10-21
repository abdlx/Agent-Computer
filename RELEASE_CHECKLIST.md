# Release checklist ? 2026-10-21

Verdict: **NOT PRODUCTION READY**. Local hardening checkpoint only. The user explicitly prohibits SSH/remote access; Linux-dependent validation cannot run in this session.

| Gate | Status | Exact current evidence / remaining work |
| --- | --- | --- |
| 1. No critical/high unresolved vulnerabilities | FAIL | `PRODUCTION_AUDIT.md` lists open high risks; npm audit HTTP 503 |
| 2. No unrestricted Docker/host-volume access in CP/guests | PARTIALLY TESTED | Compose removes full volume-tree mount; dedicated runtime binds implemented; real mount inspection pending |
| 3. Accurate host resources | PARTIALLY TESTED | `/info`, MemAvailable and statfs implementation; effective quotas/device verification incomplete |
| 4. Allocations enforced | UNTESTED | Docker payload has limits, no fallback; actual Linux cgroups unverified |
| 5. Safe concurrent starts | PARTIALLY TESTED | Real supervisor/fake Docker competing starts test; real Docker pressure tests pending |
| 6. Persistence contract | UNTESTED | `BACKUP_RESTORE.md`; stop/recreate/upgrade validation pending |
| 7. Sleep releases RAM/CPU | UNTESTED | Graceful Docker stop implementation; current runtime measurements unavailable |
| 8. MCP wake | UNTESTED | Existing implementation retained, current live guest unavailable |
| 9. Same human/agent desktop | UNTESTED | Existing X11/browser design retained; live RFB/browser proof pending |
| 10. MCP authorization/revocation | PARTIALLY TESTED | Real local HTTP token mint/revoke and bound admin create regression; real guest tools/cancellation suite pending |
| 11. Backup/restore | FAIL | Legacy scripts do not include new registry; integrity/quiescence work open |
| 12. Host reboot recovery | UNTESTED | Requires Linux runtime; no remote access authorized |
| 13. Fresh Compose deployment | UNTESTED | Docker unavailable locally; config/build/start not run |
| 14. Coolify verified or additional setup stated | DOCUMENTED / UNTESTED | `COOLIFY.md` explicitly states unvalidated prerequisites |
| 15. Automated tests | PARTIALLY TESTED | 17 new Node tests, 13 lifecycle checks, trajectory self-test and dashboard build pass; old Docker suites not reproduced |
| 16. End-to-end tests | UNTESTED | Historical results retained; current branch requires complete real journey |
| 17. Security tests | PARTIALLY TESTED | Ownership, origin, setup, bound token, admission and active-operation tests pass locally; image/network/host tests pending |
| 18. Resource benchmarks | FAIL | `BENCHMARKS.md`: runtime measurements unavailable |
| 19. Licensing and dependency notices | PARTIAL | MIT LICENSE present; third-party inventory/provenance and dependency audit incomplete |
| 20. Accurate documentation | PARTIAL | Current branch status documented; historical Phase claims explicitly superseded; remaining audit work recorded |

No production release, deployment certification or public push has been performed.
