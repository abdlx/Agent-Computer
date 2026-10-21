/** Conservative admission: limits are commitments, never current usage estimates. */
export interface Capacity {
  totalMemoryMb: number;
  availableMemoryMb: number;
  cpuMillis: number;
  freeDiskGb: number;
}
export interface Reservation { memoryMb: number; cpuMillis: number }
export interface Policy { reserveMemoryMb: number; minFreeDiskGb: number; maxRunning: number; cpuOvercommit: number }
export function validateLimits(memoryMb: number, cpuMillis: number) {
  if (!Number.isInteger(memoryMb) || memoryMb < 256 || memoryMb > 16384 ||
      !Number.isInteger(cpuMillis) || cpuMillis < 250 || cpuMillis > 8000) {
    throw Object.assign(new Error("invalid CPU or memory limit"), { code: 400 });
  }
}
export function admission(capacity: Capacity, running: Reservation[], requested: Reservation, policy: Policy) {
  validateLimits(requested.memoryMb, requested.cpuMillis);
  for (const value of Object.values(capacity)) {
    if (!Number.isFinite(value) || value < 0) throw Object.assign(new Error("host capacity unavailable"), { code: 503 });
  }
  if (!Number.isFinite(policy.reserveMemoryMb) || policy.reserveMemoryMb < 512 ||
      !Number.isFinite(policy.minFreeDiskGb) || policy.minFreeDiskGb < 1 ||
      !Number.isInteger(policy.maxRunning) || policy.maxRunning < 1 ||
      !Number.isFinite(policy.cpuOvercommit) || policy.cpuOvercommit < 1 || policy.cpuOvercommit > 4) {
    throw Object.assign(new Error("invalid host reservation policy"), { code: 503 });
  }
  const memoryCommittedMb = running.reduce((sum, r) => sum + r.memoryMb, 0);
  const cpuCommittedMillis = running.reduce((sum, r) => sum + r.cpuMillis, 0);
  const memoryHeadroomMb = Math.max(0, Math.min(capacity.totalMemoryMb - policy.reserveMemoryMb - memoryCommittedMb,
    capacity.availableMemoryMb - policy.reserveMemoryMb));
  let reason = "";
  if (running.length >= policy.maxRunning) reason = "maximum running computer count reached";
  else if (requested.memoryMb > memoryHeadroomMb) reason = "insufficient memory after host reserve and existing commitments";
  else if (requested.cpuMillis + cpuCommittedMillis > capacity.cpuMillis * policy.cpuOvercommit) reason = "CPU commitment limit reached";
  else if (capacity.freeDiskGb < policy.minFreeDiskGb) reason = "insufficient Docker storage space";
  return { allowed: !reason, reason, memoryHeadroomMb, memoryCommittedMb, cpuCommittedMillis,
    runningCount: running.length, policy, capacity, storageQuotaSupported: false };
}
