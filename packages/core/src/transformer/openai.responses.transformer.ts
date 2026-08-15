import { createHash } from "node:crypto";
import {
  Annotation,
  LLMProvider,
  MessageContent,
  UnifiedChatRequest,
  UnifiedMessage,
} from "@/types/llm";
import { Transformer, TransformerContext } from "@/types/transformer";
import { writeCacheUsageDebug } from "@/utils/request";

interface ResponsesAPIAnnotation {
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

interface ResponsesAPIOutputContentItem {
  type: string;
  text?: string;
  image_url?: string;
  mime_type?: string;
  image_base64?: string;
  annotations?: ResponsesAPIAnnotation[];
}

interface ResponsesAPIOutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: ResponsesAPIOutputContentItem[];
  reasoning?: string;
}

interface ResponsesAPIUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}

interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
  };
}

function mapResponsesUsage(usage: ResponsesAPIUsage | undefined): ChatCompletionUsage | undefined {
  if (!usage) return undefined;

  const cachedTokens = usage.input_tokens_details?.cached_tokens;
  return {
    prompt_tokens: usage.input_tokens || 0,
    completion_tokens: usage.output_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    ...(typeof cachedTokens === "number"
      ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
      : {}),
  };
}

interface ResponsesAPIPayload {
  id: string;
  object: string;
  model: string;
  created_at: number;
  output: ResponsesAPIOutputItem[];
  usage?: ResponsesAPIUsage;
}

interface ResponsesStreamEvent {
  type: string;
  item_id?: string;
  output_index?: number;
  arguments?: string;
  annotation?: ResponsesAPIAnnotation;
  part?: {
    type?: string;
  };
  delta?:
    | string
    | {
        url?: string;
        b64_json?: string;
        mime_type?: string;
      };
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    content?: ResponsesAPIOutputContentItem[];
    reasoning?: string;
  };
  response?: {
    id?: string;
    model?: string;
    output?: Array<{
      type: string;
    }>;
    usage?: ResponsesAPIUsage;
  };
  reasoning_summary?: string;
  choices?: Array<{
    finish_reason?: string | null;
  }>;
}

export class OpenAIResponsesTransformer implements Transformer {
  name = "openai-responses";
  endPoint = "/v1/responses";
  logger?: any;
  private _encodingWarningLogged = false;

  private isResponsesRequest(request: Record<string, any>): boolean {
    return !Array.isArray(request?.messages) && (
      Object.prototype.hasOwnProperty.call(request || {}, "input") ||
      Object.prototype.hasOwnProperty.call(request || {}, "instructions")
    );
  }

  /**
   * Adapt the public Responses endpoint to the selected provider transport.
   * Native Responses providers keep the original wire payload; other providers
   * receive the existing Chat Completions compatibility conversion.
   */
  async auth(request: any, provider: LLMProvider): Promise<any> {
    const isResponsesRequest = this.isResponsesRequest(request);
    const headers = {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'text/event-stream, application/json, */*',
    };

    return {
      body: request,
      config: {
        url: isResponsesRequest
          ? this.buildResponsesUrl(provider.baseUrl)
          : this.buildChatCompletionsUrl(provider.baseUrl),
        headers,
      },
    };
  }

  async transformRequestOut(
    request: Record<string, any>,
    context?: TransformerContext
  ): Promise<UnifiedChatRequest> {
    const isResponsesRequest = this.isResponsesRequest(request);
    const providerUsesResponses = context?.provider?.transformer?.use?.some(
      (item: Transformer) => item?.name === this.name
    );

    // A Responses endpoint targeting a Responses provider is already in the wire format
    // required upstream. Preserve it so Responses-only capabilities are not downgraded.
    if (providerUsesResponses && isResponsesRequest) {
      return request as UnifiedChatRequest;
    }

    // Responses clients can still target Chat Completions providers through the endpoint adapter.
    if (isResponsesRequest) {
      return this.convertResponsesApiToChat(request);
    }
    return request as UnifiedChatRequest;
  }

