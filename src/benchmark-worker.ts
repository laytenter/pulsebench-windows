import {
  isMainThread,
  parentPort,
  workerData,
  type MessagePort,
} from "node:worker_threads";

import { runCpuWorkloadBatch } from "./types";

interface BaseWorkerData {
  cancellationBuffer: SharedArrayBuffer;
  warmupMs: number;
  durationMs: number;
  progressIntervalMs: number;
}

interface CpuWorkerData extends BaseWorkerData {
  kind: "cpu";
  index: number;
  seed: number;
  batchIterations: number;
}

interface MemoryWorkerData extends BaseWorkerData {
  kind: "memory";
  bufferBytes: number;
}

type PulseBenchWorkerData = CpuWorkerData | MemoryWorkerData;

interface WorkerCommand {
  type: "warmup" | "start";
  startAtUnixMs?: number;
}

const CANCELLATION_INDEX = 0;

function isCancelled(flag: Int32Array): boolean {
  return Atomics.load(flag, CANCELLATION_INDEX) !== 0;
}

function waitUntil(startAtUnixMs: number, flag: Int32Array): boolean {
  while (!isCancelled(flag)) {
    const remainingMs = startAtUnixMs - Date.now();
    if (remainingMs <= 0) {
      return true;
    }

    // Atomics.wait avoids burning a core while every worker approaches the
    // shared start time. The short timeout keeps cancellation responsive.
    Atomics.wait(flag, CANCELLATION_INDEX, 0, Math.min(remainingMs, 25));
  }

  return false;
}

function cpuLoop(
  seed: number,
  durationMs: number,
  batchIterations: number,
  flag: Int32Array,
): { checksum: number; elapsedMs: number; operations: number } | undefined {
  if (isCancelled(flag)) {
    return undefined;
  }
  if (durationMs === 0) {
    return { checksum: seed >>> 0, elapsedMs: 0, operations: 0 };
  }

  let checksum = seed >>> 0;
  let operations = 0;
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;

  do {
    checksum = runCpuWorkloadBatch(checksum, batchIterations);
    operations += batchIterations;

    if (isCancelled(flag)) {
      return undefined;
    }
  } while (performance.now() < deadline);

  return {
    checksum: checksum >>> 0,
    elapsedMs: performance.now() - startedAt,
    operations,
  };
}

function fillSourceBuffer(source: Buffer): void {
  // A non-zero repeating pattern prevents sparse/zero special cases while
  // keeping setup out of the measured portion of the benchmark.
  const pattern = Buffer.from([
    0x50, 0x75, 0x6c, 0x73, 0x65, 0x42, 0x65, 0x6e,
    0x63, 0x68, 0xa5, 0x5a, 0x3c, 0xc3, 0x69, 0x96,
  ]);
  source.fill(pattern);
}

function memoryLoop(
  source: Buffer,
  destination: Buffer,
  durationMs: number,
  flag: Int32Array,
  onProgress?: (elapsedMs: number) => void,
  progressIntervalMs = 100,
): 
  | { bytesCopied: number; checksum: number; copyCount: number; elapsedMs: number }
  | undefined {
  if (isCancelled(flag)) {
    return undefined;
  }
  if (durationMs === 0) {
    return { bytesCopied: 0, checksum: 0x811c9dc5, copyCount: 0, elapsedMs: 0 };
  }

  let bytesCopied = 0;
  let copyCount = 0;
  let checksum = 0x811c9dc5;
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  let nextProgressAt = startedAt + progressIntervalMs;

  do {
    source.copy(destination);
    bytesCopied += source.length;
    copyCount += 1;

    // Sampling both ends makes the result dependent on the completed copy
    // without turning this into a checksum benchmark.
    checksum = Math.imul(
      (checksum ^ destination[0] ^ destination[destination.length - 1] ^ copyCount) >>> 0,
      0x01000193,
    ) >>> 0;

    if (isCancelled(flag)) {
      return undefined;
    }

    const now = performance.now();
    if (onProgress && now >= nextProgressAt) {
      onProgress(now - startedAt);
      nextProgressAt = now + progressIntervalMs;
    }
  } while (performance.now() < deadline);

  return {
    bytesCopied,
    checksum: checksum >>> 0,
    copyCount,
    elapsedMs: performance.now() - startedAt,
  };
}

