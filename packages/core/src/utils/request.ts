import { ProxyAgent } from "undici";
import { UnifiedChatRequest } from "../types/llm";
import { redactHeaders, traceLog, traceStream } from "./trace-logger";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

let lastRequestBodySha256: string | null = null;
let lastRequestBodySha256AtMs = 0;

const cacheDebugRequestSummaries = new Map<string, Record<string, unknown>>();

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function sha256Short(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function getContentLength(content: any): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, item) => {
      if (item?.type === "text" && typeof item.text === "string") {
        return sum + item.text.length;
      }
      if (typeof item?.content === "string") {
        return sum + item.content.length;
      }
      return sum + JSON.stringify(item || "").length;
    }, 0);
  }
  return JSON.stringify(content || "").length;
}

function collectCacheControlLocations(request: any, messages: any[]): Array<Record<string, unknown>> {
  const locations: Array<Record<string, unknown>> = [];

  const scanBlocks = (blocks: any, base: Record<string, unknown>) => {
    if (!Array.isArray(blocks)) return;
    blocks.forEach((block: any, blockIndex: number) => {
      if (block?.cache_control) {
        locations.push({
          ...base,
          blockIndex,
          type: block?.type || "object",
          length: getContentLength([block]),
        });
      }
    });
  };

  if (Array.isArray(request?.system)) {
    scanBlocks(request.system, { location: "system" });
  }

  if (Array.isArray(request?.tools)) {
    request.tools.forEach((tool: any, toolIndex: number) => {
      if (tool?.cache_control) {
        locations.push({
          location: "tool",
          toolIndex,
          name: tool?.name || tool?.function?.name,
          length: JSON.stringify(tool || {}).length,
        });
      }
    });
  }

  messages.forEach((message: any, messageIndex: number) => {
    const content = message?.content;
    if (message?.cache_control) {
      locations.push({ messageIndex, role: message?.role, location: "message" });
    }
    if (!Array.isArray(content)) return;
    content.forEach((block: any, blockIndex: number) => {
      if (block?.cache_control) {
        locations.push({
          location: "message_content",
          messageIndex,
          blockIndex,
          role: message?.role,
          type: block?.type,
          length: getContentLength([block]),
        });
      }
    });
  });
  return locations;
}

function getCacheDebugLogPath(): string {
  const dir = process.env.CCR_CACHE_DEBUG_DIR ||
    join(process.env.USERPROFILE || process.env.HOME || ".", ".claude-code-router", "logs");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return join(dir, `cache-debug-${date}.jsonl`);
}

function estimateTokensFromChars(chars: number): number {
  // Rough estimator only for attribution. Anthropic tokenization differs, but this is
  // enough to identify whether a 30k-token gap comes from tools/system/messages.
  return Math.ceil(chars / 2);
}

