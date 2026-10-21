# Resource scheduler

Status: implemented initial admission policy; locally tested with a fake Docker daemon. Real enforcement and measurements are **untested**.

The supervisor reads Docker `/info` for daemon physical RAM/CPU and control capabilities, Linux `/proc/meminfo` for current host MemAvailable (including unrelated workload pressure), and statfs on an explicitly configured directory on Docker's storage filesystem. It fails closed when these cannot be read. It never substitutes the platform image filesystem for Docker storage.

Default host reserve is max(1024 MB, 20% of host RAM) when running directly; Compose explicitly configures 1024 MB unless overridden. The minimum configurable reserve is 512 MB. Default maximum running computers is four. CPU commitment defaults to 1x physical logical CPUs; an administrator can configure 1?4x. Memory limits are never overcommitted.

Admission memory headroom is max(0, min(total RAM - reserve - running memory commitments, currently available RAM - reserve)). Every start recomputes commitments from exact registered container IDs and Docker inspect. Sleeping containers contribute no running commitment. The supervisor queue holds across the Docker start response, so a second start observes the first running container. This queue is process-local: only one supervisor instance is supported. External workloads can still consume resources immediately after any sample; no userspace admission policy guarantees protection against arbitrary later host load.

Docker receives NanoCpus, Memory, MemorySwap equal to Memory (no guest swap), PidsLimit 512, minimal capabilities and no-new-privileges. These are requested limits; actual cgroup enforcement requires Linux validation. Creation is refused when Docker reports CPU/memory controls unavailable. Unknown or unconstrained registered running computers fail admission closed.

`GET /api/resources` requires an administrator session. The dashboard reports capacity, available/reserved/committed RAM, CPU capacity, running count and disk free. Creation controls disable choices beyond sampled capacity; server-side checks remain authoritative. `diskGb` is legacy metadata, **not a quota**. `storageQuotaSupported` is false and the UI does not offer a fictitious disk allocation.

Not implemented/validated: effective host/cgroup quota distinction, swap telemetry, filesystem quota detection, usage history, measured guest presets, dynamic resizing, optional memory soft protection/I/O weights, per-computer idle policy, external CPU pressure sampling, queued starts and multi-supervisor coordination. Disk capacity probe must be placed on the correct filesystem by the operator; automatic device verification remains open.

Tests: `node --test tests/resource_scheduler.test.mjs tests/supervisor_security.test.mjs`. The latter runs the real supervisor with a fake Docker API and proves one of two competing 2 GB starts on a 4 GB host with a 1 GB reserve is rejected.
