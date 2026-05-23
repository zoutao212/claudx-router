import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

interface SoulGenomeConfig {
  enabled?: boolean;
  tokenBudget?: number;
  memoryTopK?: number;
  mcpServer?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

interface McpRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

let mcpProcess: ChildProcess | null = null;
let mcpRequestId = 0;
let mcpPendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let mcpInitialized = false;
let mcpBuffer = "";

function getSoulGenomeConfig(): SoulGenomeConfig | null {
  try {
    const configPath = join(homedir(), ".claude-code-router", "config.json");
    const configText = readFileSync(configPath, "utf-8");
    const config = JSON.parse(configText);
    return config.SoulGenome || null;
  } catch {
    return null;
  }
}

async function startMcpProcess(config: SoulGenomeConfig): Promise<void> {
  if (mcpProcess || !config.mcpServer) return;

  const { command, args, env } = config.mcpServer;
  mcpProcess = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  mcpProcess.stdout?.setEncoding("utf-8");
  mcpProcess.stdout?.on("data", (chunk: string) => {
    mcpBuffer += chunk;
    const lines = mcpBuffer.split("\n");
    mcpBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response: McpResponse = JSON.parse(line);
        const pending = mcpPendingRequests.get(response.id);
        if (pending) {
          mcpPendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {}
    }
  });

  mcpProcess.stderr?.on("data", (chunk) => {
    // 忽略 stderr，MCP 服务器可能输出调试信息
  });

  mcpProcess.on("exit", () => {
    mcpProcess = null;
    mcpInitialized = false;
    mcpPendingRequests.forEach((pending) => pending.reject(new Error("MCP process exited")));
    mcpPendingRequests.clear();
  });

  // 发送初始化请求
  await callMcpMethod("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ccr-soul-genome", version: "1.0.0" },
  });

  mcpInitialized = true;
}

async function callMcpMethod(method: string, params?: Record<string, unknown>): Promise<unknown> {
  if (!mcpProcess || !mcpProcess.stdin) {
    throw new Error("MCP process not started");
  }

  const id = ++mcpRequestId;
  const request: McpRequest = { jsonrpc: "2.0", id, method, params };

  return new Promise((resolve, reject) => {
    mcpPendingRequests.set(id, { resolve, reject });
    mcpProcess!.stdin!.write(JSON.stringify(request) + "\n");

    setTimeout(() => {
      if (mcpPendingRequests.has(id)) {
        mcpPendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }
    }, 30000);
  });
}

async function callSoulInject(userInput: string, context: string, tokenBudget: number, memoryTopK: number): Promise<string> {
  const result = await callMcpMethod("tools/call", {
    name: "soul_inject",
    arguments: {
      user_input: userInput,
      context,
      token_budget: tokenBudget,
      memory_top_k: memoryTopK,
    },
  });

  if (Array.isArray(result) && result[0]?.type === "text") {
    return result[0].text;
  }

  throw new Error("Invalid soul_inject response");
}

export async function applySoulGenomeInjection(
  requestBody: any,
  logger?: any
): Promise<{ injected: boolean; reason?: string }> {
  const config = getSoulGenomeConfig();
  if (!config?.enabled) {
    return { injected: false, reason: "disabled" };
  }

  const messages = requestBody?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { injected: false, reason: "no_messages" };
  }

  // 检查是否已注入
  const alreadyInjected = messages.some((msg: any) =>
    String(msg?.content || "").includes("[CCR Soul Genome Auto Injection]")
  );
  if (alreadyInjected) {
    return { injected: false, reason: "already_injected" };
  }

  const lastUserMessage = messages.filter((msg: any) => msg?.role === "user").pop();
  if (!lastUserMessage) {
    return { injected: false, reason: "no_user_message" };
  }

  const userInput = typeof lastUserMessage.content === "string"
    ? lastUserMessage.content
    : Array.isArray(lastUserMessage.content)
      ? lastUserMessage.content.map((block: any) => block?.text || "").join(" ")
      : "";

  if (!userInput.trim()) {
    return { injected: false, reason: "empty_user_input" };
  }

  try {
    if (!mcpInitialized) {
      await startMcpProcess(config);
    }

    const soulText = await callSoulInject(
      userInput,
      `model=${requestBody.model}`,
      config.tokenBudget || 3000,
      config.memoryTopK || 5
    );

    const injectionMessage = {
      role: "system",
      content: `[CCR Soul Genome Auto Injection]\n\n${soulText}`,
    };

    const firstSystemIndex = messages.findIndex((msg: any) => msg?.role === "system");
    if (firstSystemIndex >= 0) {
      messages.splice(firstSystemIndex + 1, 0, injectionMessage);
    } else {
      messages.unshift(injectionMessage);
    }

    logger?.info?.({
      phase: "soul_genome_inject",
      injected: true,
      userInputLength: userInput.length,
      soulTextLength: soulText.length,
    }, "soul genome injected");

    return { injected: true };
  } catch (error: any) {
    logger?.warn?.({
      phase: "soul_genome_inject",
      injected: false,
      error: error.message,
    }, "soul genome injection failed");

    return { injected: false, reason: error.message };
  }
}

export async function applySoulGenomeInjectionForTest(
  requestBody: any,
  options: {
    enabled?: boolean;
    tokenBudget?: number;
    memoryTopK?: number;
    requestContext?: string;
    callSoulInject: (params: { userInput: string; context: string; tokenBudget: number; memoryTopK: number }) => Promise<string>;
    log?: (record: Record<string, unknown>) => void;
  }
): Promise<{ injected: boolean; reason?: string }> {
  if (!options.enabled) {
    return { injected: false, reason: "disabled" };
  }

  const messages = requestBody?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { injected: false, reason: "no_messages" };
  }

  const alreadyInjected = messages.some((msg: any) =>
    String(msg?.content || "").includes("[CCR Soul Genome Auto Injection]")
  );
  if (alreadyInjected) {
    return { injected: false, reason: "already_injected" };
  }

  const lastUserMessage = messages.filter((msg: any) => msg?.role === "user").pop();
  if (!lastUserMessage) {
    return { injected: false, reason: "no_user_message" };
  }

  const userInput = typeof lastUserMessage.content === "string"
    ? lastUserMessage.content
    : Array.isArray(lastUserMessage.content)
      ? lastUserMessage.content.map((block: any) => block?.text || "").join(" ")
      : "";

  if (!userInput.trim()) {
    return { injected: false, reason: "empty_user_input" };
  }

  try {
    const soulText = await options.callSoulInject({
      userInput,
      context: options.requestContext || "",
      tokenBudget: options.tokenBudget || 3000,
      memoryTopK: options.memoryTopK || 5,
    });

    const injectionMessage = {
      role: "system",
      content: `[CCR Soul Genome Auto Injection]\n\n${soulText}`,
    };

    const firstSystemIndex = messages.findIndex((msg: any) => msg?.role === "system");
    if (firstSystemIndex >= 0) {
      messages.splice(firstSystemIndex + 1, 0, injectionMessage);
    } else {
      messages.unshift(injectionMessage);
    }

    options.log?.({
      phase: "soul_genome_inject",
      injected: true,
      userInputLength: userInput.length,
      soulTextLength: soulText.length,
    });

    return { injected: true };
  } catch (error: any) {
    options.log?.({
      phase: "soul_genome_inject",
      injected: false,
      error: error.message,
    });

    return { injected: false, reason: error.message };
  }
}

export function stopMcpProcess(): void {
  if (mcpProcess) {
    mcpProcess.kill();
    mcpProcess = null;
    mcpInitialized = false;
  }
}
