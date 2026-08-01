import { contextBridge, ipcRenderer } from "electron";

export type ServicePhase = "stopped" | "starting" | "running" | "failed";

export interface DesktopStatus {
  phase: ServicePhase;
  endpoint: string;
  pid?: number;
  startedAt?: string;
  lastError?: string;
}

export interface ConfigSnapshot {
  config: unknown;
  revision: string;
  sourceWillBeFormatted: boolean;
}

export interface RuntimeEvent {
  id: number;
  timestamp: string;
  level: "info" | "success" | "error";
  requestId?: string;
  provider?: string;
  model?: string;
  message: string;
  detail?: string;
  durationMs?: number;
}

export interface RuntimeEventSnapshot {
  events: RuntimeEvent[];
}

export interface RuntimeMetrics {
  requests: {
    total: number;
    successful: number;
    failed: number;
    active: number;
  };
  tokens: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reportedRequests: number;
  };
  cacheHitRate: number | null;
}

export interface RuntimeMetricsSnapshot {
  metrics: RuntimeMetrics | null;
}

export interface ConfigWriteResult {
  backupPath?: string;
  revision: string;
  sourceWillBeFormatted: boolean;
}

const desktop = {
  getStatus: (): Promise<DesktopStatus> => ipcRenderer.invoke("desktop:status"),
  start: (): Promise<DesktopStatus> => ipcRenderer.invoke("desktop:start"),
  stop: (): Promise<DesktopStatus> => ipcRenderer.invoke("desktop:stop"),
  restart: (): Promise<DesktopStatus> => ipcRenderer.invoke("desktop:restart"),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke("desktop:window-minimize"),
  toggleMaximizeWindow: (): Promise<boolean> => ipcRenderer.invoke("desktop:window-toggle-maximize"),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("desktop:window-close"),
  openLogs: (): Promise<string> => ipcRenderer.invoke("desktop:open-logs"),
  getConfig: (): Promise<ConfigSnapshot> => ipcRenderer.invoke("desktop:get-config"),
  getRuntimeEvents: (): Promise<RuntimeEventSnapshot> => ipcRenderer.invoke("desktop:get-runtime-events"),
  getRuntimeMetrics: (): Promise<RuntimeMetricsSnapshot> => ipcRenderer.invoke("desktop:get-runtime-metrics"),
  saveConfig: (config: unknown, revision: string): Promise<ConfigWriteResult> => ipcRenderer.invoke("desktop:save-config", config, revision),
  confirmStop: (): Promise<boolean> => ipcRenderer.invoke("desktop:confirm-stop"),
};

contextBridge.exposeInMainWorld("desktop", desktop);