import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

import {
  CPU_WORKLOAD_VERSION,
  type BenchmarkCancellationController,
  type BenchmarkCancellationToken,
  type BenchmarkId,
  type CpuBenchmarkOptions,
  type CpuBenchmarkResult,
  type CpuPassResult,
  type CpuThreadResult,
  type MemoryBenchmarkOptions,
  type MemoryBenchmarkResult,
  type ProgressCallback,
  type ProgressEvent,
  type StorageBenchmarkOptions,
  type StorageBenchmarkResult,
} from "./types";

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * 1024 * 1024;
const CANCELLATION_INDEX = 0;

export const DEFAULT_CPU_SINGLE_DURATION_MS = 10_000;
export const DEFAULT_CPU_ALL_THREAD_DURATION_MS = 15_000;
export const DEFAULT_CPU_WARMUP_MS = 1_000;
export const DEFAULT_MEMORY_BUFFER_BYTES = 128 * MEBIBYTE;
export const DEFAULT_MEMORY_DURATION_MS = 4_000;
export const DEFAULT_MEMORY_WARMUP_MS = 250;
export const DEFAULT_STORAGE_TOTAL_BYTES = 256 * MEBIBYTE;
export const DEFAULT_STORAGE_CHUNK_BYTES = 8 * MEBIBYTE;

const DEFAULT_PROGRESS_INTERVAL_MS = 100;
const DEFAULT_BATCH_ITERATIONS = 16_384;
const DEFAULT_SYNCHRONIZED_START_DELAY_MS = 50;
const DEFAULT_CPU_SEED = 0x6d2b79f5;

interface WorkerMessage {
  type: "ready" | "warmed" | "progress" | "result" | "cancelled" | "failure";
  elapsedMs?: number;
  message?: string;
  result?: unknown;
}

export class BenchmarkCancelledError extends Error {
  constructor(message = "Benchmark cancelled.") {
    super(message);
    this.name = "BenchmarkCancelledError";
  }
}

export function createCancellationController(): BenchmarkCancellationController {
  const view = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const token: BenchmarkCancellationToken = Object.freeze({ buffer: view.buffer });

  return {
    token,
    get cancelled(): boolean {
      return Atomics.load(view, CANCELLATION_INDEX) !== 0;
    },
    cancel(): void {
      Atomics.store(view, CANCELLATION_INDEX, 1);
      Atomics.notify(view, CANCELLATION_INDEX);
    },
  };
}

function cancellationView(token?: BenchmarkCancellationToken): Int32Array {
  if (token === undefined) {
    return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  }

  if (
    !(token.buffer instanceof SharedArrayBuffer) ||
    token.buffer.byteLength < Int32Array.BYTES_PER_ELEMENT
  ) {
    throw new TypeError("cancellation.buffer must be a SharedArrayBuffer of at least 4 bytes.");
  }

  return new Int32Array(token.buffer, 0, 1);
}

function throwIfCancelled(view: Int32Array): void {
  if (Atomics.load(view, CANCELLATION_INDEX) !== 0) {
    throw new BenchmarkCancelledError();
  }
}

function safeProgress(callback: ProgressCallback | undefined, event: ProgressEvent): void {
  if (!callback) {
    return;
  }

  try {
    callback({
      ...event,
      completedRatio: Math.max(0, Math.min(1, event.completedRatio)),
    });
  } catch {
    // A presentation callback must never corrupt a measured run or strand its
    // temporary file. Consumers can surface their own callback errors.
  }
}

function progressEvent(
  benchmark: BenchmarkId,
  phase: ProgressEvent["phase"],
  completedRatio: number,
  elapsedMs: number,
  message: string,
  durationMs?: number,
): ProgressEvent {
  return {
    benchmark,
    phase,
    completedRatio,
    elapsedMs,
    message,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function finiteNumber(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new RangeError(`${name} must be a finite number greater than zero.`);
  }
  return normalized;
}

function nonNegativeNumber(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new RangeError(`${name} must be a finite number greater than or equal to zero.`);
  }
  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return normalized;
}

function workerScriptPath(): string {
  // benchmark-engine.ts and benchmark-worker.ts are emitted beside one another
  // under dist/src, including in packaged CommonJS builds.
  return join(__dirname, "benchmark-worker.js");
}

