# Benchmarks

Status: **unmeasured on this branch**. No Docker/Linux guest runtime is available locally, and the user prohibits SSH/remote access in this session.

| Metric | Current evidence |
| --- | --- |
| Compressed/uncompressed guest image | Untested |
| Writable layer / home volume size | Untested; historical report identifies ~2.4 GB browser cache duplication |
| Idle/browser-open guest RAM and CPU | Unmeasured |
| Cold start / wake latency | Unmeasured |
| Screenshot and external MCP latency | Unmeasured |
| Enforced CPU/memory/swap/PID controls | Docker payload implemented; real cgroups untested |
| Dashboard production JS | 447.52 kB, gzip 128.00 kB in local Vite build before final verification |

Record image digest, architecture, Docker/cgroup/filesystem versions, host physical/effective capacity, workloads, commands and repeated latency samples during Linux validation. Fake-Docker timings are not runtime performance measurements.
