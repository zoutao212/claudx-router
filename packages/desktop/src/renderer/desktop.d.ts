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

interface DesktopApi {
  getStatus(): Promise<DesktopStatus>;
  start(): Promise<DesktopStatus>;
  stop(): Promise<DesktopStatus>;
  restart(): Promise<DesktopStatus>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  openLogs(): Promise<string>;
  getConfig(): Promise<ConfigSnapshot>;
  getRuntimeEvents(): Promise<RuntimeEventSnapshot>;
  getRuntimeMetrics(): Promise<RuntimeMetricsSnapshot>;
  saveConfig(config: unknown, revision: string): Promise<ConfigWriteResult>;
  confirmStop(): Promise<boolean>;
}

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}

export {};