  /**
   * Convert Responses API format (from Codex CLI) to Chat Completions format.
   */
  private convertResponsesApiToChat(req: Record<string, any>): UnifiedChatRequest {
    const messages: UnifiedMessage[] = [];

    // Extract instructions as system message
    if (req.instructions) {
      messages.push({
        role: "system",
        content: typeof req.instructions === "string" ? req.instructions : JSON.stringify(req.instructions),
      });
    }

    // Process input items
    const inputItems = Array.isArray(req.input) ? req.input : [{ type: "input_text", text: req.input }];
    for (const item of inputItems) {
      const converted = this.convertInputItemToMessage(item);
      if (converted) {
        if (Array.isArray(converted)) {
          messages.push(...converted);
        } else {
          messages.push(converted);
        }
      }
    }

    // Build tools in Chat Completions format
    let tools: any[] | undefined;
    if (Array.isArray(req.tools) && req.tools.length > 0) {
      tools = req.tools
        .filter((tool: any) => tool.type === "function")
        .map((tool: any) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description || "",
            parameters: tool.parameters || { type: "object", properties: {} },
          },
        }));
    }

    // Map reasoning effort
    let reasoning: any = undefined;
    if (req.reasoning?.effort) {
      reasoning = {
        effort: req.reasoning.effort as any,
        enabled: true,
      };
    }

    return {
      messages,
      model: req.model,
      stream: req.stream,
      tools: tools && tools.length > 0 ? tools : undefined,
      reasoning,
      temperature: req.temperature,
      max_tokens: req.max_output_tokens,
    } as any;
  }

  /**
   * Convert a single Responses API input item to a Chat Completions message.
   */
  private convertInputItemToMessage(item: any): UnifiedMessage | UnifiedMessage[] | null {
    // User text input
    if (item.type === "input_text" || (item.role === "user" && item.content && !item.type)) {
      const text = item.text || (typeof item.content === "string" ? item.content : "");
      if (text) {
        return { role: "user", content: text };
      }
      if (Array.isArray(item.content)) {
        return { role: "user", content: item.content };
      }
      return null;
    }

    // Assistant text output
    if (item.type === "output_text" || (item.role === "assistant" && item.content && !item.type)) {
      const text = item.text || (typeof item.content === "string" ? item.content : "");
      return { role: "assistant", content: text };
    }

    // Function call (assistant tool call)
    if (item.type === "function_call") {
      return {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id || `call_${Date.now()}`,
          type: "function" as const,
          function: {
            name: item.name || "",
            arguments: item.arguments || "{}",
          },
        }],
      };
    }

    // Function call output (tool result)
    if (item.type === "function_call_output") {
      return {
        role: "tool",
        content: item.output || "",
        tool_call_id: item.call_id || "",
      };
    }

    // Simple role-based message
    if (item.role === "user" || item.role === "assistant") {
      return {
        role: item.role as "user" | "assistant",
        content: typeof item.content === "string" ? item.content : JSON.stringify(item.content || ""),
      };
    }

    return null;
  }

  private getConversationId(context?: TransformerContext): string | undefined {
    const headers = context?.req?.headers;
    const value = typeof headers?.get === "function"
      ? headers.get("x-conversation-id")
      : headers?.["x-conversation-id"];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private derivePromptCacheKey(request: Record<string, any>): string | undefined {
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const input = Array.isArray(request.input) ? request.input : [];
    const firstConversationItem = messages.find((message: any) => message?.role !== "system")
      ?? input[0];

    if (!firstConversationItem) return undefined;

    const stableIdentity = {
      model: request.model,
      instructions: request.instructions
        ?? request.system
        ?? messages.filter((message: any) => message?.role === "system"),
      tools: request.tools ?? [],
      firstConversationItem,
    };
    const digest = createHash("sha256")
      .update(JSON.stringify(stableIdentity))
      .digest("hex")
      .slice(0, 32);
    return `ccr:${digest}`;
  }

  private getPromptCacheKey(request: Record<string, any>, context?: TransformerContext): string | undefined {
    if (typeof request.prompt_cache_key === "string" && request.prompt_cache_key.trim()) {
      return request.prompt_cache_key.trim();
    }
    if (!String(request.model || "").toLowerCase().includes("gpt")) {
      return undefined;
    }
    const conversationId = this.getConversationId(context);
    return conversationId
      ? `cursor:${conversationId}`
      : this.derivePromptCacheKey(request);
  }

  private getInstructionText(content: UnifiedMessage["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((item): item is Extract<MessageContent, { type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n");
  }

  private normalizeResponsesContent(
    content: UnifiedMessage["content"],
    role: UnifiedMessage["role"]
  ): Array<Record<string, unknown>> {
    if (typeof content === "string") {
      return content.length > 0
        ? [{ type: role === "assistant" ? "output_text" : "input_text", text: content }]
        : [];
    }
    if (!Array.isArray(content)) return [];
    return content
      .map((item) => this.normalizeRequestContent(item, role))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  private normalizeResponsesInput(messages: UnifiedMessage[]): any[] {
    return messages.flatMap((message): any[] => {
      if (message.role === "system") return [];
      if (message.role === "tool") {
        return [{
          type: "function_call_output",
          call_id: message.tool_call_id || "",
          output: typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content || ""),
        }];
      }

      const content = this.normalizeResponsesContent(message.content, message.role);
      const messageItems = content.length > 0
        ? [{ role: message.role, content }]
        : [];
      // DeepSeek 在 thinking 模式下要求把上一轮的思维链以 reasoning item 回传，
      // 否则带 tools 的续传请求会返回 400（reasoning_text must be passed back）。
      // reasoning item 需要紧邻它所属的 assistant 消息（官方会 merge 进相邻消息）。
      // 优先取 transformRequestOut 提取的 message.thinking；若客户端回传的 thinking 块
      // 缺少 signature 导致未被提取，则从 content 数组中的 thinking 块兜底。
      let thinkingContent: string | undefined =
        (message as any).thinking?.content;
      if (!thinkingContent && Array.isArray(message.content)) {
        const thinkingBlock = (message.content as any[]).find(
          (block) => block?.type === "thinking" && typeof block.thinking === "string"
        );
        thinkingContent = thinkingBlock?.thinking;
      }
      const reasoningItems = message.role === "assistant" && thinkingContent
        ? [{
            type: "reasoning",
            content: thinkingContent as string,
          }]
        : [];
      const toolItems = message.role === "assistant" && Array.isArray(message.tool_calls)
        ? message.tool_calls.map((tool) => ({
            type: "function_call",
            arguments: tool.function.arguments,
            name: tool.function.name,
            call_id: tool.id,
            status: "completed",
          }))
        : [];
      return [...reasoningItems, ...messageItems, ...toolItems];
    });
  }

  private normalizeResponsesTools(tools: any[]): any[] {
    const functionTools = tools
      .filter((tool) => tool?.type === "function" && tool?.function?.name !== "web_search")
      .map((tool) => {
        const parameters = {
          ...(tool.function.parameters || { type: "object" }),
          properties: { ...(tool.function.parameters?.properties || {}) },
        };
        if (tool.function.name === "WebSearch") {
          delete parameters.properties.allowed_domains;
        }
        if (tool.function.name === "Edit") {
          parameters.required = ["file_path", "old_string", "new_string", "replace_all"];
        }
        return {
          type: "function",
          name: tool.function.name,
          description: tool.function.description || "",
          parameters,
          ...(tool.function.name === "Edit" ? { strict: true } : {}),
        };
      });

    return tools.some((tool) => tool?.function?.name === "web_search")
      ? [...functionTools, { type: "web_search" }]
      : functionTools;
  }

  private buildResponsesRequest(
    request: UnifiedChatRequest,
    context?: TransformerContext
  ): Record<string, any> {
    const source = request as any;
    const {
      messages: _messages,
      tools: _tools,
      temperature: _temperature,
      max_tokens: _maxTokens,
      max_completion_tokens: _maxCompletionTokens,
      stream_options: _streamOptions,
      ...rest
    } = source;
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const instructions = messages
      .filter((message) => message.role === "system")
      .map((message) => this.getInstructionText(message.content))
      .filter((text) => text.length > 0)
      .join("\n\n");
    const input = this.normalizeResponsesInput(messages);
    const tools = Array.isArray(request.tools)
      ? this.normalizeResponsesTools(request.tools)
      : [];
    const promptCacheKey = this.getPromptCacheKey(source, context);
    const maxOutputTokens = source.max_output_tokens
      ?? source.max_completion_tokens
      ?? source.max_tokens;
    const reasoning = request.reasoning
      ? { effort: request.reasoning.effort, summary: "detailed" }
      : undefined;

    return {
      ...rest,
      ...(instructions ? { instructions } : {}),
      input,
      ...(tools.length > 0 ? { tools } : {}),
      ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
      ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      ...(reasoning ? { reasoning } : {}),
      store: source.store ?? false,
      parallel_tool_calls: false,
    };
  }

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider,
    context?: TransformerContext
  ): Promise<UnifiedChatRequest | { body: UnifiedChatRequest; config: { url: URL; headers: Record<string, string> } }> {
    const normalizedPath = new URL(provider.baseUrl).pathname.replace(/\/+$/, "");
    // Provider 是否显式配置了 openai-responses（api: "openai-responses" 或 transformer.use 含 openai-responses）。
    // 与 transformRequestOut 的判断一致：配置了 openai-responses 就意味着上游应使用 Responses 端点，
    // 不能仅凭 baseUrl 是否带 /responses 后缀来决定是否透传 Chat Completions 格式。
    const providerUsesResponses = provider.transformer?.use?.some(
      (item: Transformer) => item?.name === this.name
    );
    const responsesHeaders = {
      "Content-Type": "application/json; charset=utf-8",
      "Accept": "text/event-stream, application/json, */*",
      "Accept-Charset": "utf-8",
      "User-Agent": "claude-code-router/2.0.0",
    };

    if (this.isResponsesRequest(request as any)) {
      const source = request as any;
      const promptCacheKey = this.getPromptCacheKey(source, context);
      const body = {
        ...source,
        ...(source.reasoning
          ? { reasoning: { effort: source.reasoning.effort, summary: "detailed" } }
          : {}),
        ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
      };
      return {
        body,
        config: {
          url: this.buildResponsesUrl(provider.baseUrl),
          headers: responsesHeaders,
        } as any,
      };
    }

    if (
      (request as any).messages &&
      !(request as any).input &&
      !providerUsesResponses &&
      !normalizedPath.endsWith("/responses")
    ) {
      return {
        body: request,
        config: {
          url: this.buildChatCompletionsUrl(provider.baseUrl),
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "text/event-stream, application/json, */*",
          },
        },
      };
    }

    return {
      body: this.buildResponsesRequest(request, context) as UnifiedChatRequest,
      config: {
        url: this.buildResponsesUrl(provider.baseUrl),
        headers: responsesHeaders,
      } as any,
    };
  }

  async transformResponseOut(response: Response, context?: TransformerContext): Promise<Response> {
    const contentType = response.headers.get("Content-Type") || "";

    if (contentType.includes("application/json")) {
      const jsonResponse: any = await response.json();

      // 检查是否为responses API格式的JSON响应
      if (jsonResponse.object === "response" && jsonResponse.output) {
        if (jsonResponse.usage) {
          writeCacheUsageDebug(
            context?.req?.id,
            jsonResponse.usage,
            { source: "openai_responses_json" },
          );
        }
        const chatResponse = this.convertResponseToChat(jsonResponse);
        return new Response(JSON.stringify(chatResponse), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // 不是responses API格式，保持原样
      return new Response(JSON.stringify(jsonResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } else if (contentType.includes("text/event-stream")) {
      if (!response.body) {
        return response;
      }

      const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
      const encoder = new TextEncoder();
      let buffer = ""; // 用于缓冲不完整的数据
      let isStreamEnded = false;
      let isChatCompletionsFormat = false; // Detect if upstream returns Chat Completions format
      let hasCheckedFormat = false;

      const transformer = this;
      const stream = new ReadableStream({
        async start(controller) {
          const reader = response.body!.getReader();
          const toolArgsByItemId = new Map<string, string>();
          const toolMetaByItemId = new Map<string, { id: string; name: string }>();
          // 按 item 累积 DeepSeek 思维链增量文本，供 done 事件做剩余文本补全
          const reasoningTextByItemId = new Map<string, string>();

          // 索引跟踪变量，只有在事件类型切换时才增加索引
          let currentIndex = -1;
          let lastEventType = "";

          // 获取当前应该使用的索引的函数
          const getCurrentIndex = (eventType: string) => {
            if (eventType !== lastEventType) {
              currentIndex++;
              lastEventType = eventType;
            }
            return currentIndex;
          };

          // 安全的JSON解析函数，处理不完整的JSON数据
          const safeJsonParse = (jsonStr: string): any => {
            try {
              return JSON.parse(jsonStr);
            } catch (e) {
              // 检查是否是不完整的UTF-8字符序列
              if (jsonStr.length > 0) {
                // 检查字符串末尾是否可能是不完整的多字节字符
                const lastChar = jsonStr.charCodeAt(jsonStr.length - 1);
                if ((lastChar >= 0xD800 && lastChar <= 0xDBFF) || // UTF-16 高代理项
                    (lastChar >= 0x80 && lastChar <= 0xFF)) { // 可能的UTF-8多字节字符开始
                  return null; // 表示需要更多数据
                }
              }
              throw e;
            }
          };

          // 改进的行处理函数，确保UTF-8字符完整性
          const processLines = (lines: string[]) => {
            const processedLines: string[] = [];
            let currentLine = "";
            
            for (const line of lines) {
              if (line.trim() === "") continue;
              
              if (currentLine) {
                currentLine += line;
              } else {
                currentLine = line;
              }
              
              // 检查是否是完整的SSE行
              if (currentLine.endsWith('\n') || currentLine.includes('\n\n')) {
                processedLines.push(currentLine);
                currentLine = "";
              }
            }
            
            if (currentLine) {
              // 保留不完整的行到缓冲区
              buffer = currentLine;
            }
            
            return processedLines;
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (!isStreamEnded) {
                  // 发送结束标记
                  const doneChunk = `data: [DONE]\n\n`;
                  controller.enqueue(encoder.encode(doneChunk));
                }
                break;
              }

              const chunk = decoder.decode(value, { stream: true });
              buffer += chunk;

              // 使用标准方式切分行：永远保留最后一个可能不完整的行到 buffer
              // 这能避免 chunk 在任意位置断开时丢失 `data:` JSON
              const lines = buffer.split(/\r?\n/);
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim()) continue;

                try {
                  if (line.startsWith("event: ")) {
                    // 处理事件行，暂存以便与下一行数据配对
                    continue;
                  } else if (line.startsWith("data: ")) {
                    const dataStr = line.slice(5).trim(); // 移除 "data: " 前缀
                    if (dataStr === "[DONE]") {
                      isStreamEnded = true;
                      controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
                      continue;
                    }

                    try {
                      const data: ResponsesStreamEvent = safeJsonParse(dataStr);
                      
                      // 如果安全解析返回null，说明需要更多数据，将数据保留在缓冲区
                      if (data === null) {
                        buffer = "data: " + dataStr + "\n" + buffer;
                        continue;
                      }

                      // Auto-detect format: if the stream contains Chat Completions format
                      // (has 'choices' field), passthrough without conversion
                      if (!hasCheckedFormat) {
                        hasCheckedFormat = true;
                        // Chat Completions format has 'choices' and 'object: chat.completion.chunk'
                        if (data.choices || (data as any).object === "chat.completion.chunk") {
                          isChatCompletionsFormat = true;
                        }
                      }

                      if (isChatCompletionsFormat) {
                        // Upstream is Chat Completions format, passthrough
                        controller.enqueue(encoder.encode(`data: ${dataStr}\n\n`));
                        if (dataStr === "[DONE]" || (data as any).choices?.[0]?.finish_reason) {
                          // Don't add [DONE] here, it will be handled at stream end
                        }
                        continue;
                      }

                      // 根据不同的事件类型转换为chat格式
                      if (data.type === "response.output_text.delta") {
                        // 将output_text.delta转换为chat格式
                        const chatChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model,
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                content: data.delta || "",
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(chatChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.output_item.added" &&
                        data.item?.type === "function_call"
                      ) {
                        // 处理function call开始 - 创建初始的tool call chunk
                        if (data.item.id) {
                          toolMetaByItemId.set(data.item.id, {
                            id: data.item.call_id || data.item.id,
                            name: data.item.name || "",
                          });
                        }
                        const functionCallChunk = {
                          id:
                            data.item.call_id ||
                            data.item.id ||
                            "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model || "gpt-5-codex-",
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                role: "assistant",
                                tool_calls: [
                                  {
                                    index: 0,
                                    id: data.item.call_id || data.item.id,
                                    function: {
                                      name: data.item.name || "",
                                      arguments: "",
                                    },
                                    type: "function",
                                  },
                                ],
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(functionCallChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.output_item.added" &&
                        data.item?.type === "message"
                      ) {
                        // 处理message item added事件
                        const contentItems: MessageContent[] = [];
                        (data.item.content || []).forEach((item: any) => {
                          if (item.type === "output_text") {
                            contentItems.push({
                              type: "text",
                              text: item.text || "",
                            });
                          }
                        });

                        const delta: any = { role: "assistant" };
                        if (
                          contentItems.length === 1 &&
                          contentItems[0].type === "text"
                        ) {
                          delta.content = contentItems[0].text;
                        } else if (contentItems.length > 0) {
                          delta.content = contentItems;
                        }
                        if (delta.content) {
                          const messageChunk = {
                            id: data.item.id || "chatcmpl-" + Date.now(),
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: data.response?.model,
                            choices: [
                              {
                                index: getCurrentIndex(data.type),
                                delta,
                                finish_reason: null,
                              },
                            ],
                          };

                          controller.enqueue(
                            encoder.encode(
                              `data: ${JSON.stringify(messageChunk)}\n\n`
                            )
                          );
                        }
                      } else if (
                        data.type === "response.output_text.annotation.added"
                      ) {
                        const annotationChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model || "gpt-5-codex",
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                annotations: [
                                  {
                                    type: "url_citation",
                                    url_citation: {
                                      url: data.annotation?.url || "",
                                      title: data.annotation?.title || "",
                                      content: "",
                                      start_index:
                                        data.annotation?.start_index || 0,
                                      end_index:
                                        data.annotation?.end_index || 0,
                                    },
                                  },
                                ],
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(annotationChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.function_call_arguments.delta"
                      ) {
                        // 处理function call参数增量
                        if (data.item_id && typeof data.delta === "string") {
                          toolArgsByItemId.set(
                            data.item_id,
                            (toolArgsByItemId.get(data.item_id) || "") + data.delta
                          );
                        }
                        const toolMeta = data.item_id
                          ? toolMetaByItemId.get(data.item_id)
                          : undefined;
                        const functionCallChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model || "gpt-5-codex-",
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                tool_calls: [
                                  {
                                    index: 0,
                                    ...(toolMeta?.id ? { id: toolMeta.id } : {}),
                                    function: {
                                      ...(toolMeta?.name ? { name: toolMeta.name } : {}),
                                      arguments: data.delta || "",
                                    },
                                    ...(toolMeta ? { type: "function" } : {}),
                                  },
                                ],
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(functionCallChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.function_call_arguments.done"
                      ) {
                        const finalArguments =
                          typeof data.arguments === "string"
                            ? data.arguments
                            : "";
                        const streamedArguments = data.item_id
                          ? toolArgsByItemId.get(data.item_id) || ""
                          : "";
                        const toolMeta = data.item_id
                          ? toolMetaByItemId.get(data.item_id)
                          : undefined;
                        const remainingArguments = finalArguments.startsWith(
                          streamedArguments
                        )
                          ? finalArguments.slice(streamedArguments.length)
                          : finalArguments;

                        if (data.item_id) {
                          toolArgsByItemId.set(data.item_id, finalArguments);
                        }

                        if (remainingArguments.length > 0) {
                          const functionCallChunk = {
                            id: data.item_id || "chatcmpl-" + Date.now(),
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: data.response?.model || "gpt-5-codex-",
                            choices: [
                              {
                                index: getCurrentIndex(data.type),
                                delta: {
                                  tool_calls: [
                                    {
                                      index: 0,
                                      ...(toolMeta?.id ? { id: toolMeta.id } : {}),
                                      function: {
                                        ...(toolMeta?.name ? { name: toolMeta.name } : {}),
                                        arguments: remainingArguments,
                                      },
                                      ...(toolMeta ? { type: "function" } : {}),
                                    },
                                  ],
                                },
                                finish_reason: null,
                              },
                            ],
                          };

                          controller.enqueue(
                            encoder.encode(
                              `data: ${JSON.stringify(functionCallChunk)}\n\n`
                            )
                          );
                        }
                      } else if (data.type === "response.completed") {
                        const finishReason = data.response?.output?.some(
                          (item: any) => item.type === "function_call"
                        )
                          ? "tool_calls"
                          : "stop";
                        const usage = mapResponsesUsage(data.response?.usage);
                        if (data.response?.usage) {
                          writeCacheUsageDebug(
                            context?.req?.id,
                            data.response.usage as unknown as Record<string, unknown>,
                            { source: "openai_responses_response_completed" },
                          );
                        }

                        const endChunk = {
                          id: data.response?.id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model || "gpt-5-codex-",
                          choices: [
                            {
                              index: 0,
                              delta: {},
                              finish_reason: finishReason,
                            },
                          ],
                          ...(usage ? { usage } : {}),
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(endChunk)}\n\n`
                          )
                        );
                        isStreamEnded = true;
                      } else if (
                        data.type === "response.reasoning_summary_text.delta"
                      ) {
                        // 处理推理文本，将其转换为 thinking delta 格式
                        const thinkingChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model,
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                thinking: {
                                  content: data.delta || "",
                                },
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(thinkingChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.reasoning_summary_part.done" &&
                        data.part
                      ) {
                        const thinkingChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model,
                          choices: [
                            {
                              index: currentIndex,
                              delta: {
                                thinking: {
                                  signature: data.item_id,
                                },
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(thinkingChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.reasoning_text.delta"
                      ) {
                        // DeepSeek 的思维链增量事件（事件名与 OpenAI 的
                        // reasoning_summary_text.delta 不同），同样转成 thinking delta。
                        // 文本可能位于 delta 或 text 字段（不同实现有差异），兼容两者。
                        const deltaText =
                          typeof data.delta === "string" ? data.delta : "";
                        const textPiece =
                          typeof data.text === "string" ? data.text : "";
                        const content = deltaText || textPiece;
                        if (content && data.item_id) {
                          reasoningTextByItemId.set(
                            data.item_id,
                            (reasoningTextByItemId.get(data.item_id) || "") + content
                          );
                        }
                        const thinkingChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model,
                          choices: [
                            {
                              index: getCurrentIndex(data.type),
                              delta: {
                                thinking: {
                                  content,
                                },
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(thinkingChunk)}\n\n`
                          )
                        );
                      } else if (
                        data.type === "response.reasoning_text.done"
                      ) {
                        // DeepSeek 思维链结束事件，携带完整文本与 item_id。
                        // 与 function_call_arguments.done 相同模式：对比已流式发送的
                        // 增量，只补发剩余文本，再输出带 signature 的收尾 thinking 块。
                        const finalText =
                          typeof data.text === "string"
                            ? data.text
                            : typeof data.delta === "string"
                              ? data.delta
                              : "";
                        const streamedText = data.item_id
                          ? reasoningTextByItemId.get(data.item_id) || ""
                          : "";
                        const remainingText = finalText.startsWith(streamedText)
                          ? finalText.slice(streamedText.length)
                          : finalText;
                        if (data.item_id) {
                          reasoningTextByItemId.set(data.item_id, finalText);
                        }

                        if (remainingText.length > 0) {
                          const textChunk = {
                            id: data.item_id || "chatcmpl-" + Date.now(),
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: data.response?.model,
                            choices: [
                              {
                                index: currentIndex,
                                delta: {
                                  thinking: {
                                    content: remainingText,
                                  },
                                },
                                finish_reason: null,
                              },
                            ],
                          };
                          controller.enqueue(
                            encoder.encode(
                              `data: ${JSON.stringify(textChunk)}\n\n`
                            )
                          );
                        }

                        const thinkingChunk = {
                          id: data.item_id || "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: data.response?.model,
                          choices: [
                            {
                              index: currentIndex,
                              delta: {
                                thinking: {
                                  ...(data.item_id ? { signature: data.item_id } : {}),
                                },
                              },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          encoder.encode(
                            `data: ${JSON.stringify(thinkingChunk)}\n\n`
                          )
                        );
                      }
                    } catch (e) {
                      // 改进的错误处理：检查是否是编码问题
                      // 减少日志刷屏，只在调试模式下输出详细信息
                      if (transformer.logger?.debug) {
                        transformer.logger.debug("JSON parse error for data:", dataStr, "Error:", e);
                      }
                      
                      // 如果数据包含非ASCII字符，可能是编码问题
                      if (/[\u0080-\uFFFF]/.test(dataStr)) {
                        // 减少警告频率，只在第一次遇到时输出
                        if (!transformer._encodingWarningLogged) {
                          console.warn("Detected non-ASCII characters in stream, might be encoding issue");
                          transformer._encodingWarningLogged = true;
                        }
                        // 尝试作为原始文本传递，而不是丢弃
                        const textChunk = {
                          id: "chatcmpl-" + Date.now(),
                          object: "chat.completion.chunk",
                          created: Math.floor(Date.now() / 1000),
                          model: "gpt-5-codex",
                          choices: [{
                            index: 0,
                            delta: { content: dataStr },
                            finish_reason: null,
                          }],
                        };
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(textChunk)}\n\n`));
                      } else {
                        // 对于其他错误，过滤掉非 data: 行
                        if (line.startsWith("data: ")) {
                          controller.enqueue(encoder.encode(line + "\n"));
                        }
                      }
                    }
                  } else {
                    // 过滤掉所有非 data: 行，包括 event: 行，确保只输出标准格式
                    continue;
                  }
                } catch (error) {
                  // 减少错误日志刷屏，只在调试模式下输出详细信息
                  if (transformer.logger?.debug) {
                    transformer.logger.debug("Error processing line:", line, error);
                  }
                  // 如果解析失败，过滤掉非 data: 行，避免输出原始 event: 行
                  if (line.startsWith("data: ")) {
                    controller.enqueue(encoder.encode(line + "\n"));
                  }
                }
              }
            }

            // 处理缓冲区中剩余的数据，只保留 data: 行
            if (buffer.trim()) {
              const bufferLines = buffer.split(/\r?\n/);
              for (const bufferLine of bufferLines) {
                if (bufferLine.trim() && bufferLine.startsWith("data: ")) {
                  controller.enqueue(encoder.encode(bufferLine + "\n"));
                }
              }
            }

            // 确保流结束时发送结束标记
            if (!isStreamEnded) {
              const doneChunk = `data: [DONE]\n\n`;
              controller.enqueue(encoder.encode(doneChunk));
            }
          } catch (error) {
            // 减少错误日志刷屏，只在调试模式下输出详细信息
            if (transformer.logger?.debug) {
              transformer.logger.debug("Stream error:", error);
            } else {
              console.error("Stream error:", (error as Error)?.message || error);
            }
            controller.error(error);
          } finally {
            try {
              reader.releaseLock();
            } catch (e) {
              // 减少错误日志刷屏，只在调试模式下输出详细信息
              if (transformer.logger?.debug) {
                transformer.logger.debug("Error releasing reader lock:", e);
              }
            }
            controller.close();
          }
        },
      });

      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return response;
  }

  private normalizeRequestContent(content: any, role: string | undefined) {
    if (content.type === "text") {
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: content.text,
      };
    }

    if (content.type === "image_url") {
      const imagePayload: Record<string, unknown> = {
        type: role === "assistant" ? "output_image" : "input_image",
      };

      if (typeof content.image_url?.url === "string") {
        imagePayload.image_url = content.image_url.url;
      }

      return imagePayload;
    }

    return null;
  }

  private buildResponsesUrl(baseUrl: string): URL {
    const url = new URL(baseUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, "");

    if (normalizedPath.endsWith("/responses")) {
      return url;
    }

    if (!normalizedPath || normalizedPath === "/") {
      url.pathname = "/v1/responses";
      return url;
    }

    if (normalizedPath.endsWith("/v1")) {
      url.pathname = `${normalizedPath}/responses`;
      return url;
    }

    url.pathname = `${normalizedPath}/responses`;
    return url;
  }

  /**
   * Build Chat Completions URL from provider base URL.
   * Used when upstream provider only supports Chat Completions API.
   */
  private buildChatCompletionsUrl(baseUrl: string): URL {
    const url = new URL(baseUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, "");

    if (!normalizedPath || normalizedPath === "/") {
      url.pathname = "/v1/chat/completions";
      return url;
    }

    if (normalizedPath.endsWith("/v1")) {
      url.pathname = `${normalizedPath}/chat/completions`;
      return url;
    }

    // Remove /responses if present, then add /chat/completions
    const withoutResponses = normalizedPath.replace(/\/responses$/, "");
    url.pathname = `${withoutResponses}/chat/completions`;
    return url;
  }

  private hasMessageContent(content: UnifiedChatRequest["messages"][number]["content"]) {
    if (typeof content === "string") {
      return content.length > 0;
    }

    return Array.isArray(content) && content.length > 0;
  }

  private extractAnnotations(
    content: ResponsesAPIOutputContentItem[] | undefined
  ): Annotation[] | undefined {
    const annotations = (content || [])
      .flatMap((item) => item.annotations || [])
      .map((item) => ({
        type: "url_citation" as const,
        url_citation: {
          url: item.url || "",
          title: item.title || "",
          content: "",
          start_index: item.start_index || 0,
          end_index: item.end_index || 0,
        },
      }));

    return annotations.length > 0 ? annotations : undefined;
  }

  private extractToolCalls(output: ResponsesAPIOutputItem[]) {
    const toolCalls = output
      .filter((item) => item.type === "function_call")
      .map((item) => ({
        id: item.call_id || item.id || `call_${Date.now()}`,
        function: {
          name: item.name || "",
          arguments: item.arguments || "",
        },
        type: "function" as const,
      }));

    return toolCalls.length > 0 ? toolCalls : null;
  }

  private convertResponseToChat(responseData: ResponsesAPIPayload): any {
    const outputItems = responseData.output || [];
    const messageOutput = [...outputItems]
      .reverse()
      .find((item) => item.type === "message");
    const annotations = this.extractAnnotations(messageOutput?.content);

    // 只在有注释且有调试日志时才输出
    if (annotations && annotations.length > 0 && this.logger?.debug) {
      this.logger.debug({
        data: annotations,
        type: "url_citation",
      });
    }

    let messageContent: string | MessageContent[] | null = null;
    const toolCalls = this.extractToolCalls(outputItems);
    let thinking = null;

    // 处理推理内容
    // OpenAI 官方：message item 上带 reasoning 字段；
    // DeepSeek：独立的 { type: "reasoning", content } item（plain-text content）。
    const reasoningItem = outputItems.find(
      (item) => item.type === "reasoning" && typeof (item as any).content === "string"
    ) as any;
    if (messageOutput && messageOutput.reasoning) {
      thinking = {
        content: messageOutput.reasoning,
      };
    } else if (reasoningItem?.content) {
      thinking = {
        content: reasoningItem.content,
      };
    }

    if (messageOutput?.content) {
      // 分离文本和图片内容
      const textParts: string[] = [];
      const imageParts: MessageContent[] = [];

      messageOutput.content.forEach((item) => {
        if (item.type === "output_text") {
          textParts.push(item.text || "");
        } else if (item.type === "output_image") {
          const imageContent = this.buildImageContent({
            url: item.image_url,
            mime_type: item.mime_type,
          });
          if (imageContent) {
            imageParts.push(imageContent);
          }
        } else if (item.type === "output_image_base64") {
          const imageContent = this.buildImageContent({
            b64_json: item.image_base64,
            mime_type: item.mime_type,
          });
          if (imageContent) {
            imageParts.push(imageContent);
          }
        }
      });

      // 构建最终内容
      if (imageParts.length > 0) {
        // 如果有图片，将所有内容组合成数组
        const contentArray: MessageContent[] = [];
        if (textParts.length > 0) {
          contentArray.push({
            type: "text",
            text: textParts.join(""),
          });
        }
        contentArray.push(...imageParts);
        messageContent = contentArray;
      } else {
        // 如果只有文本，返回字符串
        messageContent = textParts.join("");
      }
    }

    // 构建chat格式的响应
    const chatResponse = {
      id: responseData.id || "chatcmpl-" + Date.now(),
      object: "chat.completion",
      created: responseData.created_at,
      model: responseData.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: messageContent || null,
            tool_calls: toolCalls,
            thinking: thinking,
            annotations: annotations,
          },
          logprobs: null,
          finish_reason: toolCalls ? "tool_calls" : "stop",
        },
      ],
      usage: mapResponsesUsage(responseData.usage) || null,
    };

    return chatResponse;
  }

  private buildImageContent(source: {
    url?: string;
    b64_json?: string;
    mime_type?: string;
  }): MessageContent | null {
    if (!source) return null;

    if (source.url || source.b64_json) {
      return {
        type: "image_url",
        image_url: {
          url: source.url || "",
          b64_json: source.b64_json,
        },
        media_type: source.mime_type,
      } as MessageContent;
    }

    return null;
  }

  /**
   * Convert Chat Completions response back to Responses API format.
   * This is used when the original request came from Codex CLI (Responses API format)
   * and the upstream returned a Chat Completions format response.
   * The response needs to be converted back to Responses API format for the client.
   */
  async transformResponseIn(
    response: Response,
    context?: TransformerContext
  ): Promise<Response> {
    const contentType = response.headers.get("Content-Type") || "";

    if (contentType.includes("text/event-stream")) {
      if (!response.body) return response;
      return this.convertChatStreamToResponsesStream(response);
    }

    if (contentType.includes("application/json")) {
      try {
        const chatData: any = await response.json();
        // Check if this is already a Responses API format response
        if (chatData.object === "response" && chatData.output) {
          // Already in Responses API format, return as-is
          return new Response(JSON.stringify(chatData), {
            status: response.status,
            statusText: response.statusText,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Convert Chat Completions to Responses API format
        const responseData = this.convertChatToJsonResponses(chatData);
        return new Response(JSON.stringify(responseData), {
          status: response.status,
          statusText: response.statusText,
          headers: { "Content-Type": "application/json" },
        });
      } catch {
        return response;
      }
    }

    return response;
  }

  /**
   * Convert non-streaming Chat Completions JSON to Responses API format.
   */
  private convertChatToJsonResponses(chatData: any): any {
    const choice = chatData.choices?.[0];
    if (!choice) {
      return {
        id: chatData.id || `resp_${Date.now()}`,
        object: "response",
        model: chatData.model || "",
        status: "failed",
        output: [],
      };
    }

    const output: any[] = [];

    // Add reasoning if present
    if (choice.message?.thinking?.content) {
      // DeepSeek 只支持 plain-text content 的 reasoning item，
      // 不支持 OpenAI 的 summary[{summary_text}] 结构。
      output.push({
        type: "reasoning",
        id: `rs_${Date.now()}`,
        content: choice.message.thinking.content,
      });
    }

    // Add message content
    const content: any[] = [];
    if (choice.message?.content) {
      content.push({
        type: "output_text",
        text: choice.message.content,
      });
    }

    if (content.length > 0) {
      output.push({
        type: "message",
        id: `msg_${Date.now()}`,
        role: "assistant",
        content,
      });
    }

    // Add function calls if present
    if (choice.message?.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        output.push({
          type: "function_call",
          id: toolCall.id || `fc_${Date.now()}`,
          call_id: toolCall.id || `call_${Date.now()}`,
          name: toolCall.function?.name || "",
          arguments: toolCall.function?.arguments || "{}",
        });
      }
    }

    const status = choice.finish_reason === "tool_calls" ? "requires_action" :
                   choice.finish_reason === "stop" ? "completed" :
                   choice.finish_reason === "length" ? "incomplete" : "completed";

    return {
      id: chatData.id || `resp_${Date.now()}`,
      object: "response",
      model: chatData.model || "",
      status,
      output,
      usage: chatData.usage ? {
        input_tokens: chatData.usage.prompt_tokens || 0,
        output_tokens: chatData.usage.completion_tokens || 0,
        total_tokens: chatData.usage.total_tokens || 0,
      } : undefined,
    };
  }

  /**
   * Convert streaming Chat Completions SSE to Responses API SSE format.
   */
  private async convertChatStreamToResponsesStream(response: Response): Promise<Response> {
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const encoder = new TextEncoder();
    let buffer = "";
    let responseId = `resp_${Date.now()}`;
    let model = "";
    let isStreamEnded = false;

    const transformer = this;
    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body!.getReader();
        let hasEmittedMessageItem = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              if (!isStreamEnded) {
                const completedEvent = {
                  type: "response.completed",
                  response: {
                    id: responseId,
                    object: "response",
                    model,
                    status: "completed",
                    output: [],
                  },
                };
                controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`));
              }
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim()) continue;
              if (line.startsWith("event:")) continue;
              if (!line.startsWith("data:")) continue;

              const dataStr = line.slice(5).trim();
              if (dataStr === "[DONE]") {
                isStreamEnded = true;
                const completedEvent = {
                  type: "response.completed",
                  response: {
                    id: responseId,
                    object: "response",
                    model,
                    status: "completed",
                    output: [],
                  },
                };
                controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`));
                continue;
              }

              try {
                const chunk = JSON.parse(dataStr);
                model = chunk.model || model;
                responseId = chunk.id || responseId;

                const choice = chunk.choices?.[0];
                if (!choice) continue;

                // Emit message item at first content
                if (!hasEmittedMessageItem && (choice.delta?.content || choice.delta?.role === "assistant")) {
                  hasEmittedMessageItem = true;
                  const messageItem = {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: {
                      type: "message",
                      id: `msg_${Date.now()}`,
                      role: "assistant",
                      content: [],
                    },
                  };
                  controller.enqueue(encoder.encode(`event: response.output_item.added\ndata: ${JSON.stringify(messageItem)}\n\n`));
                }

                // Text content delta
                if (choice.delta?.content) {
                  const textDelta = {
                    type: "response.output_text.delta",
                    output_index: 0,
                    content_index: 0,
                    delta: choice.delta.content,
                  };
                  controller.enqueue(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify(textDelta)}\n\n`));
                }

                // Thinking/reasoning delta
                if (choice.delta?.thinking?.content) {
                  const reasoningDelta = {
                    type: "response.reasoning_summary_text.delta",
                    output_index: 0,
                    delta: choice.delta.thinking.content,
                  };
                  controller.enqueue(encoder.encode(`event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify(reasoningDelta)}\n\n`));
                }

                // Tool calls
                if (choice.delta?.tool_calls) {
                  for (const toolCall of choice.delta.tool_calls) {
                    if (toolCall.function?.name) {
                      const toolItem = {
                        type: "response.output_item.added",
                        output_index: 1,
                        item: {
                          type: "function_call",
                          id: toolCall.id || `fc_${Date.now()}`,
                          call_id: toolCall.id || `call_${Date.now()}`,
                          name: toolCall.function.name,
                          arguments: "",
                        },
                      };
                      controller.enqueue(encoder.encode(`event: response.output_item.added\ndata: ${JSON.stringify(toolItem)}\n\n`));
                    }

                    if (toolCall.function?.arguments) {
                      const argsDelta = {
                        type: "response.function_call_arguments.delta",
                        output_index: 1,
                        item_id: toolCall.id,
                        delta: toolCall.function.arguments,
                      };
                      controller.enqueue(encoder.encode(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify(argsDelta)}\n\n`));
                    }
                  }
                }

                // Finish reason
                if (choice.finish_reason) {
                  if (hasEmittedMessageItem) {
                    const textDone = {
                      type: "response.output_text.done",
                      output_index: 0,
                      content_index: 0,
                      text: "",
                    };
                    controller.enqueue(encoder.encode(`event: response.output_text.done\ndata: ${JSON.stringify(textDone)}\n\n`));

                    const contentPartDone = {
                      type: "response.content_part.done",
                      output_index: 0,
                      content_index: 0,
                      part: { type: "output_text", text: "" },
                    };
                    controller.enqueue(encoder.encode(`event: response.content_part.done\ndata: ${JSON.stringify(contentPartDone)}\n\n`));

                    const outputItemDone = {
                      type: "response.output_item.done",
                      output_index: 0,
                      item: {
                        type: "message",
                        id: `msg_${Date.now()}`,
                        role: "assistant",
                        content: [{ type: "output_text", text: "" }],
                      },
                    };
                    controller.enqueue(encoder.encode(`event: response.output_item.done\ndata: ${JSON.stringify(outputItemDone)}\n\n`));
                  }
                }
              } catch {
                // Skip malformed JSON
              }
            }
          }
        } catch (error) {
          transformer.logger?.debug?.("Stream conversion error:", error);
          controller.error(error);
        } finally {
          try { reader.releaseLock(); } catch {}
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}
