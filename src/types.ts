/**
 * Shared benchmark types. The engine deliberately reports raw measurements as
 * well as friendly rates so results can be compared or re-scored later.
 */

export const CPU_WORKLOAD_VERSION = "xorshift32-imul-v1" as const;

export type BenchmarkId =
  | "cpu-single"
  | "cpu-multi"
  | "memory"
  | "storage"
  | "suite";

export type BenchmarkPhase =
  | "preparing"
  | "warming-up"
  | "waiting"
  | "running"
  | "cleaning-up"
  | "complete"
  | "cancelled";

export interface ProgressEvent {
  benchmark: BenchmarkId;
  phase: BenchmarkPhase;
  /** A clamped value from 0 to 1. */
  completedRatio: number;
  elapsedMs: number;
  durationMs?: number;
  message: string;
  /** Optional coarse grouping for renderer components. */
  component?: "cpu" | "memory" | "storage" | "gpu" | "suite";
}

export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * A tiny, structured-clone-safe cancellation token. It is intentionally not an
 * AbortSignal because AbortSignal cancellation is not synchronously observable
 * inside a worker's hot loop.
 */
export interface BenchmarkCancellationToken {
  readonly buffer: SharedArrayBuffer;
}

export interface BenchmarkCancellationController {
  readonly token: BenchmarkCancellationToken;
  readonly cancelled: boolean;
  cancel(): void;
}

export interface CommonBenchmarkOptions {
  cancellation?: BenchmarkCancellationToken;
  /** Controls UI update frequency, not the measured workload. */
  progressIntervalMs?: number;
}

export interface CpuBenchmarkOptions extends CommonBenchmarkOptions {
  /** Default: 10,000 ms. */
  singleThreadDurationMs?: number;
  /** Default: 15,000 ms. */
  allThreadDurationMs?: number;
  /** Per-pass warm-up. Default: 1,000 ms. Set to 0 in tests if desired. */
  warmupMs?: number;
  /** Default: every logical processor reported by the OS. */
  logicalThreads?: number;
  /** Unsigned 32-bit base seed. */
  seed?: number;
  /** Work is timed in batches. Lower values improve cancellation precision. */
  batchIterations?: number;
  /** Delay after every worker reports warm, allowing a synchronized start. */
  synchronizedStartDelayMs?: number;
}

export interface CpuThreadResult {
  index: number;
  seed: number;
  operations: number;
  elapsedMs: number;
  checksum: number;
}

export interface CpuPassResult {
  threadCount: number;
  targetDurationMs: number;
  elapsedMs: number;
  totalOperations: number;
  operationsPerSecond: number;
  checksum: number;
  threads: CpuThreadResult[];
}

export interface CpuBenchmarkResult {
  workloadVersion: typeof CPU_WORKLOAD_VERSION;
  logicalThreads: number;
  warmupMs: number;
  singleThread: CpuPassResult;
  allThreads: CpuPassResult;
  /** All-thread operations/second divided by single-thread operations/second. */
  scalingFactor: number;
  /** Scaling divided by logical thread count, expressed as a percentage. */
  parallelEfficiency: number;
  /** Convenient UI projection of singleThread.operationsPerSecond. */
  singleThreadMops: number;
  /** Convenient UI projection of allThreads.operationsPerSecond. */
  multiThreadMops: number;
  /** Alias of scalingFactor for renderer/export compatibility. */
  scaling: number;
}

export interface MemoryBenchmarkOptions extends CommonBenchmarkOptions {
  /** Size of both source and destination buffers. Default: 128 MiB. */
  bufferBytes?: number;
  /** Default: 250 ms. Set to 0 in tests if desired. */
  warmupMs?: number;
  /** Default: 4,000 ms. */
  durationMs?: number;
  synchronizedStartDelayMs?: number;
}

export interface MemoryBenchmarkResult {
  bufferBytes: number;
  warmupMs: number;
  targetDurationMs: number;
  elapsedMs: number;
  copyCount: number;
  bytesCopied: number;
  bytesPerSecond: number;
  gigabytesPerSecond: number;
  /** Alias of gigabytesPerSecond for renderer/export compatibility. */
  throughputGiBs: number;
  checksum: number;
}

export interface StorageBenchmarkOptions extends CommonBenchmarkOptions {
  /** Existing parent directory. Defaults to the operating system temp folder. */
  directory?: string;
  /** Default: 256 MiB. */
  totalBytes?: number;
  /** Default: 8 MiB. */
  chunkBytes?: number;
}