function waitForWorkerMessage<T>(
  worker: Worker,
  expectedType: WorkerMessage["type"],
  onOtherMessage?: (message: WorkerMessage) => void,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;

    const cleanup = (): void => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };

    const succeed = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };

    const onMessage = (rawMessage: unknown): void => {
      const message = rawMessage as WorkerMessage;
      if (message.type === "cancelled") {
        fail(new BenchmarkCancelledError());
      } else if (message.type === "failure") {
        fail(new Error(message.message ?? "Benchmark worker failed."));
      } else if (message.type === expectedType) {
        succeed(message.result as T);
      } else {
        onOtherMessage?.(message);
      }
    };

    const onError = (error: Error): void => fail(error);
    const onExit = (code: number): void => {
      fail(new Error(`Benchmark worker exited before ${expectedType} (exit code ${code}).`));
    };

    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

async function terminateWorkers(workers: Worker[]): Promise<void> {
  await Promise.allSettled(workers.map(async (worker) => worker.terminate()));
}

function aggregateCpuChecksum(results: CpuThreadResult[]): number {
  let checksum = 0x811c9dc5;
  for (const result of results) {
    checksum = Math.imul((checksum ^ result.checksum) >>> 0, 0x01000193) >>> 0;
    checksum = Math.imul((checksum ^ (result.operations >>> 0)) >>> 0, 0x01000193) >>> 0;
    checksum = Math.imul((checksum ^ result.index) >>> 0, 0x01000193) >>> 0;
  }
  return checksum >>> 0;
}

function seedForThread(baseSeed: number, index: number): number {
  const candidate = (baseSeed + Math.imul(index, 0x9e3779b9)) >>> 0;
  return candidate === 0 ? 0x1a2b3c4d : candidate;
}

async function runCpuPass(
  benchmark: "cpu-single" | "cpu-multi",
  threadCount: number,
  durationMs: number,
  warmupMs: number,
  baseSeed: number,
  batchIterations: number,
  synchronizedStartDelayMs: number,
  progressIntervalMs: number,
  cancellation: Int32Array,
  onProgress?: ProgressCallback,
): Promise<CpuPassResult> {
  throwIfCancelled(cancellation);
  safeProgress(
    onProgress,
    progressEvent(benchmark, "preparing", 0, 0, `Starting ${threadCount} CPU worker${threadCount === 1 ? "" : "s"}.`, durationMs),
  );

  const workers = Array.from({ length: threadCount }, (_, index) => {
    const seed = seedForThread(baseSeed, index);
    return new Worker(workerScriptPath(), {
      name: `pulsebench-${benchmark}-${index}`,
      workerData: {
        kind: "cpu",
        index,
        seed,
        cancellationBuffer: cancellation.buffer,
        durationMs,
        warmupMs,
        batchIterations,
        progressIntervalMs,
      },
    });
  });

  let progressTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.all(workers.map((worker) => waitForWorkerMessage<void>(worker, "ready")));
    throwIfCancelled(cancellation);

    safeProgress(
      onProgress,
      progressEvent(benchmark, "warming-up", 0, 0, "Warming CPU workload before measurement.", durationMs),
    );
    const warmedPromises = workers.map((worker) =>
      waitForWorkerMessage<void>(worker, "warmed"),
    );
    for (const worker of workers) {
      worker.postMessage({ type: "warmup" });
    }
    await Promise.all(warmedPromises);
    throwIfCancelled(cancellation);

    const startAtUnixMs = Date.now() + synchronizedStartDelayMs;
    const expectedStartAt = performance.now() + synchronizedStartDelayMs;
    safeProgress(
      onProgress,
      progressEvent(benchmark, "waiting", 0, 0, "Workers are synchronized and ready.", durationMs),
    );

    const resultPromises = workers.map((worker) =>
      waitForWorkerMessage<CpuThreadResult>(worker, "result"),
    );
    for (const worker of workers) {
      worker.postMessage({ type: "start", startAtUnixMs });
    }

    safeProgress(
      onProgress,
      progressEvent(benchmark, "running", 0, 0, "Measuring CPU operations.", durationMs),
    );
    progressTimer = setInterval(() => {
      const elapsedMs = Math.max(0, performance.now() - expectedStartAt);
      safeProgress(
        onProgress,
        progressEvent(
          benchmark,
          "running",
          elapsedMs / durationMs,
          elapsedMs,
          "Measuring CPU operations.",
          durationMs,
        ),
      );
    }, progressIntervalMs);
    progressTimer.unref();

    const threads = (await Promise.all(resultPromises)).sort((left, right) => left.index - right.index);
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = undefined;
    }
    throwIfCancelled(cancellation);

    const totalOperations = threads.reduce((sum, thread) => sum + thread.operations, 0);
    const elapsedMs = Math.max(...threads.map((thread) => thread.elapsedMs));
    const result: CpuPassResult = {
      threadCount,
      targetDurationMs: durationMs,
      elapsedMs,
      totalOperations,
      operationsPerSecond: totalOperations / (elapsedMs / 1_000),
      checksum: aggregateCpuChecksum(threads),
      threads,
    };

    safeProgress(
      onProgress,
      progressEvent(benchmark, "complete", 1, elapsedMs, "CPU pass complete.", durationMs),
    );
    return result;
  } catch (error) {
    if (error instanceof BenchmarkCancelledError) {
      safeProgress(
        onProgress,
        progressEvent(benchmark, "cancelled", 0, 0, "CPU benchmark cancelled.", durationMs),
      );
    }
    throw error;
  } finally {
    if (progressTimer) {
      clearInterval(progressTimer);
    }
    await terminateWorkers(workers);
  }
}