function summarizeRequestForCacheAttribution(request: any): Record<string, unknown> {
  const system = Array.isArray(request?.system) ? request.system : [];
  const tools = Array.isArray(request?.tools) ? request.tools : [];
  const messages = Array.isArray(request?.messages) ? request.messages : [];

  const systemChars = system.reduce((sum: number, block: any) => {
    return sum + (typeof block?.text === "string" ? block.text.length : JSON.stringify(block || "").length);
  }, 0);
  const toolsChars = JSON.stringify(tools || []).length;
  const messagesChars = messages.reduce((sum: number, msg: any) => sum + getContentLength(msg?.content), 0);

  const sections = {
    system: { chars: systemChars, estTokens: estimateTokensFromChars(systemChars), hash: sha256Short(system) },
    tools: { chars: toolsChars, estTokens: estimateTokensFromChars(toolsChars), hash: sha256Short(tools) },
    messages: { chars: messagesChars, estTokens: estimateTokensFromChars(messagesChars), hash: sha256Short(messages) },
  };

  const cacheControls = collectCacheControlLocations(request, messages);
  const breakpointCandidates = cacheControls.map((location: any) => {
    let likelyCoverage = "unknown";
    if (location.location === "system") {
      likelyCoverage = "system-only-or-prefix-through-system";
    } else if (location.location === "tool") {
      likelyCoverage = "tools-only-or-prefix-through-tools";
    } else if (location.location === "message_content") {
      likelyCoverage = "prefix-through-message-content";
    }
    return { ...location, likelyCoverage };
  });

  const bodyJson = JSON.stringify(request);
  const withoutCacheControl = JSON.parse(bodyJson, (key, value) => key === "cache_control" ? undefined : value);
  const firstMessage = messages.length > 0 ? messages[0] : undefined;
  const stripCacheControl = (value: unknown) => JSON.parse(JSON.stringify(value), (key, item) =>
    key === "cache_control" ? undefined : item
  );
  const noCacheSystem = stripCacheControl(system);
  const noCacheTools = stripCacheControl(tools);
  const noCacheFirstMessage = firstMessage ? stripCacheControl(firstMessage) : undefined;

  const cacheKeyProbe = {
    systemOnlyHash: sha256Short(system),
    toolsOnlyHash: sha256Short(tools),
    firstMessageHash: sha256Short(firstMessage),
    systemThenToolsHash: sha256Short({ system, tools }),
    toolsThenSystemHash: sha256Short({ tools, system }),
    systemThenToolsThenFirstMessageHash: sha256Short({ system, tools, firstMessage }),
    toolsThenSystemThenFirstMessageHash: sha256Short({ tools, system, firstMessage }),
    noCacheControl: {
      systemOnlyHash: sha256Short(noCacheSystem),
      toolsOnlyHash: sha256Short(noCacheTools),
      firstMessageHash: sha256Short(noCacheFirstMessage),
      systemThenToolsHash: sha256Short({ system: noCacheSystem, tools: noCacheTools }),
      toolsThenSystemHash: sha256Short({ tools: noCacheTools, system: noCacheSystem }),
      systemThenToolsThenFirstMessageHash: sha256Short({
        system: noCacheSystem,
        tools: noCacheTools,
        firstMessage: noCacheFirstMessage,
      }),
      toolsThenSystemThenFirstMessageHash: sha256Short({
        tools: noCacheTools,
        system: noCacheSystem,
        firstMessage: noCacheFirstMessage,
      }),
      bodyHash: sha256Short(withoutCacheControl),
    },
  };

  return {
    sections,
    wire: {
      bodyBytes: Buffer.byteLength(bodyJson, "utf8"),
      bodyHash: createHash("sha256").update(bodyJson).digest("hex").slice(0, 16),
      bodyNoCacheControlHash: sha256Short(withoutCacheControl),
      systemBytes: Buffer.byteLength(JSON.stringify(request?.system || []), "utf8"),
      toolsBytes: Buffer.byteLength(JSON.stringify(tools || []), "utf8"),
      messagesBytes: Buffer.byteLength(JSON.stringify(messages || []), "utf8"),
      topLevelFieldOrder: Object.keys(request || {}),
    },
    cacheKeyProbe,
    cacheControls,
    breakpointCandidates,
    fullBodyHash: sha256Short(request),
  };
}

function appendCacheDebugRecord(record: Record<string, unknown>): void {
  appendFileSync(getCacheDebugLogPath(), JSON.stringify(record) + "\n", "utf-8");
}

export function writeCacheUsageDebug(reqId: string | undefined, usage: Record<string, unknown>, meta: Record<string, unknown> = {}): void {
  if (process.env.CCR_CACHE_DEBUG !== "1") return;
  try {
    const requestSummary = reqId ? cacheDebugRequestSummaries.get(reqId) : undefined;
    appendCacheDebugRecord({
      ts: new Date().toISOString(),
      kind: "cache_usage_attribution",
      reqId,
      usage,
      meta,
      requestSummary,
    });
  } catch {
    // ignore debug log errors
  }
}

