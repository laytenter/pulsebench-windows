import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BenchmarkCancelledError,
  createCancellationController,
  runCpuBenchmark,
  runMemoryBenchmark,
  runStorageBenchmark,
} from "../src/benchmark-engine";
import {
  CPU_WORKLOAD_VERSION,
  runCpuWorkloadBatch,
  type ProgressEvent,
} from "../src/types";

test("the versioned CPU primitive is deterministic", () => {
  assert.equal(CPU_WORKLOAD_VERSION, "xorshift32-imul-v1");
  assert.equal(runCpuWorkloadBatch(0x12345678, 1_000), 0x74fbab9d);
  assert.equal(
    runCpuWorkloadBatch(0x12345678, 1_000),
    runCpuWorkloadBatch(0x12345678, 1_000),
  );
  assert.notEqual(
    runCpuWorkloadBatch(0x12345678, 999),
    runCpuWorkloadBatch(0x12345678, 1_000),
  );
});

test("CPU benchmark reports raw per-thread work, checksums, scaling and progress", async () => {
  const progress: ProgressEvent[] = [];
  const result = await runCpuBenchmark(
    {
      singleThreadDurationMs: 35,
      allThreadDurationMs: 45,
      warmupMs: 5,
      logicalThreads: 2,
      batchIterations: 512,
      synchronizedStartDelayMs: 5,
      progressIntervalMs: 2,
      seed: 0x12345678,
    },
    (event) => progress.push(event),
  );

  assert.equal(result.workloadVersion, CPU_WORKLOAD_VERSION);
  assert.equal(result.logicalThreads, 2);
  assert.equal(result.singleThread.threadCount, 1);
  assert.equal(result.allThreads.threadCount, 2);
  assert.equal(result.singleThread.threads.length, 1);
  assert.equal(result.allThreads.threads.length, 2);
  assert.ok(result.singleThread.totalOperations > 0);
  assert.ok(result.allThreads.totalOperations > 0);
  assert.ok(result.singleThread.operationsPerSecond > 0);
  assert.ok(result.allThreads.operationsPerSecond > 0);
  assert.ok(Number.isFinite(result.scalingFactor) && result.scalingFactor > 0);
  assert.ok(Number.isFinite(result.parallelEfficiency) && result.parallelEfficiency > 0);
  assert.equal(result.singleThread.totalOperations % 512, 0);
  assert.equal(result.allThreads.totalOperations % 512, 0);
  assert.ok(result.singleThread.checksum >= 0 && result.singleThread.checksum <= 0xffffffff);
  assert.ok(result.allThreads.checksum >= 0 && result.allThreads.checksum <= 0xffffffff);
  for (const thread of [...result.singleThread.threads, ...result.allThreads.threads]) {
    assert.equal(runCpuWorkloadBatch(thread.seed, thread.operations), thread.checksum);
  }
  assert.ok(progress.some((event) => event.benchmark === "cpu-single" && event.phase === "running"));
  assert.ok(progress.some((event) => event.benchmark === "cpu-multi" && event.phase === "complete"));
  assert.ok(progress.every((event) => event.completedRatio >= 0 && event.completedRatio <= 1));
});

test("memory benchmark copies the configured buffer in a worker", async () => {
  const progress: ProgressEvent[] = [];
  const result = await runMemoryBenchmark(
    {
      bufferBytes: 256 * 1024,
      warmupMs: 2,
      durationMs: 25,
      synchronizedStartDelayMs: 2,
      progressIntervalMs: 2,
    },
    (event) => progress.push(event),
  );

  assert.equal(result.bufferBytes, 256 * 1024);
  assert.ok(result.copyCount > 0);
  assert.equal(result.bytesCopied, result.copyCount * result.bufferBytes);
  assert.ok(result.bytesPerSecond > 0);
  assert.ok(result.gigabytesPerSecond > 0);
  assert.ok(result.checksum >= 0 && result.checksum <= 0xffffffff);
  assert.ok(progress.some((event) => event.phase === "warming-up"));
  assert.ok(progress.some((event) => event.phase === "complete"));
});

test("storage benchmark writes exact byte counts and removes only its own temp artifacts", async () => {
  const parent = await fs.mkdtemp(join(tmpdir(), "pulsebench-engine-test-"));
  const sentinel = join(parent, "keep-me.txt");
  await fs.writeFile(sentinel, "sentinel", { flag: "wx" });

  try {
    const result = await runStorageBenchmark({
      directory: parent,
      totalBytes: 1_500_123,
      chunkBytes: 256 * 1024,
      progressIntervalMs: 1,
    });

    assert.equal(result.totalBytes, 1_500_123);
    assert.equal(result.chunkBytes, 256 * 1024);
    assert.equal(result.bytesWritten, 1_500_123);
    assert.equal(result.bytesRead, 1_500_123);
    assert.ok(result.writeBytesPerSecond > 0);
    assert.ok(result.readBytesPerSecond > 0);
    assert.equal(result.cleanupComplete, true);
    assert.equal(await fs.readFile(sentinel, "utf8"), "sentinel");
    assert.deepEqual(await fs.readdir(parent), ["keep-me.txt"]);
  } finally {
    await fs.unlink(sentinel);
    await fs.rmdir(parent);
  }
});

test("a SharedArrayBuffer cancellation token rejects a run", async () => {
  const controller = createCancellationController();
  assert.equal(controller.cancelled, false);

  const pending = runMemoryBenchmark({
    bufferBytes: 4 * 1024 * 1024,
    warmupMs: 0,
    durationMs: 2_000,
    synchronizedStartDelayMs: 5,
    progressIntervalMs: 5,
    cancellation: controller.token,
  });
  setTimeout(() => controller.cancel(), 20).unref();

  await assert.rejects(pending, BenchmarkCancelledError);
  assert.equal(controller.cancelled, true);
});

test("invalid benchmark sizes fail before starting work", async () => {
  await assert.rejects(
    runStorageBenchmark({ totalBytes: 0, chunkBytes: 1 }),
    /totalBytes must be a positive safe integer/,
  );
  await assert.rejects(
    runMemoryBenchmark({ bufferBytes: -1, durationMs: 1 }),
    /bufferBytes must be a positive safe integer/,
  );
});