export async function runCpuBenchmark(
  options: CpuBenchmarkOptions = {},
  onProgress?: ProgressCallback,
): Promise<CpuBenchmarkResult> {
  const singleThreadDurationMs = finiteNumber(
    options.singleThreadDurationMs,
    DEFAULT_CPU_SINGLE_DURATION_MS,
    "singleThreadDurationMs",
  );
  const allThreadDurationMs = finiteNumber(
    options.allThreadDurationMs,
    DEFAULT_CPU_ALL_THREAD_DURATION_MS,
    "allThreadDurationMs",
  );
  const warmupMs = nonNegativeNumber(options.warmupMs, DEFAULT_CPU_WARMUP_MS, "warmupMs");
  const logicalThreads = positiveInteger(options.logicalThreads, cpus().length, "logicalThreads");
  if (logicalThreads > 1_024) {
    throw new RangeError("logicalThreads cannot exceed 1024.");
  }
  const batchIterations = positiveInteger(
    options.batchIterations,
    DEFAULT_BATCH_ITERATIONS,
    "batchIterations",
  );
  const synchronizedStartDelayMs = nonNegativeNumber(
    options.synchronizedStartDelayMs,
    DEFAULT_SYNCHRONIZED_START_DELAY_MS,
    "synchronizedStartDelayMs",
  );
  const progressIntervalMs = finiteNumber(
    options.progressIntervalMs,
    DEFAULT_PROGRESS_INTERVAL_MS,
    "progressIntervalMs",
  );
  const baseSeed = (options.seed ?? DEFAULT_CPU_SEED) >>> 0;
  const cancellation = cancellationView(options.cancellation);

  const singleThread = await runCpuPass(
    "cpu-single",
    1,
    singleThreadDurationMs,
    warmupMs,
    baseSeed,
    batchIterations,
    synchronizedStartDelayMs,
    progressIntervalMs,
    cancellation,
    onProgress,
  );
  const allThreads = await runCpuPass(
    "cpu-multi",
    logicalThreads,
    allThreadDurationMs,
    warmupMs,
    baseSeed,
    batchIterations,
    synchronizedStartDelayMs,
    progressIntervalMs,
    cancellation,
    onProgress,
  );

  const scalingFactor = allThreads.operationsPerSecond / singleThread.operationsPerSecond;
  return {
    workloadVersion: CPU_WORKLOAD_VERSION,
    logicalThreads,
    warmupMs,
    singleThread,
    allThreads,
    scalingFactor,
    parallelEfficiency: (scalingFactor / logicalThreads) * 100,
    singleThreadMops: singleThread.operationsPerSecond / 1_000_000,
    multiThreadMops: allThreads.operationsPerSecond / 1_000_000,
    scaling: scalingFactor,
  };
}

