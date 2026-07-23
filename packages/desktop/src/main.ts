import { preserveConfiguredSecrets, readConfigDocument, redactConfig, writeConfigDocument } from "@CCR/shared";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type ServicePhase = "stopped" | "starting" | "running" | "failed";

export interface DesktopStatus {
  phase: ServicePhase;
  endpoint: string;
  pid?: number;
  startedAt?: string;
  lastError?: string;
}

const defaultEndpoint = "http://127.0.0.1:3456";
const configDirectory = join(homedir(), ".claude-code-router");
const serverEntry = resolve(__dirname, "../../server/dist/index.js");

class ServiceSupervisor {
  private child?: ChildProcess;
  private childOutput = "";
  private status: DesktopStatus = { phase: "stopped", endpoint: defaultEndpoint };

  getStatus = (): DesktopStatus => ({ ...this.status });

  async start(): Promise<DesktopStatus> {
    if (this.status.phase === "running" || this.status.phase === "starting") {
      return this.getStatus();
    }

    if (!existsSync(serverEntry)) {
      this.status = {
        phase: "failed",
        endpoint: defaultEndpoint,
        lastError: `Server build not found: ${serverEntry}`,
      };
      return this.getStatus();
    }

    await mkdir(configDirectory, { recursive: true });
    const endpoints = await this.resolveCandidateEndpoints();
    await this.stopExistingService(endpoints[0]);
    this.status = { phase: "starting", endpoint: endpoints[0] };

    const child = spawn(process.execPath, [serverEntry], {
      cwd: dirname(serverEntry),
      detached: false,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.childOutput = "";
    const captureOutput = (chunk: Buffer) => {
      this.childOutput = `${this.childOutput}${chunk.toString("utf8")}`.slice(-4_000);
    };
    child.stdout?.on("data", captureOutput);
    child.stderr?.on("data", captureOutput);

    child.once("error", (error) => {
      this.status = { phase: "failed", endpoint: defaultEndpoint, lastError: error.message };
      this.child = undefined;
    });
    child.once("exit", (code, signal) => {
      if (this.status.phase !== "stopped") {
        this.status = {
          phase: "failed",
          endpoint: defaultEndpoint,
          lastError: this.formatChildFailure(signal ?? code ?? "unknown"),
        };
      }
      this.child = undefined;
    });

    await this.waitForHealth(endpoints);
    return this.getStatus();
  }

  async stop(): Promise<DesktopStatus> {
    const child = this.child;
    this.child = undefined;
    this.status = { phase: "stopped", endpoint: defaultEndpoint };

    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      const didExit = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);

      if (!didExit) {
        this.status = {
          phase: "failed",
          endpoint: defaultEndpoint,
          lastError: "CCR process did not stop within 5 seconds; refusing to start a second instance.",
        };
      }
    }
    return this.getStatus();
  }

  async restart(): Promise<DesktopStatus> {
    const stopped = await this.stop();
    return stopped.phase === "failed" ? stopped : this.start();
  }

  private formatChildFailure(exit: string | number): string {
    const lines = this.childOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const detail = lines.slice(-3).join(" · ");
    return detail ? `CCR exited (${exit}): ${detail}` : `CCR exited (${exit})`;
  }