function startCpuWorker(data: CpuWorkerData, port: MessagePort, flag: Int32Array): void {
  port.on("message", (command: WorkerCommand) => {
    if (command.type === "warmup") {
      const warmup = cpuLoop(
        (data.seed ^ 0xa5a5a5a5) >>> 0,
        data.warmupMs,
        data.batchIterations,
        flag,
      );
      if (!warmup) {
        port.postMessage({ type: "cancelled" });
        port.close();
        return;
      }

      port.postMessage({ type: "warmed" });
      return;
    }

    if (command.type === "start") {
      if (
        command.startAtUnixMs === undefined ||
        !waitUntil(command.startAtUnixMs, flag)
      ) {
        port.postMessage({ type: "cancelled" });
        port.close();
        return;
      }

      const result = cpuLoop(
        data.seed,
        data.durationMs,
        data.batchIterations,
        flag,
      );
      if (!result) {
        port.postMessage({ type: "cancelled" });
      } else {
        port.postMessage({
          type: "result",
          result: {
            ...result,
            index: data.index,
            seed: data.seed >>> 0,
          },
        });
      }
      port.close();
    }
  });

  port.postMessage({ type: "ready" });
}

function startMemoryWorker(
  data: MemoryWorkerData,
  port: MessagePort,
  flag: Int32Array,
): void {
  const source = Buffer.allocUnsafe(data.bufferBytes);
  const destination = Buffer.allocUnsafe(data.bufferBytes);
  fillSourceBuffer(source);
  destination.fill(0);

  port.on("message", (command: WorkerCommand) => {
    if (command.type === "warmup") {
      const warmup = memoryLoop(source, destination, data.warmupMs, flag);
      if (!warmup) {
        port.postMessage({ type: "cancelled" });
        port.close();
        return;
      }

      port.postMessage({ type: "warmed" });
      return;
    }

    if (command.type === "start") {
      if (
        command.startAtUnixMs === undefined ||
        !waitUntil(command.startAtUnixMs, flag)
      ) {
        port.postMessage({ type: "cancelled" });
        port.close();
        return;
      }

      const result = memoryLoop(
        source,
        destination,
        data.durationMs,
        flag,
        (elapsedMs) => {
          port.postMessage({ type: "progress", elapsedMs });
        },
        data.progressIntervalMs,
      );

      if (!result) {
        port.postMessage({ type: "cancelled" });
      } else {
        port.postMessage({ type: "result", result });
      }
      port.close();
    }
  });

  port.postMessage({ type: "ready" });
}

function runWorker(): void {
  if (!parentPort) {
    throw new Error("PulseBench worker started without a parent message port.");
  }

  const data = workerData as PulseBenchWorkerData;
  const flag = new Int32Array(data.cancellationBuffer);

  if (isCancelled(flag)) {
    parentPort.postMessage({ type: "cancelled" });
    parentPort.close();
    return;
  }

  if (data.kind === "cpu") {
    startCpuWorker(data, parentPort, flag);
  } else if (data.kind === "memory") {
    startMemoryWorker(data, parentPort, flag);
  } else {
    const exhaustive: never = data;
    throw new Error(`Unknown PulseBench worker kind: ${String(exhaustive)}`);
  }
}

if (!isMainThread) {
  try {
    runWorker();
  } catch (error) {
    parentPort?.postMessage({
      type: "failure",
      message: error instanceof Error ? error.message : String(error),
    });
    parentPort?.close();
  }
}
