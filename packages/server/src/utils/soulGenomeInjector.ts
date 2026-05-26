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

const CCR_SOUL_MARKER = "[CCR Soul Genome Auto Injection]";

/**
 * 检查是否已有 CCR 灵魂注入标记（同时检查 messages 和顶层 system 字段）
 */
function isAlreadyInjected(requestBody: any): boolean {
  const messages = requestBody?.messages;
  if (Array.isArray(messages)) {
    const found = messages.some((msg: any) =>
      String(msg?.content || "").includes(CCR_SOUL_MARKER)
    );
    if (found) return true;
  }

  // Anthropic 格式：顶层 system 字段
  const system = requestBody?.system;
  if (typeof system === "string" && system.includes(CCR_SOUL_MARKER)) return true;
  if (Array.isArray(system)) {
    if (system.some((block: any) =>
      String(block?.text || block?.content || "").includes(CCR_SOUL_MARKER)
    )) return true;
  }

  return false;
}

/**
 * 从请求体中提取最后一条用户消息文本
 * 同时兼容 OpenAI 格式（messages 包含所有角色）和 Anthropic 格式（messages 只有 user/assistant）
 */
function extractLastUserInput(requestBody: any): string | null {
  const messages = requestBody?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const lastUserMessage = messages.filter((msg: any) => msg?.role === "user").pop();
  if (!lastUserMessage) return null;

  const content = lastUserMessage.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block: any) => block?.text || "").join(" ");
  }
  return null;
}

/**
 * 将灵魂注入内容插入请求体
 * - OpenAI 格式（/v1/chat/completions, /v1/responses）：插入 system role 消息到 messages 数组
 * - Anthropic 格式（/v1/messages）：插入到顶层 system 字段
 */
function insertInjection(requestBody: any, soulText: string, pathname: string): void {
  const isAnthropicEndpoint = pathname.endsWith("/v1/messages");

  if (isAnthropicEndpoint && requestBody.system != null) {
    // Anthropic 格式：注入到顶层 system 字段
    const injectionBlock = {
      type: "text",
      text: `${CCR_SOUL_MARKER}\n\n${soulText}`,
    };

    if (Array.isArray(requestBody.system)) {
      // 插到 system 数组末尾（最末位置，保持 cache_control 顺序）
      requestBody.system.push(injectionBlock);
    } else if (typeof requestBody.system === "string") {
      // 字符串形式，转换为数组
      requestBody.system = [
        { type: "text", text: requestBody.system },
        injectionBlock,
      ];
    }
  } else {
    // OpenAI 格式：注入 system role 消息到 messages
    const injectionMessage = {
      role: "system",
      content: `${CCR_SOUL_MARKER}\n\n${soulText}`,
    };

    const messages = requestBody.messages;
    const firstSystemIndex = messages.findIndex((msg: any) => msg?.role === "system");
    if (firstSystemIndex >= 0) {
      messages.splice(firstSystemIndex + 1, 0, injectionMessage);
    } else {
      messages.unshift(injectionMessage);
    }
  }
}

export async function applySoulGenomeInjection(
  requestBody: any,
  logger?: any,
  pathname?: string
): Promise<{ injected: boolean; reason?: string }> {
  const config = getSoulGenomeConfig();
  if (!config?.enabled) {
    return { injected: false, reason: "disabled" };
  }

  const messages = requestBody?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { injected: false, reason: "no_messages" };
  }

  // 检查是否已注入（同时检查 messages 和顶层 system）
  if (isAlreadyInjected(requestBody)) {
    return { injected: false, reason: "already_injected" };
  }

  const userInput = extractLastUserInput(requestBody);
  if (!userInput || !userInput.trim()) {
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

    insertInjection(requestBody, soulText, pathname || "");

    logger?.info?.({
      phase: "soul_genome_inject",
      injected: true,
      userInputLength: userInput.length,
      soulTextLength: soulText.length,
      pathname,
    }, "soul genome injected");

    return { injected: true };
  } catch (error: any) {
    logger?.warn?.({
      phase: "soul_genome_inject",
      injected: false,
      error: error.message,
      pathname,
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
