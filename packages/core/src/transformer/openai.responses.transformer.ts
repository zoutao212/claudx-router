import {
  Annotation,
  LLMProvider,
  MessageContent,
  UnifiedChatRequest,
} from "@/types/llm";
import { Transformer } from "@/types/transformer";

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

interface ResponsesAPIPayload {
  id: string;
  object: string;
  model: string;
  created_at: number;
  output: ResponsesAPIOutputItem[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
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
  };
  reasoning_summary?: string;
}

export class OpenAIResponsesTransformer implements Transformer {
  name = "openai-responses";
  endPoint = "/v1/responses";
  logger?: any;
  private _encodingWarningLogged = false;

  /**
   * Convert incoming request from endpoint format to unified format.
   * If the request is in Responses API format (has 'input' field, from Codex CLI),
   * convert it to Chat Completions format.
   * If the request is already in Chat Completions format (has 'messages' field),
   * pass it through unchanged.
   */
  async transformRequestOut(
    request: Record<string, any>
  ): Promise<UnifiedChatRequest> {
    // Detect if this is a Responses API format request (from Codex CLI)
    if (request.input && !request.messages) {
      return this.convertResponsesApiToChat(request);
    }
    // Already in Chat Completions format, pass through
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
      _fromResponsesApi: true,
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

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider
  ): Promise<UnifiedChatRequest | { body: UnifiedChatRequest; config: { url: URL; headers: Record<string, string> } }> {
    // If this request was converted from Responses API format (Codex CLI),
    // the upstream provider expects Chat Completions format.
    // Skip the Responses API conversion and point URL to /chat/completions.
    if ((request as any)._fromResponsesApi) {
      delete (request as any)._fromResponsesApi;
      return {
        body: request,
        config: {
          url: this.buildChatCompletionsUrl(provider.baseUrl),
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Accept': 'text/event-stream, application/json, */*',
          },
        },
      };
    }

    // For requests from other transformers (e.g., Claude Code via Anthropic transformer),
    // the request is already in Chat Completions format.
    // Most upstream providers support Chat Completions, so passthrough directly
    // instead of converting to Responses API format (which many providers don't support).
    // Point URL to /chat/completions and keep the request as-is.
    if ((request as any).messages && !(request as any).input) {
      return {
        body: request,
        config: {
          url: this.buildChatCompletionsUrl(provider.baseUrl),
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Accept': 'text/event-stream, application/json, */*',
          },
        },
      };
    }

    // Original logic: convert Chat Completions → Responses API format
    // for upstream providers that support Responses API
    delete request.temperature;
    delete request.max_tokens;

    // 处理 reasoning 参数
    if (request.reasoning) {
      (request as any).reasoning = {
        effort: request.reasoning.effort,
        summary: "detailed",
      };
    }

    const input: any[] = [];

    const systemMessages = request.messages.filter((msg) => msg.role === "system");
    if (systemMessages.length > 0) {
      const firstSystem = systemMessages[0];
      if (Array.isArray(firstSystem.content)) {
        const instructions = firstSystem.content
          .map((item) => (item.type === "text" ? item.text : ""))
          .filter(Boolean)
          .join("\n");
        if (instructions) {
          (request as any).instructions = instructions;
        }
      } else if (typeof firstSystem.content === "string") {
        (request as any).instructions = firstSystem.content;
      }
    }

    request.messages.forEach((message) => {
      if (message.role === "system") return;

      if (Array.isArray(message.content)) {
        const convertedContent = message.content
          .map((content) => this.normalizeRequestContent(content, message.role))
          .filter(
            (content): content is Record<string, unknown> => content !== null
          );

        if (convertedContent.length > 0) {
          (message as any).content = convertedContent;
        } else {
          delete (message as any).content;
        }
      }

      if (message.role === "tool") {
        const toolMessage: any = { ...message };
        toolMessage.type = "function_call_output";
        toolMessage.call_id = message.tool_call_id;
        toolMessage.output =
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content);
        delete toolMessage.cache_control;
        delete toolMessage.role;
        delete toolMessage.tool_call_id;
        delete toolMessage.content;
        input.push(toolMessage);
        return;
      }

      if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
        if (this.hasMessageContent(message.content)) {
          input.push({
            role: "assistant",
            content: message.content,
          });
        }

        message.tool_calls.forEach((tool) => {
          input.push({
            type: "function_call",
            arguments: tool.function.arguments,
            name: tool.function.name,
            call_id: tool.id,
          });
        });
        return;
      }

      input.push(message);
    });

    (request as any).input = input;
    delete (request as any).messages;

    if (Array.isArray(request.tools)) {
      const webSearch = request.tools.find(
        (tool) => tool.function.name === "web_search"
      );

      (request as any).tools = request.tools
        .filter((tool) => tool.function.name !== "web_search")
        .map((tool) => {
          const parameters = {
            ...tool.function.parameters,
            properties: { ...tool.function.parameters.properties },
          };

          if (tool.function.name === "WebSearch") {
            delete parameters.properties.allowed_domains;
          }
          if (tool.function.name === "Edit") {
            return {
              type: tool.type,
              name: tool.function.name,
              description: tool.function.description,
              parameters: {
                ...parameters,
                required: [
                  "file_path",
                  "old_string",
                  "new_string",
                  "replace_all",
                ],
              },
              strict: true,
            };
          }
          return {
            type: tool.type,
            name: tool.function.name,
            description: tool.function.description,
            parameters,
          };
        });

      if (webSearch) {
        (request as any).tools.push({
          type: "web_search",
        });
      }
    }

    (request as any).parallel_tool_calls = false;

    return {
      body: request,
      config: {
        url: this.buildResponsesUrl(provider.baseUrl),
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'text/event-stream, application/json, */*',
          'Accept-Charset': 'utf-8',
          'User-Agent': 'claude-code-router/2.0.0'
        }
      } as any,
    };
  }

  async transformResponseOut(response: Response): Promise<Response> {
    const contentType = response.headers.get("Content-Type") || "";

    if (contentType.includes("application/json")) {
      const jsonResponse: any = await response.json();

      // 检查是否为responses API格式的JSON响应
      if (jsonResponse.object === "response" && jsonResponse.output) {
        // 将responses格式转换为chat格式
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
                        // 发送结束标记 - 检查是否是tool_calls完成
                        const finishReason = data.response?.output?.some(
                          (item: any) => item.type === "function_call"
                        )
                          ? "tool_calls"
                          : "stop";

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

    if (normalizedPath.endsWith("/chat/completions")) {
      return url;
    }

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
    if (messageOutput && messageOutput.reasoning) {
      thinking = {
        content: messageOutput.reasoning,
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
      usage: responseData.usage
        ? {
            prompt_tokens: responseData.usage.input_tokens || 0,
            completion_tokens: responseData.usage.output_tokens || 0,
            total_tokens: responseData.usage.total_tokens || 0,
          }
        : null,
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
      output.push({
        type: "reasoning",
        id: `rs_${Date.now()}`,
        summary: [{ type: "summary_text", text: choice.message.thinking.content }],
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
