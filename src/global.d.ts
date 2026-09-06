export {};

declare global {
  type BenchmarkStatus = "completed" | "failed" | "cancelled";

  interface SystemInfo {
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

  interface BenchmarkProgress {
    benchmark: "cpu-single" | "cpu-multi" | "memory" | "storage" | "suite";
    phase: "preparing" | "warming-up" | "waiting" | "running" | "cleaning-up" | "complete" | "cancelled";
    completedRatio: number;
    elapsedMs: number;
    durationMs?: number;
    message: string;
  }

  interface CpuBenchmarkUiResult {
    status: BenchmarkStatus;
    workloadVersion?: string;
    logicalThreads?: number;
    singleThreadMops?: number;
    multiThreadMops?: number;
    scaling?: number;
    parallelEfficiency?: number;
    warmupMs?: number;
    message?: string;
    error?: string;
    [key: string]: unknown;
  }

  interface MemoryBenchmarkUiResult {
    status: BenchmarkStatus;
    throughputGiBs?: number;
    bufferBytes?: number;
    durationMs?: number;
    warmupMs?: number;
    message?: string;
    error?: string;
    [key: string]: unknown;
  }

  interface StorageBenchmarkUiResult {
    status: BenchmarkStatus;
    writeMiBs?: number;
    readMiBs?: number;
    totalBytes?: number;
    cleanupComplete?: boolean;
    message?: string;
    error?: string;
    [key: string]: unknown;
  }

  interface GpuBenchmarkUiResult {
    status: BenchmarkStatus;
    durationMs?: number;
    warmupMs?: number;
    width?: number;
    height?: number;
    draws?: number;
    drawsPerSecond?: number;
    gpixelsPerSecond?: number;
    renderer?: string;
    message?: string;
    error?: string;
    [key: string]: unknown;
  }

  interface BenchmarkResultMap {
    cpu?: CpuBenchmarkUiResult;
    gpu?: GpuBenchmarkUiResult;
    memory?: MemoryBenchmarkUiResult;
    storage?: StorageBenchmarkUiResult;
  }

  interface BenchmarkRun {
    schemaVersion: 1;
    startedAt: string;
    completedAt: string;
    systemInfo: SystemInfo | null;
    cpu?: CpuBenchmarkUiResult;
    gpu?: GpuBenchmarkUiResult;
    memory?: MemoryBenchmarkUiResult;
    storage?: StorageBenchmarkUiResult;
    cancelled?: boolean;
    id?: string;
    status?: "completed";
    scope?: Array<"cpu" | "gpu" | "memory" | "storage">;
    durationMs?: number;
  }

  interface ExportResult {
    success?: boolean;
    canceled?: boolean;
    cancelled?: boolean;
    filePath?: string;
    path?: string;
    error?: string;
  }

  interface PulseBenchApi {
    getSystemInfo(): Promise<SystemInfo>;
    runCpu(): Promise<CpuBenchmarkUiResult>;
    runMemory(): Promise<MemoryBenchmarkUiResult>;
    runStorage(): Promise<StorageBenchmarkUiResult>;
    cancel(): Promise<void> | void;
    exportResults(payload: BenchmarkRun): Promise<ExportResult>;
    onProgress(callback: (progress: BenchmarkProgress) => void): (() => void) | void;
  }

  interface Window {
    pulsebench: PulseBenchApi;
  }
}