function writeCacheDebugLog(reqId: string | undefined, request: any, summary: Record<string, unknown>): void {
  try {
    const system = request?.system;
    const tools = request?.tools;
    const messages = Array.isArray(request?.messages) ? request.messages : [];

    // Compute per-block hashes for system
    const systemBlocks = Array.isArray(system) ? system.map((block: any, i: number) => ({
      index: i,
      type: block?.type,
      length: typeof block?.text === "string" ? block.text.length : JSON.stringify(block || "").length,
      hasCacheControl: !!block?.cache_control,
      hash: sha256Short(block),
      preview: typeof block?.text === "string" ? block.text.slice(0, 80) + "..." : undefined,
    })) : typeof system === "string" ? [{ type: "string", length: system.length, hash: sha256Short(system) }] : [];

    // Compute per-tool hash (just first and last for brevity)
    const toolsSummary = Array.isArray(tools) ? {
      count: tools.length,
      names: tools.map((tool: any) => tool?.name || tool?.function?.name).filter(Boolean),
      totalChars: JSON.stringify(tools).length,
      lastToolHash: tools.length > 0 ? sha256Short(tools[tools.length - 1]) : undefined,
      lastToolHasCacheControl: tools.length > 0 ? !!tools[tools.length - 1]?.cache_control : false,
      allToolsHash: sha256Short(tools),
    } : undefined;

    // Per-message structure (content hash, cache_control presence)
    const messagesDetail = messages.map((msg: any, i: number) => {
      const content = msg?.content;
      const blocks = Array.isArray(content) ? content : [];
      return {
        index: i,
        role: msg?.role,
        blockCount: blocks.length,
        totalLength: getContentLength(content),
        contentHash: sha256Short(content),
        blocks: blocks.slice(0, 3).map((b: any, j: number) => ({
          index: j,
          type: b?.type,
          length: typeof b?.text === "string" ? b.text.length :
                  typeof b?.content === "string" ? b.content.length :
                  JSON.stringify(b || "").length,
          hasCacheControl: !!b?.cache_control,
          hash: sha256Short(b),
        })),
      };
    });

    // Full body hash (what actually gets sent)
    const fullBodyHash = sha256Short(request);
    const cacheAttributionSummary = summarizeRequestForCacheAttribution(request);
    if (reqId) {
      cacheDebugRequestSummaries.set(reqId, cacheAttributionSummary);
      // Avoid unbounded growth in long-running processes.
      if (cacheDebugRequestSummaries.size > 200) {
        const oldestKey = cacheDebugRequestSummaries.keys().next().value;
        if (oldestKey) cacheDebugRequestSummaries.delete(oldestKey);
      }
    }

    const record = {
      ts: new Date().toISOString(),
      kind: "cache_request_structure",
      reqId,
      fullBodyHash,
      cacheAttributionSummary,
      systemBlocks,
      toolsSummary,
      messagesDetail,
      summary,
    };

    appendCacheDebugRecord(record);
  } catch {
    // Silently ignore debug log errors
  }
}