export async function runMemoryBenchmark(
  options: MemoryBenchmarkOptions = {},
  onProgress?: ProgressCallback,
): Promise<MemoryBenchmarkResult> {
  const bufferBytes = positiveInteger(
    options.bufferBytes,
    DEFAULT_MEMORY_BUFFER_BYTES,
    "bufferBytes",
  );
  const warmupMs = nonNegativeNumber(options.warmupMs, DEFAULT_MEMORY_WARMUP_MS, "warmupMs");
  const durationMs = finiteNumber(options.durationMs, DEFAULT_MEMORY_DURATION_MS, "durationMs");
  const synchronizedStartDelayMs = nonNegativeNumber(
    options.synchronizedStartDelayMs,
    DEFAULT_SYNCHRONIZED_START_DELAY_MS,
    "synchronizedStartDelayMs",
  );
  const progressIntervalMs = finiteNumber(
    options.progressIntervalMs,
    DEFAULT_PROGRESS_INTERVAL_MS,
    "progressIntervalMs",
  );
  const cancellation = cancellationView(options.cancellation);
  throwIfCancelled(cancellation);

  safeProgress(
    onProgress,
    progressEvent("memory", "preparing", 0, 0, "Allocating memory buffers.", durationMs),
  );
  const worker = new Worker(workerScriptPath(), {
    name: "pulsebench-memory",
    workerData: {
      kind: "memory",
      cancellationBuffer: cancellation.buffer,
      bufferBytes,
      durationMs,
      warmupMs,
      progressIntervalMs,
    },
  });

  try {
    await waitForWorkerMessage<void>(worker, "ready");
    throwIfCancelled(cancellation);
    safeProgress(
      onProgress,
      progressEvent("memory", "warming-up", 0, 0, "Warming the memory copy path.", durationMs),
    );
    const warmed = waitForWorkerMessage<void>(worker, "warmed");
    worker.postMessage({ type: "warmup" });
    await warmed;
    throwIfCancelled(cancellation);

    const startAtUnixMs = Date.now() + synchronizedStartDelayMs;
    safeProgress(
      onProgress,
      progressEvent("memory", "waiting", 0, 0, "Memory worker is ready.", durationMs),
    );
    const resultPromise = waitForWorkerMessage<{
      bytesCopied: number;
      checksum: number;
      copyCount: number;
      elapsedMs: number;
    }>(worker, "result", (message) => {
      if (message.type === "progress" && message.elapsedMs !== undefined) {
        safeProgress(
          onProgress,
          progressEvent(
            "memory",
            "running",
            message.elapsedMs / durationMs,
            message.elapsedMs,
            "Copying memory blocks.",
            durationMs,
          ),
        );
      }
    });
    worker.postMessage({ type: "start", startAtUnixMs });
    safeProgress(
      onProgress,
      progressEvent("memory", "running", 0, 0, "Copying memory blocks.", durationMs),
    );
    const raw = await resultPromise;
    throwIfCancelled(cancellation);

    const bytesPerSecond = raw.bytesCopied / (raw.elapsedMs / 1_000);
    const result: MemoryBenchmarkResult = {
      bufferBytes,
      warmupMs,
      targetDurationMs: durationMs,
      elapsedMs: raw.elapsedMs,
      copyCount: raw.copyCount,
      bytesCopied: raw.bytesCopied,
      bytesPerSecond,
      gigabytesPerSecond: bytesPerSecond / GIBIBYTE,
      throughputGiBs: bytesPerSecond / GIBIBYTE,
      checksum: raw.checksum >>> 0,
    };
    safeProgress(
      onProgress,
      progressEvent("memory", "complete", 1, raw.elapsedMs, "Memory benchmark complete.", durationMs),
    );
    return result;
  } catch (error) {
    if (error instanceof BenchmarkCancelledError) {
      safeProgress(
        onProgress,
        progressEvent("memory", "cancelled", 0, 0, "Memory benchmark cancelled.", durationMs),
      );
    }
    throw error;
  } finally {
    await terminateWorkers([worker]);
  }
}

