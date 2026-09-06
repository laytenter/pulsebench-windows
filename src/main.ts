import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createCancellationController,
  runCpuBenchmark,
  runMemoryBenchmark,
  runStorageBenchmark,
} from "./benchmark-engine";
import type {
  BenchmarkCancellationController,
  CpuBenchmarkResult,
  MemoryBenchmarkResult,
  ProgressEvent,
  StorageBenchmarkResult,
} from "./types";

const IPC = {
  systemInfo: "pulsebench:v1:system-info",
  cpu: "pulsebench:v1:cpu",
  memory: "pulsebench:v1:memory",
  storage: "pulsebench:v1:storage",
  cancel: "pulsebench:v1:cancel",
  progress: "pulsebench:v1:progress",
  exportResults: "pulsebench:v1:export-results",
} as const;

const smokeTestMode = process.argv.includes("--smoke-test");
const suiteSmokeTestMode = process.argv.includes("--suite-smoke-test");

let mainWindow: BrowserWindow | null = null;
let activeController: BenchmarkCancellationController | null = null;
let activeBenchmark: "cpu" | "memory" | "storage" | null = null;
let activeCleanup: Promise<void> | null = null;

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The benchmark could not be completed.";
}

function toCpuView(result: CpuBenchmarkResult) {
  return {
    status: "completed" as const,
    workloadVersion: result.workloadVersion,
    logicalThreads: result.logicalThreads,
    warmupMs: result.warmupMs,
    singleThreadMops: result.singleThread.operationsPerSecond / 1_000_000,
    multiThreadMops: result.allThreads.operationsPerSecond / 1_000_000,
    scaling: result.scalingFactor,
    parallelEfficiency: result.parallelEfficiency,
    singleThread: result.singleThread,
    allThreads: result.allThreads,
  };
}

function toMemoryView(result: MemoryBenchmarkResult) {
  return {
    status: "completed" as const,
    bufferBytes: result.bufferBytes,
    elapsedMs: result.elapsedMs,
    bytesCopied: result.bytesCopied,
    copyCount: result.copyCount,
    throughputGiBs: result.bytesPerSecond / 1024 ** 3,
    throughputGBs: result.gigabytesPerSecond,
    checksum: result.checksum,
  };
}

function toStorageView(result: StorageBenchmarkResult) {
  return {
    status: "completed" as const,
    totalBytes: result.totalBytes,
    writeMiBs: result.writeBytesPerSecond / 1024 ** 2,
    readMiBs: result.readBytesPerSecond / 1024 ** 2,
    writeElapsedMs: result.writeElapsedMs,
    readElapsedMs: result.readElapsedMs,
    checksum: result.checksum,
    cleanupComplete: result.cleanupComplete,
    note: "Buffered application I/O; this is not a raw uncached drive measurement.",
  };
}

function forwardProgress(progress: ProgressEvent): void {
  if (!mainWindow?.isDestroyed()) {
    mainWindow?.webContents.send(IPC.progress, progress);
  }
}

async function runExclusive<T>(
  benchmark: "cpu" | "memory" | "storage",
  runner: (controller: BenchmarkCancellationController) => Promise<T>,
): Promise<T | { status: "cancelled"; message: string }> {
  if (activeController) {
    throw new Error(`A ${activeBenchmark ?? "system"} benchmark is already running.`);
  }

  const controller = createCancellationController();
  activeController = controller;
  activeBenchmark = benchmark;
  let finishCleanup!: () => void;
  activeCleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });

  try {
    return await runner(controller);
  } catch (error) {
    if (controller.cancelled) {
      return { status: "cancelled", message: "Benchmark cancelled." };
    }
    throw new Error(safeErrorMessage(error));
  } finally {
    activeController = null;
    activeBenchmark = null;
    activeCleanup = null;
    finishCleanup();
  }
}