export interface StorageBenchmarkResult {
  totalBytes: number;
  chunkBytes: number;
  bytesWritten: number;
  bytesRead: number;
  writeElapsedMs: number;
  readElapsedMs: number;
  writeBytesPerSecond: number;
  readBytesPerSecond: number;
  writeMegabytesPerSecond: number;
  readMegabytesPerSecond: number;
  /** Alias of writeMegabytesPerSecond for renderer/export compatibility. */
  writeMiBs: number;
  /** Alias of readMegabytesPerSecond for renderer/export compatibility. */
  readMiBs: number;
  checksum: number;
  cleanupComplete: boolean;
}

/**
 * Run a deterministic number of benchmark operations and return the next
 * unsigned state. Keeping this primitive public makes the workload version
 * independently testable. Each iteration is one reported CPU operation.
 */
export function runCpuWorkloadBatch(initialState: number, iterations: number): number {
  let state = initialState >>> 0;

  for (let index = 0; index < iterations; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = Math.imul((state ^ 0x85ebca6b) >>> 0, 0xc2b2ae35) >>> 0;
  }

  return state >>> 0;
}

export type BenchmarkProgress = ProgressEvent;
export type BenchmarkStatus = "completed" | "failed" | "cancelled";

export interface SystemInfo {
  cpuModel: string;
  logicalThreads: number;
  architecture: string;
  platform?: string;
  release?: string;
  hostname?: string;
  cpuSpeedMHz?: number;
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
  gpuAdapters?: string[];
  memoryBytes?: number;
  osName?: string;
  osVersion?: string;
  gpuRenderer?: string;
  gpuFeatureStatus?: Record<string, string>;
  appVersion?: string;
  electronVersion?: string;
}

export interface CpuResult {
  status: BenchmarkStatus;
  workloadVersion?: string;
  logicalThreads?: number;
  warmupMs?: number;
  singleThreadMops?: number;
  multiThreadMops?: number;
  scaling?: number;
  parallelEfficiency?: number;
  singleThread?: CpuPassResult;
  allThreads?: CpuPassResult;
  message?: string;
  error?: string;
}

export interface MemoryResult {
  status: BenchmarkStatus;
  throughputGiBs?: number;
  throughputGBs?: number;
  bufferBytes?: number;
  elapsedMs?: number;
  durationMs?: number;
  warmupMs?: number;
  bytesCopied?: number;
  copyCount?: number;
  checksum?: number;
  message?: string;
  error?: string;
}

export interface StorageResult {
  status: BenchmarkStatus;
  writeMiBs?: number;
  readMiBs?: number;
  totalBytes?: number;
  writeElapsedMs?: number;
  readElapsedMs?: number;
  checksum?: number;
  cleanupComplete?: boolean;
  note?: string;
  message?: string;
  error?: string;
}

export interface GpuResult {
  status: "completed" | "failed" | "cancelled";
  durationMs: number;
  warmupMs: number;
  width: number;
  height: number;
  draws: number;
  drawsPerSecond: number;
  gpixelsPerSecond: number;
  renderer: string;
  error?: string;
}

/** Serializable payload used by the local JSON export flow. */
export interface BenchmarkRun {
  schemaVersion: 1;
  startedAt: string;
  completedAt: string;
  systemInfo: SystemInfo | null;
  cpu?: CpuResult;
  memory?: MemoryResult;
  storage?: StorageResult;
  gpu?: GpuResult;
  cancelled?: boolean;
  id?: string;
  status?: "completed";
  scope?: Array<"cpu" | "gpu" | "memory" | "storage">;
  durationMs?: number;
}

export interface ExportResult {
  success?: boolean;
  canceled?: boolean;
  path?: string;
  filePath?: string;
  cancelled?: boolean;
  error?: string;
}

/** The intentionally small context-bridge surface exposed to the renderer. */
export interface PulseBenchApi {
  getSystemInfo(): Promise<SystemInfo>;
  runCpu(): Promise<CpuResult>;
  runMemory(): Promise<MemoryResult>;
  runStorage(): Promise<StorageResult>;
  cancel(): Promise<void> | void;
  exportResults(payload: BenchmarkRun): Promise<ExportResult>;
  onProgress(callback: (event: BenchmarkProgress) => void): void | (() => void);
}
