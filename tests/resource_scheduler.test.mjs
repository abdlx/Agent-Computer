import { test } from "node:test";
import assert from "node:assert/strict";
import { admission, validateLimits } from "../supervisor/src/resources.ts";
const host = { totalMemoryMb: 4096, availableMemoryMb: 3500, cpuMillis: 4000, freeDiskGb: 50 };
const policy = { reserveMemoryMb: 1024, minFreeDiskGb: 5, maxRunning: 3, cpuOvercommit: 1 };
const request = { memoryMb: 2048, cpuMillis: 1000 };
test("4 GB host preserves reserve", () => {
  assert.equal(admission(host, [], request, policy).allowed, true);
  assert.equal(admission(host, [], { ...request, memoryMb: 4096 }, policy).allowed, false);
});
test("external memory pressure rejects", () => assert.equal(admission({ ...host, availableMemoryMb: 1500 }, [], request, policy).allowed, false));
test("existing commitments prevent overcommit", () => assert.equal(admission(host, [request], request, policy).allowed, false));
test("CPU oversubscription requires policy", () => {
  const demand = { memoryMb: 256, cpuMillis: 5000 };
  assert.equal(admission(host, [], demand, policy).allowed, false);
  assert.equal(admission(host, [], demand, { ...policy, cpuOvercommit: 2 }).allowed, true);
});
test("disk pressure rejects", () => assert.equal(admission({ ...host, freeDiskGb: 4 }, [], request, policy).allowed, false));
test("running count enforced", () => assert.equal(admission(host, [{ memoryMb: 256, cpuMillis: 250 }], request, { ...policy, maxRunning: 1 }).allowed, false));
test("invalid limits fail closed", () => {
  for (const value of [NaN, Infinity, -1, 255, 256.1, 16385]) assert.throws(() => validateLimits(value, 1000));
  for (const value of [NaN, Infinity, -1, 249, 250.1, 8001]) assert.throws(() => validateLimits(1024, value));
});
test("invalid policy and unavailable measurements fail closed", () => {
  assert.throws(() => admission({ ...host, availableMemoryMb: NaN }, [], request, policy));
  assert.throws(() => admission(host, [], request, { ...policy, reserveMemoryMb: 0 }));
});
test("stopped computer releases commitments", () => {
  assert.equal(admission(host, [request], request, policy).allowed, false);
  assert.equal(admission(host, [], request, policy).allowed, true);
});
test("storage quota is explicitly unsupported", () => assert.equal(admission(host, [], request, policy).storageQuotaSupported, false));