async function writeFully(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<number> {
  let written = 0;
  while (written < length) {
    const result = await handle.write(buffer, written, length - written, position + written);
    if (result.bytesWritten === 0) {
      throw new Error("Storage benchmark could not make progress while writing.");
    }
    written += result.bytesWritten;
  }
  return written;
}

async function readFully(
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<number> {
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) {
      throw new Error(`Storage benchmark reached end-of-file after ${position + read} bytes.`);
    }
    read += result.bytesRead;
  }
  return read;
}

function storageChecksum(previous: number, buffer: Buffer, length: number, position: number): number {
  const middle = Math.floor((length - 1) / 2);
  let checksum = previous;
  checksum = Math.imul((checksum ^ buffer[0]) >>> 0, 0x01000193) >>> 0;
  checksum = Math.imul((checksum ^ buffer[middle]) >>> 0, 0x01000193) >>> 0;
  checksum = Math.imul((checksum ^ buffer[length - 1]) >>> 0, 0x01000193) >>> 0;
  checksum = Math.imul((checksum ^ (position >>> 0)) >>> 0, 0x01000193) >>> 0;
  return checksum >>> 0;
}

export async function runStorageBenchmark(
  options: StorageBenchmarkOptions = {},
  onProgress?: ProgressCallback,
): Promise<StorageBenchmarkResult> {
  const totalBytes = positiveInteger(options.totalBytes, DEFAULT_STORAGE_TOTAL_BYTES, "totalBytes");
  const requestedChunkBytes = positiveInteger(
    options.chunkBytes,
    DEFAULT_STORAGE_CHUNK_BYTES,
    "chunkBytes",
  );
  const chunkBytes = Math.min(requestedChunkBytes, totalBytes);
  const progressIntervalMs = finiteNumber(
    options.progressIntervalMs,
    DEFAULT_PROGRESS_INTERVAL_MS,
    "progressIntervalMs",
  );
  const cancellation = cancellationView(options.cancellation);
  throwIfCancelled(cancellation);

  const baseDirectory = resolve(options.directory ?? tmpdir());
  const baseStats = await fs.stat(baseDirectory);
  if (!baseStats.isDirectory()) {
    throw new Error(`Storage benchmark parent is not a directory: ${baseDirectory}`);
  }
  const fileSystemStats = await fs.statfs(baseDirectory);
  const availableBytes = Number(fileSystemStats.bavail) * Number(fileSystemStats.bsize);
  const requiredBytes = totalBytes * 2 + GIBIBYTE;
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new Error(
      `Storage benchmark needs at least ${(requiredBytes / GIBIBYTE).toFixed(1)} GiB free.`,
    );
  }

  safeProgress(
    onProgress,
    progressEvent("storage", "preparing", 0, 0, "Creating an isolated temporary test file."),
  );

  let temporaryDirectory: string | undefined;
  let temporaryFile: string | undefined;
  let activeHandle: FileHandle | undefined;
  let fileCreated = false;
  let primaryError: unknown;
  let benchmarkResult: StorageBenchmarkResult | undefined;
  const overallStartedAt = performance.now();

  try {
    temporaryDirectory = await fs.mkdtemp(join(baseDirectory, "pulsebench-"));
    temporaryFile = join(temporaryDirectory, "storage-test.bin");
    const writeBuffer = Buffer.allocUnsafe(chunkBytes);
    writeBuffer.fill(Buffer.from("PulseBench-storage-v1", "utf8"));

    activeHandle = await fs.open(temporaryFile, "wx+");
    fileCreated = true;
    let bytesWritten = 0;
    let expectedChecksum = 0x811c9dc5;
    let lastProgressAt = performance.now();
    const writeStartedAt = performance.now();
    while (bytesWritten < totalBytes) {
      throwIfCancelled(cancellation);
      const amount = Math.min(chunkBytes, totalBytes - bytesWritten);
      const chunkPosition = bytesWritten;
      bytesWritten += await writeFully(activeHandle, writeBuffer, amount, chunkPosition);
      expectedChecksum = storageChecksum(
        expectedChecksum,
        writeBuffer,
        amount,
        chunkPosition,
      );

      const now = performance.now();
      if (now - lastProgressAt >= progressIntervalMs || bytesWritten === totalBytes) {
        safeProgress(
          onProgress,
          progressEvent(
            "storage",
            "running",
            (bytesWritten / totalBytes) * 0.5,
            now - overallStartedAt,
            "Writing the temporary test file.",
          ),
        );
        lastProgressAt = now;
      }
    }
    await activeHandle.sync();
    const writeElapsedMs = performance.now() - writeStartedAt;
    await activeHandle.close();
    activeHandle = undefined;
    throwIfCancelled(cancellation);

    activeHandle = await fs.open(temporaryFile, "r");
    const readBuffer = Buffer.allocUnsafe(chunkBytes);
    let bytesRead = 0;
    let checksum = 0x811c9dc5;
    lastProgressAt = performance.now();
    const readStartedAt = performance.now();
    while (bytesRead < totalBytes) {
      throwIfCancelled(cancellation);
      const amount = Math.min(chunkBytes, totalBytes - bytesRead);
      const chunkPosition = bytesRead;
      const received = await readFully(activeHandle, readBuffer, amount, chunkPosition);
      checksum = storageChecksum(checksum, readBuffer, received, chunkPosition);
      bytesRead += received;

      const now = performance.now();
      if (now - lastProgressAt >= progressIntervalMs || bytesRead === totalBytes) {
        safeProgress(
          onProgress,
          progressEvent(
            "storage",
            "running",
            0.5 + (bytesRead / totalBytes) * 0.5,
            now - overallStartedAt,
            "Reading the temporary test file.",
          ),
        );
        lastProgressAt = now;
      }
    }
    const readElapsedMs = performance.now() - readStartedAt;
    await activeHandle.close();
    activeHandle = undefined;
    throwIfCancelled(cancellation);
    if (checksum !== expectedChecksum) {
      throw new Error("Storage benchmark read-back checksum did not match the written data.");
    }

    const writeBytesPerSecond = bytesWritten / (writeElapsedMs / 1_000);
    const readBytesPerSecond = bytesRead / (readElapsedMs / 1_000);
    benchmarkResult = {
      totalBytes,
      chunkBytes,
      bytesWritten,
      bytesRead,
      writeElapsedMs,
      readElapsedMs,
      writeBytesPerSecond,
      readBytesPerSecond,
      writeMegabytesPerSecond: writeBytesPerSecond / MEBIBYTE,
      readMegabytesPerSecond: readBytesPerSecond / MEBIBYTE,
      writeMiBs: writeBytesPerSecond / MEBIBYTE,
      readMiBs: readBytesPerSecond / MEBIBYTE,
      checksum: checksum >>> 0,
      cleanupComplete: false,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    safeProgress(
      onProgress,
      progressEvent(
        "storage",
        "cleaning-up",
        benchmarkResult ? 1 : 0,
        performance.now() - overallStartedAt,
        "Removing the exact temporary file created by this run.",
      ),
    );

    const cleanupErrors: unknown[] = [];
    if (activeHandle) {
      try {
        await activeHandle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (fileCreated && temporaryFile) {
      try {
        await fs.unlink(temporaryFile);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (temporaryDirectory) {
      try {
        // rmdir is intentionally non-recursive: an unexpected file makes this
        // fail safely instead of broadening what cleanup can delete.
        await fs.rmdir(temporaryDirectory);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      const cleanupError = new AggregateError(
        cleanupErrors,
        "Storage benchmark could not safely remove all temporary artifacts.",
      );
      primaryError = primaryError
        ? new AggregateError([primaryError, cleanupError], "Storage benchmark and cleanup both failed.")
        : cleanupError;
    } else if (benchmarkResult) {
      benchmarkResult.cleanupComplete = true;
    }
  }

  if (primaryError) {
    if (primaryError instanceof BenchmarkCancelledError) {
      safeProgress(
        onProgress,
        progressEvent(
          "storage",
          "cancelled",
          0,
          performance.now() - overallStartedAt,
          "Storage benchmark cancelled; temporary data was removed.",
        ),
      );
    }
    throw primaryError;
  }

  if (!benchmarkResult) {
    throw new Error("Storage benchmark ended without a result.");
  }

  safeProgress(
    onProgress,
    progressEvent(
      "storage",
      "complete",
      1,
      performance.now() - overallStartedAt,
      "Storage benchmark complete and temporary data removed.",
    ),
  );
  return benchmarkResult;
}