function buildCacheTraceSummary(request: any): Record<string, unknown> {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const topLevelSystem = Array.isArray(request?.system)
    ? request.system
    : typeof request?.system === "string"
      ? [{ type: "text", text: request.system }]
      : [];
  const systemMessages = messages.filter((message: any) => message?.role === "system");
  const nonSystemMessages = messages.filter((message: any) => message?.role !== "system");
  const tools = Array.isArray(request?.tools) ? request.tools : [];
  const prefixMessages = nonSystemMessages.slice(0, Math.max(0, nonSystemMessages.length - 1));
  const messageLengths = messages.map((message: any, index: number) => ({
    index,
    role: message?.role,
    length: getContentLength(message?.content),
  }));
  const largestMessages = [...messageLengths]
    .sort((a, b) => b.length - a.length)
    .slice(0, 5);

  const cacheControlLocations = collectCacheControlLocations(request, messages);
  const expectedCachedPrefixChars = cacheControlLocations.reduce((max: number, location: any) => {
    if (location.location === "system") {
      const index = typeof location.blockIndex === "number" ? location.blockIndex : -1;
      const chars = topLevelSystem
        .slice(0, index + 1)
        .reduce((sum: number, block: any) => sum + getContentLength([block]), 0);
      return Math.max(max, chars);
    }
    if (location.location === "message_content") {
      const messageIndex = typeof location.messageIndex === "number" ? location.messageIndex : -1;
      const blockIndex = typeof location.blockIndex === "number" ? location.blockIndex : -1;
      const systemChars = topLevelSystem.reduce((sum: number, block: any) => sum + getContentLength([block]), 0);
      const priorMessageChars = messages
        .slice(0, messageIndex)
        .reduce((sum: number, message: any) => sum + getContentLength(message?.content), 0);
      const message = messages[messageIndex];
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const blockChars = blocks
        .slice(0, blockIndex + 1)
        .reduce((sum: number, block: any) => sum + getContentLength([block]), 0);
      return Math.max(max, systemChars + priorMessageChars + blockChars);
    }
    return max;
  }, 0);

  // Hash message[0] separately to detect dynamic content injection (e.g. timestamps)
  const message0Hash = messages.length > 0 ? sha256Short(messages[0]?.content) : undefined;
  // Capture head/tail of message[0] content for visual diff across requests
  const message0Preview = (() => {
    if (messages.length === 0) return undefined;
    const content = messages[0]?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content) && content[0]?.text) {
      text = content[0].text;
    }
    if (!text) return undefined;
    const head = text.slice(0, 120);
    const tail = text.slice(-120);
    return { head, tail };
  })();

  return {
    model: request?.model,
    stream: request?.stream,
    streamIncludeUsage: request?.stream_options?.include_usage === true,
    messageCount: messages.length,
    systemCount: topLevelSystem.length + systemMessages.length,
    toolCount: tools.length,
    totalMessageChars: messageLengths.reduce((sum, item) => sum + item.length, 0),
    topLevelSystemChars: topLevelSystem.reduce((sum: number, block: any) => sum + getContentLength([block]), 0),
    prefixChars: prefixMessages.reduce((sum: number, message: any) => sum + getContentLength(message?.content), 0),
    largestMessages,
    cacheControlLocations,
    expectedCachedPrefixChars,
    expectedCachedPrefixEstTokens: estimateTokensFromChars(expectedCachedPrefixChars),
    systemHash: sha256Short(topLevelSystem),
    toolsHash: sha256Short(tools),
    message0Hash,
    message0Preview,
    prefixHash: sha256Short(prefixMessages),
    fullMessagesHash: sha256Short(messages),
  };
}