  private async stopExistingService(endpoint: string): Promise<void> {
    const apiKey = await this.getConfiguredApiKey();
    if (!apiKey) return;

    try {
      const headers = { Authorization: `Bearer ${apiKey}` };
      const status = await fetch(`${endpoint}/api/status`, {
        headers,
        signal: AbortSignal.timeout(1_000),
      });
      if (!status.ok) return;

      const payload = (await status.json()) as { ok?: boolean };
      if (!payload.ok) return;

      await fetch(`${endpoint}/api/restart`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(1_000),
      });

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) });
          if (!response.ok) return;
        } catch {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch {
      // Only a compatible CCR instance with the configured API key is restarted.
    }
  }

  private async resolveCandidateEndpoints(): Promise<string[]> {
    try {
      const document = await readConfigDocument();
      const configuredPort = Number(document.value.PORT) || 3456;
      const configuredHost = typeof document.value.HOST === "string" ? document.value.HOST : "127.0.0.1";
      const host = configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
      return [`http://${host}:${configuredPort}`];
    } catch {
      return [defaultEndpoint];
    }
  }

  async getConfiguredApiKey(): Promise<string | undefined> {
    try {
      const document = await readConfigDocument();
      return typeof document.value.APIKEY === "string" && document.value.APIKEY ? document.value.APIKEY : undefined;
    } catch {
      return undefined;
    }
  }

  private async waitForHealth(endpoints: string[]): Promise<void> {
    const apiKey = await this.getConfiguredApiKey();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const child = this.child;
      if (!child || child.exitCode !== null) return;
      for (const endpoint of endpoints) {
        try {
          const response = await fetch(`${endpoint}/api/status`, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
            signal: AbortSignal.timeout(1_000),
          });
          if (!response.ok) continue;
          const payload = (await response.json()) as { endpoint?: string; ok?: boolean; pid?: number };
          if (!payload.ok || payload.pid !== child.pid) continue;
          this.status = {
            phase: "running",
            endpoint: payload.endpoint ?? endpoint,
            pid: child.pid,
            startedAt: new Date().toISOString(),
          };
          return;
        } catch {
          // A different process may occupy the configured port while CCR starts.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (this.child?.exitCode === null) {
      this.child.kill();
      this.status = {
        phase: "failed",
        endpoint: endpoints[0],
        pid: this.child.pid,
        lastError: "CCR did not claim its configured port within 15 seconds.",
      };
    }
  }
}

const supervisor = new ServiceSupervisor();
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let isQuitting = false;

const trayIconPath = join(__dirname, "tray.png");
let trayIcon = nativeImage.createFromPath(trayIconPath).resize({ width: 16, height: 16 });

if (trayIcon.isEmpty()) {
  console.warn(`Desktop tray icon could not be loaded: ${trayIconPath}`);
  trayIcon = nativeImage.createEmpty();
}

const createWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#191919",
    icon: trayIcon,
    show: false,
    titleBarStyle: "hidden",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());

  await mainWindow.loadFile(join(__dirname, "renderer", "index.html"));
};

const showWindow = () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

const createTray = () => {
  tray = new Tray(trayIcon);
  tray.setToolTip("Claude Code Router");
  tray.on("click", showWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开控制台", click: showWindow },
    { label: "启动服务", click: () => void supervisor.start() },
    { label: "停止服务", click: () => void supervisor.stop() },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
};

const registerIpc = () => {
  ipcMain.handle("desktop:window-minimize", () => mainWindow?.minimize());
  ipcMain.handle("desktop:window-toggle-maximize", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle("desktop:window-close", () => mainWindow?.hide());
  ipcMain.handle("desktop:status", () => supervisor.getStatus());
  ipcMain.handle("desktop:start", () => supervisor.start());
  ipcMain.handle("desktop:stop", () => supervisor.stop());
  ipcMain.handle("desktop:restart", () => supervisor.restart());
  ipcMain.handle("desktop:open-logs", async () => {
    await mkdir(join(configDirectory, "logs"), { recursive: true });
    return shell.openPath(join(configDirectory, "logs"));
  });
  ipcMain.handle("desktop:get-config", async () => {
    const document = await readConfigDocument();
    return {
      config: redactConfig(document.value),
      revision: document.revision,
      sourceWillBeFormatted: true,
    };
  });
  ipcMain.handle("desktop:get-runtime-events", async () => {
    const status = supervisor.getStatus();
    if (status.phase !== "running") return { events: [] };

    const apiKey = await supervisor.getConfiguredApiKey();
    const response = await fetch(`${status.endpoint}/api/runtime-events?limit=100`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) {
      throw new Error(`Could not read runtime events: ${response.status}`);
    }
    return response.json();
  });
  ipcMain.handle("desktop:save-config", async (_event, proposedConfig: unknown, revision: string) => {
    const current = await readConfigDocument();
    const merged = preserveConfiguredSecrets(proposedConfig, current.value);
    return writeConfigDocument(merged, revision);
  });
  ipcMain.handle("desktop:confirm-stop", async () => {
    const response = await dialog.showMessageBox(mainWindow!, {
      type: "question",
      message: "停止 Claude Code Router 服务？",
      detail: "当前正在使用此本地 API 的客户端会断开连接。",
      buttons: ["取消", "停止"],
      defaultId: 0,
      cancelId: 0,
    });
    return response.response === 1;
  });
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId("com.musistudio.claude-code-router");
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    registerIpc();
    createTray();
    await createWindow();
    void supervisor.start();
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  void supervisor.stop();
});