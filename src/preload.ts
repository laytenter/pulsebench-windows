import { contextBridge, ipcRenderer } from "electron";

import type { ProgressEvent } from "./types";

const IPC = {
  systemInfo: "pulsebench:v1:system-info",
  cpu: "pulsebench:v1:cpu",
  memory: "pulsebench:v1:memory",
  storage: "pulsebench:v1:storage",
  cancel: "pulsebench:v1:cancel",
  progress: "pulsebench:v1:progress",
  exportResults: "pulsebench:v1:export-results",
} as const;

contextBridge.exposeInMainWorld("pulsebench", {
  getSystemInfo: () => ipcRenderer.invoke(IPC.systemInfo),
  runCpu: () => ipcRenderer.invoke(IPC.cpu),
  runMemory: () => ipcRenderer.invoke(IPC.memory),
  runStorage: () => ipcRenderer.invoke(IPC.storage),
  cancel: () => ipcRenderer.invoke(IPC.cancel),
  exportResults: (payload: unknown) => ipcRenderer.invoke(IPC.exportResults, payload),
  onProgress: (listener: (event: ProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ProgressEvent) => {
      listener(progress);
    };
    ipcRenderer.on(IPC.progress, handler);
    return () => ipcRenderer.removeListener(IPC.progress, handler);
  },
});