export function sendUnifiedRequest(
  url: URL | string,
  request: UnifiedChatRequest,
  config: any,
  context: any,
  logger?: any
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (config.headers) {
    Object.entries(config.headers).forEach(([key, value]) => {
      if (value) {
        headers.set(key, value as string);
      }
    });
  }
  let combinedSignal: AbortSignal;
  const timeoutSignal = AbortSignal.timeout(config.TIMEOUT ?? 60 * 1000 * 60);

  if (config.signal) {
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    config.signal.addEventListener("abort", abortHandler);
    timeoutSignal.addEventListener("abort", abortHandler);
    combinedSignal = controller.signal;
  } else {
    combinedSignal = timeoutSignal;
  }

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(request),
    signal: combinedSignal,
  };

  const headerObject: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerObject[key] = value;
  });

  const cacheTraceSummary = buildCacheTraceSummary(request);

  // CACHE_DEBUG: write detailed request body analysis to a separate log file
  if (process.env.CCR_CACHE_DEBUG === "1") {
    writeCacheDebugLog(context?.req?.id, request, cacheTraceSummary);
  }

  logger?.info?.(
    {
      reqId: context?.req?.id,
      requestUrl: typeof url === "string" ? url : url.toString(),
      cacheTraceSummary,
    },
    "upstream cache trace"
  );

  traceLog({
    phase: "upstream_request",
    reqId: context?.req?.id,
    requestUrl: typeof url === "string" ? url : url.toString(),
    method: fetchOptions.method,
    headers: redactHeaders(headerObject),
    body: request,
    cacheTraceSummary,
    useProxy: config.httpsProxy,
  });

  if (config.httpsProxy) {
    (fetchOptions as any).dispatcher = new ProxyAgent(
      new URL(config.httpsProxy).toString()
    );
  }

  const bodyStr = typeof fetchOptions.body === "string" ? fetchOptions.body : "";
  const bodyByteLength = Buffer.byteLength(bodyStr, "utf8");
  const bodySha256 = createHash("sha256").update(bodyStr).digest("hex");
  const nowMs = Date.now();
  const possible_retry =
    lastRequestBodySha256 === bodySha256 && nowMs - lastRequestBodySha256AtMs <= 5_000;
  lastRequestBodySha256 = bodySha256;
  lastRequestBodySha256AtMs = nowMs;

  const retryMax = Number.parseInt(process.env.CCR_UPSTREAM_RETRY_MAX || "2", 10);
  const retryTotalMs = Number.parseInt(process.env.CCR_UPSTREAM_RETRY_TOTAL_MS || "5000", 10);
  const retryBaseMs = Number.parseInt(process.env.CCR_UPSTREAM_RETRY_BASE_MS || "300", 10);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const shouldRetryStatus = (status: number) => status === 502 || status === 503 || status === 504;

  const shouldRetryResponse = (response: Response) => {
    const ct = response.headers.get("Content-Type") || "";
    // Never retry once the upstream is a stream. Retrying would duplicate side effects
    // and is not safe after the body starts.
    if (ct.includes("text/event-stream")) return false;
    return shouldRetryStatus(response.status);
  };

  logger?.debug(
    {
      reqId: context.req.id,
      request: fetchOptions,
      headers: headerObject,
      bodyByteLength,
      bodySha256,
      retryHint: {
        possible_retry,
        windowMs: 5_000,
      },
      retryAttempt: 0,
      retryMax,
      requestUrl: typeof url === "string" ? url : url.toString(),
      useProxy: config.httpsProxy,
    },
    "final request"
  );

  const fetchWithRetries = async () => {
    const requestUrl = typeof url === "string" ? url : url.toString();
    const startMs = Date.now();

    for (let attempt = 0; attempt <= retryMax; attempt++) {
      try {
        const response = await fetch(requestUrl, fetchOptions);

        if (attempt < retryMax && shouldRetryResponse(response)) {
          logger?.warn?.(
            {
              reqId: context.req.id,
              bodySha256,
              retryAttempt: attempt + 1,
              retryMax,
              status: response.status,
              requestUrl,
            },
            "upstream_retry"
          );
          const elapsed = Date.now() - startMs;
          const delay = Math.min(retryBaseMs * Math.pow(2, attempt), 2_000);
          if (elapsed + delay > retryTotalMs) {
            return response;
          }

          // Drain/close body quickly to free resources before retry
          // IMPORTANT: only do this if we are actually going to retry.
          try {
            response.body?.cancel();
          } catch {}

          await sleep(delay);
          continue;
        }

        return response;
      } catch (error) {
        if (attempt < retryMax) {
          logger?.warn?.(
            {
              reqId: context.req.id,
              bodySha256,
              retryAttempt: attempt + 1,
              retryMax,
              retryTotalMs,
              retryBaseMs,
              error: error instanceof Error ? error.message : String(error),
              requestUrl,
            },
            "upstream_retry"
          );
          const elapsed = Date.now() - startMs;
          const delay = Math.min(retryBaseMs * Math.pow(2, attempt), 2_000);
          if (elapsed + delay > retryTotalMs) {
            throw error;
          }
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }

    // unreachable
    return fetch(requestUrl, fetchOptions);
  };

  return fetchWithRetries().then(
    async (response) => {
      try {
        traceLog({
          phase: "upstream_response_headers",
          reqId: context?.req?.id,
          requestUrl: typeof url === "string" ? url : url.toString(),
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get("Content-Type"),
        });

        const ct = response.headers.get("Content-Type") || "";
        if (ct.includes("text/event-stream") && response.body) {
          const wrapped = await traceStream({
            reqId: context?.req?.id,
            stream: response.body as any,
            phase: "upstream_sse",
            meta: {
              requestUrl: typeof url === "string" ? url : url.toString(),
              status: response.status,
            },
          });
          return new Response(wrapped as any, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        if (ct.includes("application/json")) {
          try {
            const cloned = response.clone();
            void cloned.text().then((text) => {
              traceLog({
                phase: "upstream_response_body",
                reqId: context?.req?.id,
                requestUrl: typeof url === "string" ? url : url.toString(),
                status: response.status,
                contentType: ct,
                bodyText: text,
              });
            });
          } catch {
            traceLog({
              phase: "upstream_response_clone_failed",
              reqId: context?.req?.id,
              requestUrl: typeof url === "string" ? url : url.toString(),
            });
          }
        }
      } catch {
        traceLog({
          phase: "upstream_trace_failed",
          reqId: context?.req?.id,
        });
      }

      return response;
    }
  );
}