async function readSystemInfo() {
  const processors = os.cpus();
  let gpuRenderer = "Unavailable";
  let gpuFeatureStatus: Record<string, string> = {};

  try {
    const gpuInfo = (await app.getGPUInfo("complete")) as unknown as {
      auxAttributes?: { glRenderer?: string; glVendor?: string };
      gpuDevice?: Array<{
        active?: boolean;
        deviceString?: string;
        vendorId?: number;
        deviceId?: number;
      }>;
    };
    const activeDevice = gpuInfo.gpuDevice?.find((device) => device.active);
    gpuRenderer =
      gpuInfo.auxAttributes?.glRenderer ||
      activeDevice?.deviceString ||
      (activeDevice
        ? `GPU ${activeDevice.vendorId?.toString(16) ?? "?"}:${activeDevice.deviceId?.toString(16) ?? "?"}`
        : "Unavailable");
    gpuFeatureStatus = app.getGPUFeatureStatus() as unknown as Record<string, string>;
  } catch {
    // GPU information is best effort; the actual WebGL test reports its renderer.
  }

  return {
    platform: process.platform,
    release: os.release(),
    cpuModel: processors[0]?.model.trim() || "Unknown CPU",
    cpuSpeedMHz: processors[0]?.speed || 0,
    logicalThreads: processors.length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    memoryBytes: os.totalmem(),
    osName: `${os.type()} ${os.release()}`,
    osVersion: os.version(),
    architecture: os.arch(),
    gpuRenderer,
    gpuAdapters: gpuRenderer === "Unavailable" ? [] : [gpuRenderer],
    gpuFeatureStatus,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
  };
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.systemInfo, () => readSystemInfo());

  ipcMain.handle(IPC.cpu, () =>
    runExclusive("cpu", async (controller) => {
      const result = await runCpuBenchmark(
        { cancellation: controller.token },
        forwardProgress,
      );
      return toCpuView(result);
    }),
  );

  ipcMain.handle(IPC.memory, () =>
    runExclusive("memory", async (controller) => {
      const result = await runMemoryBenchmark(
        { cancellation: controller.token },
        forwardProgress,
      );
      return toMemoryView(result);
    }),
  );

  ipcMain.handle(IPC.storage, () =>
    runExclusive("storage", async (controller) => {
      const result = await runStorageBenchmark(
        { cancellation: controller.token },
        forwardProgress,
      );
      return toStorageView(result);
    }),
  );

  ipcMain.handle(IPC.cancel, () => {
    activeController?.cancel();
    return { cancelled: Boolean(activeController) };
  });

  ipcMain.handle(IPC.exportResults, async (_event, payload: unknown) => {
    const json = JSON.stringify(payload, null, 2);
    if (!json || json.length > 5_000_000) {
      throw new Error("The result payload is invalid or too large to export.");
    }

    const defaultName = `PulseBench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const saveOptions: Electron.SaveDialogOptions = {
      title: "Export PulseBench result",
      defaultPath: path.join(app.getPath("documents"), defaultName),
      filters: [{ name: "JSON result", extensions: ["json"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
    const selection = mainWindow
      ? await dialog.showSaveDialog(mainWindow, saveOptions)
      : await dialog.showSaveDialog(saveOptions);

    if (selection.canceled || !selection.filePath) {
      return { success: false, canceled: true };
    }
    await writeFile(selection.filePath, `${json}\n`, "utf8");
    return { success: true, canceled: false, filePath: selection.filePath };
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 790,
    minWidth: 960,
    minHeight: 680,
    show: false,
    backgroundColor: "#0b0e13",
    autoHideMenuBar: true,
    title: "PulseBench",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  if (smokeTestMode || suiteSmokeTestMode) {
    window.webContents.once("did-finish-load", () => {
      setTimeout(() => {
        void (async () => {
          const rendererState = suiteSmokeTestMode
            ? await window.webContents.executeJavaScript(`(async () => {
                const runButton = document.getElementById("run-all-button");
                if (!(runButton instanceof HTMLButtonElement)) {
                  throw new Error("Run all button is unavailable.");
                }
                runButton.click();
                const deadline = Date.now() + 120000;
                let state = "";
                while (Date.now() < deadline) {
                  state = document.getElementById("suite-status")?.dataset.state || "";
                  if (["completed", "failed", "cancelled"].includes(state)) break;
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
                return {
                  state,
                  cpu: document.getElementById("cpu-primary")?.textContent,
                  cpuDetail: document.getElementById("cpu-detail")?.textContent,
                  gpu: document.getElementById("gpu-primary")?.textContent,
                  gpuDetail: document.getElementById("gpu-detail")?.textContent,
                  memory: document.getElementById("memory-primary")?.textContent,
                  storage: document.getElementById("storage-primary")?.textContent,
                  historyItems: document.querySelectorAll(".history-entry").length
                };
              })()`, true)
            : await window.webContents.executeJavaScript(`(() => {
                const canvas = document.getElementById("gpu-canvas");
                return {
                  title: document.title,
                  readyState: document.readyState,
                  hasBridge: typeof window.pulsebench === "object",
                  hasRunAll: Boolean(document.getElementById("run-all-button")),
                  hasGpuCanvas: canvas instanceof HTMLCanvasElement,
                  hasWebGl2: canvas instanceof HTMLCanvasElement && Boolean(canvas.getContext("webgl2")),
                  bodyWidth: document.body.scrollWidth,
                  bodyHeight: document.body.scrollHeight,
                  viewportWidth: window.innerWidth,
                  viewportHeight: window.innerHeight
                };
              })()`, true);
          const screenshotPath = path.join(
            app.getPath("temp"),
            suiteSmokeTestMode ? "PulseBench-suite-smoke.png" : "PulseBench-smoke.png",
          );
          const image = await window.webContents.capturePage();
          await writeFile(screenshotPath, image.toPNG());
          const label = suiteSmokeTestMode ? "PULSEBENCH_SUITE_SMOKE" : "PULSEBENCH_SMOKE";
          console.log(`${label}=${JSON.stringify({ ...rendererState, screenshotPath })}`);
          if (suiteSmokeTestMode && rendererState.state !== "completed") {
            app.exit(1);
            return;
          }
          app.quit();
        })().catch((error) => {
          console.error(`PULSEBENCH_SMOKE_ERROR=${safeErrorMessage(error)}`);
          app.exit(1);
        });
      }, 1_000);
    });
  }
  void window.loadFile(path.join(__dirname, "index.html"));
  return window;
}

app.whenReady().then(() => {
  app.setAppUserModelId("dev.pulsebench.windows");
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  registerIpcHandlers();
  mainWindow = createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
});

app.on("window-all-closed", () => {
  activeController?.cancel();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!activeCleanup) return;
  event.preventDefault();
  activeController?.cancel();
  void activeCleanup.then(() => app.quit());
});
