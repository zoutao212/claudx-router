import { ChatCompletion } from "openai/resources";
import {
  LLMProvider,
  UnifiedChatRequest,
  UnifiedMessage,
  UnifiedTool,
} from "@/types/llm";
import {
  Transformer,
  TransformerContext,
  TransformerOptions,
} from "@/types/transformer";
import { v4 as uuidv4 } from "uuid";
import { getThinkLevel } from "@/utils/thinking";
import { createApiError } from "@/api/middleware";
import { formatBase64 } from "@/utils/image";
import { writeCacheUsageDebug } from "@/utils/request";

export class AnthropicTransformer implements Transformer {
  name = "Anthropic";
  endPoint = "/v1/messages";
  private useBearer: boolean;
  logger?: any;

  constructor(private readonly options?: TransformerOptions) {
    this.useBearer = this.options?.UseBearer ?? false;
  }

  async auth(request: any, provider: LLMProvider): Promise<any> {
    const headers: Record<string, string | undefined> = {};

    if (this.useBearer) {
      headers["authorization"] = `Bearer ${provider.apiKey}`;
      headers["x-api-key"] = undefined;
    } else {
      headers["x-api-key"] = provider.apiKey;
      headers["authorization"] = undefined;
    }

    return {
      body: request,
      config: {
        headers,
      },
    };
  }

  async transformRequestOut(
    request: Record<string, any>
  ): Promise<UnifiedChatRequest> {
    const messages: UnifiedMessage[] = [];

    if (request.system) {
      if (typeof request.system === "string") {
        messages.push({
          role: "system",
          content: request.system,
        });
      } else if (Array.isArray(request.system) && request.system.length) {
        const textParts = request.system
          .filter((item: any) => item.type === "text" && item.text)
          .map((item: any) => ({
            type: "text" as const,
            text: item.text,
            cache_control: item.cache_control,
          }));
        messages.push({
          role: "system",
          content: textParts,
        });
      }
    }

    const requestMessages = JSON.parse(JSON.stringify(request.messages || []));

    requestMessages?.forEach((msg: any) => {
      if (msg.role === "user" || msg.role === "assistant") {
        if (typeof msg.content === "string") {
          messages.push({
            role: msg.role,
            content: msg.content,
          });
          return;
        }

        if (Array.isArray(msg.content)) {
          if (msg.role === "user") {
            const toolParts = msg.content.filter(
              (c: any) => c.type === "tool_result" && c.tool_use_id
            );
            if (toolParts.length) {
              toolParts.forEach((tool: any) => {
                const toolMessage: UnifiedMessage = {
                  role: "tool",
                  content:
                    typeof tool.content === "string"
                      ? tool.content
                      : JSON.stringify(tool.content),
                  tool_call_id: tool.tool_use_id,
                  cache_control: tool.cache_control,
                };
                messages.push(toolMessage);
              });
            }

            const textAndMediaParts = msg.content.filter(
              (c: any) =>
                (c.type === "text" && c.text) ||
                (c.type === "image" && c.source)
            );
            if (textAndMediaParts.length) {
              messages.push({
                role: "user",
                content: textAndMediaParts.map((part: any) => {
                  if (part?.type === "image") {
                    return {
                      type: "image_url",
                      image_url: {
                        url:
                          part.source?.type === "base64"
                            ? formatBase64(
                                part.source.data,
                                part.source.media_type
                              )
                            : part.source.url,
                      },
                      media_type: part.source.media_type,
                    };
                  }
                  return part;
                }),
              });
            }
          } else if (msg.role === "assistant") {
            const assistantMessage: UnifiedMessage = {
              role: "assistant",
              content: "",
            };
            const textParts = msg.content.filter(
              (c: any) => c.type === "text" && c.text
            );
            if (textParts.length) {
              assistantMessage.content = textParts
                .map((text: any) => text.text)
                .join("\n");
            }

            const toolCallParts = msg.content.filter(
              (c: any) => c.type === "tool_use" && c.id
            );
            if (toolCallParts.length) {
              assistantMessage.tool_calls = toolCallParts.map((tool: any) => {
                return {
                  id: tool.id,
                  type: "function" as const,
                  function: {
                    name: tool.name,
                    arguments: JSON.stringify(tool.input || {}),
                  },
                };
              });
            }

            const thinkingPart = msg.content.find(
              (c: any) => c.type === "thinking" && c.signature
            );
            if (thinkingPart) {
              assistantMessage.thinking = {
                content: thinkingPart.thinking,
                signature: thinkingPart.signature,
              };
            }

            messages.push(assistantMessage);
          }
          return;
        }
      }
    });

    const result: UnifiedChatRequest = {
      messages,
      model: request.model,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stream: request.stream,
      tools: request.tools?.length
        ? this.convertAnthropicToolsToUnified(request.tools)
        : undefined,
      tool_choice: request.tool_choice,
    };
    if (request.thinking) {
      result.reasoning = {
        effort: getThinkLevel(request.thinking.budget_tokens),
        // max_tokens: request.thinking.budget_tokens,
        enabled: request.thinking.type === "enabled",
      };
    }
    if (request.tool_choice) {
      if (request.tool_choice.type === "tool") {
        result.tool_choice = {
          type: "function",
          function: { name: request.tool_choice.name },
        };
      } else {
        result.tool_choice = request.tool_choice.type;
      }
    }
    return result;
  }

  async transformResponseIn(
    response: Response,
    context?: TransformerContext
  ): Promise<Response> {
    const isStream = response.headers
      .get("Content-Type")
      ?.includes("text/event-stream");
    if (isStream) {
      if (!response.body) {
        throw new Error("Stream response body is null");
      }
      const convertedStream = await this.convertOpenAIStreamToAnthropic(
        response.body,
        context!
      );
      return new Response(convertedStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    } else {
      const data = (await response.json()) as any;
      const anthropicResponse = this.convertOpenAIResponseToAnthropic(
        data,
        context!
      );
      return new Response(JSON.stringify(anthropicResponse), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider
  ): Promise<{ body: Record<string, any>; config: { url: URL; headers: Record<string, string | undefined> } }> {
    const systemParts: any[] = [];
    const messages: any[] = [];

    for (const message of request.messages || []) {
      if (message.role === "system") {
        if (typeof message.content === "string") {
          systemParts.push({
            type: "text",
            text: message.content,
            ...(message.cache_control ? { cache_control: message.cache_control } : {}),
          });
        } else if (Array.isArray(message.content)) {
          systemParts.push(
            ...message.content
              .filter((item: any) => item.type === "text" && item.text)
              .map((item: any) => ({
                type: "text",
                text: item.text,
                ...(item.cache_control ? { cache_control: item.cache_control } : {}),
              }))
          );
        }
        continue;
      }

      if (message.role === "tool") {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.tool_call_id,
              content:
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content ?? ""),
              ...(message.cache_control ? { cache_control: message.cache_control } : {}),
            },
          ],
        });
        continue;
      }

      if (message.role === "assistant" && message.tool_calls?.length) {
        const content: any[] = [];
        if (this.hasMessageContent(message.content)) {
          content.push(...this.convertUnifiedContentToAnthropic(message.content));
        }
        for (const toolCall of message.tool_calls) {
          let input: any = {};
          try {
            input = JSON.parse(toolCall.function.arguments || "{}");
          } catch {
            input = { text: toolCall.function.arguments || "" };
          }
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input,
          });
        }
        messages.push({ role: "assistant", content });
        continue;
      }

      if (message.role === "user" || message.role === "assistant") {
        messages.push({
          role: message.role,
          content: this.convertUnifiedContentToAnthropic(message.content),
        });
      }
    }

    const body: Record<string, any> = {
      model: request.model,
      messages,
      max_tokens: request.max_tokens ?? 4096,
      temperature: request.temperature,
      stream: request.stream,
    };

    if (systemParts.length === 1) {
      body.system = systemParts[0].cache_control ? systemParts : systemParts[0].text;
    } else if (systemParts.length > 1) {
      body.system = systemParts;
    }

    const toolAllowList =
      provider.options?.toolAllowList ||
      provider.options?.allowedTools ||
      this.getAutoToolAllowList(request, provider);
    const allowedToolNames = Array.isArray(toolAllowList) && toolAllowList.length > 0
      ? new Set(toolAllowList)
      : undefined;
    const filteredTools = request.tools?.filter((tool) => {
      const name = tool?.function?.name;
      return !allowedToolNames || allowedToolNames.has(name);
    });

    if (filteredTools?.length) {
      body.tools = filteredTools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description || "",
        input_schema: tool.function.parameters,
      }));
    }

    if (request.tool_choice && body.tools?.length) {
      if (typeof request.tool_choice === "object" && "function" in request.tool_choice) {
        const chosenToolName = request.tool_choice.function.name;
        if (body.tools.some((tool: any) => tool.name === chosenToolName)) {
          body.tool_choice = {
            type: "tool",
            name: chosenToolName,
          };
        }
      } else if (request.tool_choice === "required") {
        body.tool_choice = { type: "any" };
      } else if (request.tool_choice === "auto" || request.tool_choice === "none") {
        body.tool_choice = { type: request.tool_choice };
      }
    }

    if (request.reasoning?.enabled) {
      body.thinking = {
        type: "enabled",
        budget_tokens: request.reasoning.max_tokens ?? 1024,
      };
    }

    // When the provider doesn't support message-level cache_control (e.g. opeapi.cn),
    // hoist the large first user message into system so it becomes part of the
    // system-level cache prefix. This moves ~30,000 tokens from uncached input into cache.
    const enableMessageBreakpoints =
      provider?.options?.cacheMessagesBreakpoint ??
      (process.env.CCR_CACHE_MESSAGES_BREAKPOINT === "1");
    const shouldHoistLargeUserMessage = !enableMessageBreakpoints;
    if (shouldHoistLargeUserMessage) {
      this.hoistLargeUserMessageToSystem(body);
      this.seedFirstHoistedTurnForCacheWarmup(body, provider);
    }
    const useProxyToolCacheWorkaround = this.shouldUseProxyToolCacheWorkaround(provider, body);
    if (useProxyToolCacheWorkaround) {
      this.moveToolSpecsIntoCachedSystemForProxy(body);
      this.moveOversizedSystemTailToCachedUserTurn(body, provider);
    }
    this.ensureAnthropicCacheBreakpoints(body, provider, useProxyToolCacheWorkaround ? { skipToolsBreakpoint: true } : {});

    return {
      body,
      config: {
        url: this.buildMessagesUrl(provider.baseUrl),
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Accept": "text/event-stream, application/json, */*",
          "anthropic-version": "2023-06-01",
          "x-api-key": provider.apiKey,
          "Authorization": undefined,
          "authorization": undefined,
        },
      },
    };
  }

  async transformResponseOut(
    response: Response,
    context: TransformerContext
  ): Promise<Response> {
    const contentType = response.headers.get("Content-Type") || "";

    if (contentType.includes("text/event-stream")) {
      if (!response.body) return response;
      const convertedStream = await this.convertAnthropicStreamToOpenAI(
        response.body,
        context
      );
      return new Response(convertedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    if (contentType.includes("application/json")) {
      const data = await response.json();
      if (data?.choices || data?.error) {
        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: { "Content-Type": "application/json" },
        });
      }
      const openAIResponse = this.convertAnthropicResponseToOpenAI(data);
      return new Response(JSON.stringify(openAIResponse), {
        status: response.status,
        statusText: response.statusText,
        headers: { "Content-Type": "application/json" },
      });
    }

    return response;
  }

  private convertAnthropicToolsToUnified(tools: any[]): UnifiedTool[] {
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema,
      },
    }));
  }

  private async convertOpenAIStreamToAnthropic(
    openaiStream: ReadableStream,
    context: TransformerContext
  ): Promise<ReadableStream> {
    const readable = new ReadableStream({
      start: async (controller) => {
        const encoder = new TextEncoder();
        const messageId = `msg_${Date.now()}`;
        let stopReasonMessageDelta: null | Record<string, any> = null;
        let model = "unknown";
        let hasStarted = false;
        let hasTextContentStarted = false;
        let hasFinished = false;
        const toolCalls = new Map<number, any>();
        const toolCallIndexToContentBlockIndex = new Map<number, number>();
        let totalChunks = 0;
        let contentChunks = 0;
        let toolCallChunks = 0;
        let isClosed = false;
        let isThinkingStarted = false;
        let contentIndex = 0;
        let currentContentBlockIndex = -1; // Track the current content block index

        // Batch debug logging for upstream OpenAI chunks to avoid per-token log spam
        let openaiChunkLogBuffer = "";
        let openaiChunkLogLastFlushAt = 0;
        const flushOpenAIChunkLog = (reason: "threshold" | "interval" | "terminal") => {
          if (!openaiChunkLogBuffer) return;
          if (!this.logger?.debug) {
            openaiChunkLogBuffer = "";
            return;
          }
          this.logger.debug({
            reqId: context.req.id,
            reason,
            preview: openaiChunkLogBuffer,
            type: "Original Response (batched)",
          });
          openaiChunkLogBuffer = "";
          openaiChunkLogLastFlushAt = Date.now();
        };

        // 原子性的content block index分配函数
        const assignContentBlockIndex = (): number => {
          const currentIndex = contentIndex;
          contentIndex++;
          return currentIndex;
        };

        const safeEnqueue = (data: Uint8Array) => {
          if (!isClosed) {
            try {
              controller.enqueue(data);
              if (process.env.CCR_LOG_SSE === "1") {
                const dataStr = new TextDecoder().decode(data);
                this.logger.debug({
                  reqId: context.req.id,
                  data: dataStr,
                  type: "send data",
                });
              }
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : typeof error === "string"
                    ? error
                    : "";

              // Client aborted / stream closed: do NOT throw (would surface as 500 to Claude Code).
              // Mark closed and stop further enqueue attempts.
              const isClosedLike =
                (error instanceof TypeError &&
                  message.includes("Controller is already closed")) ||
                message.includes("Invalid state") ||
                message.includes("Cannot enqueue") ||
                message.includes("WritableStream is closed") ||
                message.includes("write after end") ||
                message.includes("EPIPE") ||
                message.includes("ECONNRESET") ||
                message.includes("socket hang up");

              if (isClosedLike) {
                isClosed = true;
                return;
              }

              this.logger.debug({
                reqId: context.req.id,
                error: message || String(error),
                type: "send data error",
              });
              throw error;
            }
          }
        };

        const maybeDelayForPromptCachePropagation = async () => {
          const usage = stopReasonMessageDelta?.usage;
          const stopReason = stopReasonMessageDelta?.delta?.stop_reason;
          const cacheCreated = Number(usage?.cache_creation_input_tokens || 0);
          const cacheRead = Number(usage?.cache_read_input_tokens || 0);
          const threshold = Number(process.env.CCR_CACHE_PROPAGATION_DELAY_THRESHOLD || "20000");
          const delayMs = Number(process.env.CCR_CACHE_PROPAGATION_DELAY_MS || "3000");
          if (stopReason !== "tool_use" || cacheRead > 0 || cacheCreated < threshold || delayMs <= 0) {
            return;
          }
          this.logger?.info?.(
            {
              reqId: context.req.id,
              cacheCreated,
              cacheRead,
              delayMs,
              stopReason,
            },
            "delaying tool-use stream close for prompt cache propagation"
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        };

        const safeClose = async () => {
          if (!isClosed) {
            try {
              // Close any remaining open content block
              if (currentContentBlockIndex >= 0) {
                const contentBlockStop = {
                  type: "content_block_stop",
                  index: currentContentBlockIndex,
                };
                safeEnqueue(
                  encoder.encode(
                    `event: content_block_stop\ndata: ${JSON.stringify(
                      contentBlockStop
                    )}\n\n`
                  )
                );
                currentContentBlockIndex = -1;
              }

              await maybeDelayForPromptCachePropagation();
              if (stopReasonMessageDelta) {
                safeEnqueue(
                  encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify(
                      stopReasonMessageDelta
                    )}\n\n`
                  )
                );
                stopReasonMessageDelta = null;
              } else {
                safeEnqueue(
                  encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify({
                      type: "message_delta",
                      delta: {
                        stop_reason: "end_turn",
                        stop_sequence: null,
                      },
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_input_tokens: 0,
                      },
                    })}\n\n`
                  )
                );
              }
              const messageStop = {
                type: "message_stop",
              };
              safeEnqueue(
                encoder.encode(
                  `event: message_stop\ndata: ${JSON.stringify(
                    messageStop
                  )}\n\n`
                )
              );
              controller.close();
              isClosed = true;
            } catch (error) {
              if (
                error instanceof TypeError &&
                error.message.includes("Controller is already closed")
              ) {
                isClosed = true;
              } else {
                console.error("Stream processing error:", error);
              }
            } finally {
              flushOpenAIChunkLog("terminal");
              try {
                reader?.releaseLock();
              } catch {}
            }
          }
        };

        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

        try {
          reader = openaiStream.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            if (isClosed) {
              break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (isClosed || hasFinished) break;

              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (process.env.CCR_LOG_SSE === "1") {
                this.logger.debug({
                  reqId: context.req.id,
                  type: "recieved data",
                  data,
                });
              }

              if (data === "[DONE]") {
                continue;
              }

              try {
                const chunk = JSON.parse(data);
                totalChunks++;
                // Aggregate token-level deltas into batched logs (200-300 chars) to reduce log size
                try {
                  const delta = chunk?.choices?.[0]?.delta;
                  const piece: string | undefined =
                    delta?.content ??
                    delta?.thinking?.content ??
                    (typeof chunk?.choices?.[0]?.delta === "string" ? chunk.choices[0].delta : undefined);
                  if (typeof piece === "string" && piece.length > 0) {
                    openaiChunkLogBuffer += piece;
                  }
                } catch {
                  // ignore
                }

                const now = Date.now();
                if (!openaiChunkLogLastFlushAt) openaiChunkLogLastFlushAt = now;
                if (openaiChunkLogBuffer.length >= 260) {
                  flushOpenAIChunkLog("threshold");
                } else if (now - openaiChunkLogLastFlushAt >= 800) {
                  flushOpenAIChunkLog("interval");
                }
                if (chunk.error) {
                  const errorMessage = {
                    type: "error",
                    message: {
                      type: "api_error",
                      message: JSON.stringify(chunk.error),
                    },
                  };

                  safeEnqueue(
                    encoder.encode(
                      `event: error\ndata: ${JSON.stringify(errorMessage)}\n\n`
                    )
                  );
                  continue;
                }

                model = chunk.model || model;

                if (!hasStarted && !isClosed && !hasFinished) {
                  hasStarted = true;

                  const messageStart = {
                    type: "message_start",
                    message: {
                      id: messageId,
                      type: "message",
                      role: "assistant",
                      content: [],
                      model: model,
                      stop_reason: null,
                      stop_sequence: null,
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                      },
                    },
                  };

                  safeEnqueue(
                    encoder.encode(
                      `event: message_start\ndata: ${JSON.stringify(
                        messageStart
                      )}\n\n`
                    )
                  );
                }

                const choice = chunk.choices?.[0];
                if (chunk.usage) {
                  if (!stopReasonMessageDelta) {
                    stopReasonMessageDelta = {
                      type: "message_delta",
                      delta: {
                        stop_reason: "end_turn",
                        stop_sequence: null,
                      },
                      usage: {
                        input_tokens:
                          (chunk.usage?.prompt_tokens || 0) -
                          (chunk.usage?.prompt_tokens_details?.cached_tokens ||
                            0),
                        output_tokens: chunk.usage?.completion_tokens || 0,
                        cache_read_input_tokens:
                          chunk.usage?.prompt_tokens_details?.cached_tokens ||
                          0,
                      },
                    };
                  } else {
                    stopReasonMessageDelta.usage = {
                      input_tokens:
                        (chunk.usage?.prompt_tokens || 0) -
                        (chunk.usage?.prompt_tokens_details?.cached_tokens ||
                          0),
                      output_tokens: chunk.usage?.completion_tokens || 0,
                      cache_read_input_tokens:
                        chunk.usage?.prompt_tokens_details?.cached_tokens || 0,
                    };
                  }
                }
                if (!choice) {
                  continue;
                }

                if (choice?.delta?.thinking && !isClosed && !hasFinished) {
                  // Close any previous content block if open
                  // if (currentContentBlockIndex >= 0) {
                  //   const contentBlockStop = {
                  //     type: "content_block_stop",
                  //     index: currentContentBlockIndex,
                  //   };
                  //   safeEnqueue(
                  //     encoder.encode(
                  //       `data: ${JSON.stringify(
                  //         contentBlockStop
                  //       )}\n\n`
                  //     )
                  //   );
                  //   currentContentBlockIndex = -1;
                  // }

                  if (!isThinkingStarted) {
                    const thinkingBlockIndex = assignContentBlockIndex();
                    const contentBlockStart = {
                      type: "content_block_start",
                      index: thinkingBlockIndex,
                      content_block: { type: "thinking", thinking: "" },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify(
                          contentBlockStart
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = thinkingBlockIndex;
                    isThinkingStarted = true;
                  }
                  if (choice.delta.thinking.signature) {
                    const thinkingSignature = {
                      type: "content_block_delta",
                      index: currentContentBlockIndex,
                      delta: {
                        type: "signature_delta",
                        signature: choice.delta.thinking.signature,
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_delta\ndata: ${JSON.stringify(
                          thinkingSignature
                        )}\n\n`
                      )
                    );
                    const contentBlockStop = {
                      type: "content_block_stop",
                      index: currentContentBlockIndex,
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify(
                          contentBlockStop
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = -1;
                  } else if (choice.delta.thinking.content) {
                    const thinkingChunk = {
                      type: "content_block_delta",
                      index: currentContentBlockIndex,
                      delta: {
                        type: "thinking_delta",
                        thinking: choice.delta.thinking.content || "",
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_delta\ndata: ${JSON.stringify(
                          thinkingChunk
                        )}\n\n`
                      )
                    );
                  }
                }

                if (choice?.delta?.content && !isClosed && !hasFinished) {
                  contentChunks++;

                  // Close any previous content block if open and it's not a text content block
                  if (currentContentBlockIndex >= 0) {
                    // Check if current content block is text type
                    const isCurrentTextBlock = hasTextContentStarted;
                    if (!isCurrentTextBlock) {
                      const contentBlockStop = {
                        type: "content_block_stop",
                        index: currentContentBlockIndex,
                      };
                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_stop\ndata: ${JSON.stringify(
                            contentBlockStop
                          )}\n\n`
                        )
                      );
                      currentContentBlockIndex = -1;
                    }
                  }

                  if (!hasTextContentStarted && !hasFinished) {
                    hasTextContentStarted = true;
                    const textBlockIndex = assignContentBlockIndex();
                    const contentBlockStart = {
                      type: "content_block_start",
                      index: textBlockIndex,
                      content_block: {
                        type: "text",
                        text: "",
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify(
                          contentBlockStart
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = textBlockIndex;
                  }

                  if (!isClosed && !hasFinished) {
                    const anthropicChunk = {
                      type: "content_block_delta",
                      index: currentContentBlockIndex, // Use current content block index
                      delta: {
                        type: "text_delta",
                        text: choice.delta.content,
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_delta\ndata: ${JSON.stringify(
                          anthropicChunk
                        )}\n\n`
                      )
                    );
                  }
                }

                if (
                  choice?.delta?.annotations?.length &&
                  !isClosed &&
                  !hasFinished
                ) {
                  // Close text content block if open
                  if (currentContentBlockIndex >= 0 && hasTextContentStarted) {
                    const contentBlockStop = {
                      type: "content_block_stop",
                      index: currentContentBlockIndex,
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify(
                          contentBlockStop
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = -1;
                    hasTextContentStarted = false;
                  }

                  choice?.delta?.annotations.forEach((annotation: any) => {
                    const annotationBlockIndex = assignContentBlockIndex();
                    const contentBlockStart = {
                      type: "content_block_start",
                      index: annotationBlockIndex,
                      content_block: {
                        type: "web_search_tool_result",
                        tool_use_id: `srvtoolu_${uuidv4()}`,
                        content: [
                          {
                            type: "web_search_result",
                            title: annotation.url_citation.title,
                            url: annotation.url_citation.url,
                          },
                        ],
                      },
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_start\ndata: ${JSON.stringify(
                          contentBlockStart
                        )}\n\n`
                      )
                    );

                    const contentBlockStop = {
                      type: "content_block_stop",
                      index: annotationBlockIndex,
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify(
                          contentBlockStop
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = -1;
                  });
                }

                if (choice?.delta?.tool_calls && !isClosed && !hasFinished) {
                  toolCallChunks++;
                  const processedInThisChunk = new Set<number>();

                  for (const toolCall of choice.delta.tool_calls) {
                    if (isClosed) break;
                    const toolCallIndex = toolCall.index ?? 0;
                    if (processedInThisChunk.has(toolCallIndex)) {
                      continue;
                    }
                    processedInThisChunk.add(toolCallIndex);
                    const isUnknownIndex =
                      !toolCallIndexToContentBlockIndex.has(toolCallIndex);

                    if (isUnknownIndex) {
                      // Close any previous content block if open
                      if (currentContentBlockIndex >= 0) {
                        const contentBlockStop = {
                          type: "content_block_stop",
                          index: currentContentBlockIndex,
                        };
                        safeEnqueue(
                          encoder.encode(
                            `event: content_block_stop\ndata: ${JSON.stringify(
                              contentBlockStop
                            )}\n\n`
                          )
                        );
                        currentContentBlockIndex = -1;
                      }

                      const newContentBlockIndex = assignContentBlockIndex();
                      toolCallIndexToContentBlockIndex.set(
                        toolCallIndex,
                        newContentBlockIndex
                      );
                      const toolCallId =
                        toolCall.id || `call_${Date.now()}_${toolCallIndex}`;
                      const toolCallName =
                        toolCall.function?.name || `tool_${toolCallIndex}`;
                      const contentBlockStart = {
                        type: "content_block_start",
                        index: newContentBlockIndex,
                        content_block: {
                          type: "tool_use",
                          id: toolCallId,
                          name: toolCallName,
                          input: {},
                        },
                      };

                      safeEnqueue(
                        encoder.encode(
                          `event: content_block_start\ndata: ${JSON.stringify(
                            contentBlockStart
                          )}\n\n`
                        )
                      );
                      currentContentBlockIndex = newContentBlockIndex;

                      const toolCallInfo = {
                        id: toolCallId,
                        name: toolCallName,
                        arguments: "",
                        contentBlockIndex: newContentBlockIndex,
                      };
                      toolCalls.set(toolCallIndex, toolCallInfo);
                    } else if (toolCall.id && toolCall.function?.name) {
                      const existingToolCall = toolCalls.get(toolCallIndex)!;
                      const wasTemporary =
                        existingToolCall.id.startsWith("call_") &&
                        existingToolCall.name.startsWith("tool_");

                      if (wasTemporary) {
                        existingToolCall.id = toolCall.id;
                        existingToolCall.name = toolCall.function.name;
                      }
                    }

                    if (
                      toolCall.function?.arguments &&
                      !isClosed &&
                      !hasFinished
                    ) {
                      const blockIndex =
                        toolCallIndexToContentBlockIndex.get(toolCallIndex);
                      if (blockIndex === undefined) {
                        continue;
                      }
                      const currentToolCall = toolCalls.get(toolCallIndex);
                      if (currentToolCall) {
                        currentToolCall.arguments +=
                          toolCall.function.arguments;
                      }

                      try {
                        const anthropicChunk = {
                          type: "content_block_delta",
                          index: blockIndex,
                          delta: {
                            type: "input_json_delta",
                            partial_json: toolCall.function.arguments,
                          },
                        };
                        safeEnqueue(
                          encoder.encode(
                            `event: content_block_delta\ndata: ${JSON.stringify(
                              anthropicChunk
                            )}\n\n`
                          )
                        );
                      } catch {
                        try {
                          const fixedArgument = toolCall.function.arguments
                            .replace(/[\x00-\x1F\x7F-\x9F]/g, "")
                            .replace(/\\/g, "\\\\")
                            .replace(/"/g, '\\"');

                          const fixedChunk = {
                            type: "content_block_delta",
                            index: blockIndex, // Use the correct content block index
                            delta: {
                              type: "input_json_delta",
                              partial_json: fixedArgument,
                            },
                          };
                          safeEnqueue(
                            encoder.encode(
                              `event: content_block_delta\ndata: ${JSON.stringify(
                                fixedChunk
                              )}\n\n`
                            )
                          );
                        } catch (fixError) {
                          console.error(fixError);
                        }
                      }
                    }
                  }
                }

                if (choice?.finish_reason && !isClosed && !hasFinished) {
                  if (contentChunks === 0 && toolCallChunks === 0) {
                    console.error(
                      "Warning: No content in the stream response!"
                    );
                  }

                  // Close any remaining open content block
                  if (currentContentBlockIndex >= 0) {
                    const contentBlockStop = {
                      type: "content_block_stop",
                      index: currentContentBlockIndex,
                    };
                    safeEnqueue(
                      encoder.encode(
                        `event: content_block_stop\ndata: ${JSON.stringify(
                          contentBlockStop
                        )}\n\n`
                      )
                    );
                    currentContentBlockIndex = -1;
                  }

                  if (!isClosed) {
                    const stopReasonMapping: Record<string, string> = {
                      stop: "end_turn",
                      length: "max_tokens",
                      tool_calls: "tool_use",
                      content_filter: "stop_sequence",
                    };

                    const anthropicStopReason =
                      stopReasonMapping[choice.finish_reason] || "end_turn";

                    stopReasonMessageDelta = {
                      type: "message_delta",
                      delta: {
                        stop_reason: anthropicStopReason,
                        stop_sequence: null,
                      },
                      usage: {
                        input_tokens:
                          (chunk.usage?.prompt_tokens || 0) -
                          (chunk.usage?.prompt_tokens_details?.cached_tokens ||
                            0),
                        output_tokens: chunk.usage?.completion_tokens || 0,
                        cache_read_input_tokens:
                          chunk.usage?.prompt_tokens_details?.cached_tokens ||
                          0,
                      },
                    };
                  }

                  break;
                }
              } catch (parseError: any) {
                this.logger?.error(
                  `parseError: ${parseError.name} message: ${parseError.message} stack: ${parseError.stack} data: ${data}`
                );
              }
            }
          }
          await safeClose();
        } catch (error) {
          if (!isClosed) {
            try {
              controller.error(error);
            } catch (controllerError) {
              console.error(controllerError);
            }
          }
        } finally {
          if (reader) {
            try {
              reader.releaseLock();
            } catch (releaseError) {
              console.error(releaseError);
            }
          }
        }
      },
      cancel: (reason) => {
        this.logger.debug(
          {
            reqId: context.req.id,
          },
          `cancle stream: ${reason}`
        );
      },
    });

    return readable;
  }

  /**
   * Hoist a large first user message into the system field for better cache utilization.
   *
   * Many API proxies (e.g. opeapi.cn) only cache system + tools but ignore cache_control
   * on messages content blocks. By moving the large, stable first user message into system,
   * it becomes part of the system-level cache prefix.
   *
   * Conditions:
   * - messages[0] is role "user" with a single large text block (≥10000 chars)
   * - messages[1] exists (so removing messages[0] won't leave messages empty)
   *
   * After hoisting, a minimal user placeholder is left at messages[0] to satisfy
   * Anthropic's requirement that messages must start with a user turn.
   */
  private getAutoToolAllowList(request: UnifiedChatRequest, provider?: LLMProvider): string[] | undefined {
    if (!provider?.options?.autoToolFilter) return undefined;

    const text = (request.messages || [])
      .map((message: any) => {
        const content = message?.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content.map((block: any) => block?.text || block?.content || "").join("\n");
        }
        return "";
      })
      .join("\n")
      .toLowerCase();

    const looksLikeFileTask =
      /[a-z]:\\/.test(text) ||
      /\.(txt|md|json|ts|tsx|js|jsx|py|yaml|yml|toml|log)\b/.test(text) ||
      /读|写|文件|目录|搜索|替换|修改|读取|写入|read|write|file|dir|search|replace|edit/.test(text);

    if (!looksLikeFileTask) return undefined;

    return [
      "list_dir",
      "search_file",
      "search_content",
      "read_file",
      "read_lints",
      "replace_in_file",
      "write_to_file",
      "execute_command",
    ];
  }

  private hoistLargeUserMessageToSystem(body: Record<string, any>): void {
    const HOIST_THRESHOLD = 10000;
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const first = messages[0];
    if (first?.role !== "user") return;
    if (!Array.isArray(first.content) || first.content.length === 0) return;

    // Only hoist if it's a single text block (typical system context injection)
    const textBlocks = first.content.filter((b: any) => b.type === "text");
    if (textBlocks.length !== 1) return;

    const textBlock = textBlocks[0];
    const text = typeof textBlock.text === "string" ? textBlock.text : "";
    if (text.length < HOIST_THRESHOLD) return;

    // Split stable context from volatile turn data. CodeBuddy puts dynamic data near
    // the end (<additional_data>, <user_query>). Hoisting those volatile blocks makes
    // every new user query/time produce a new cache key, so the first request cannot
    // reuse prior cache. Keep dynamic tail in messages[0], hoist only stable prefix.
    const markerCandidates = ["\n<additional_data>", "<additional_data>", "\n<user_query>", "<user_query>"];
    const splitIndex = markerCandidates
      .map((marker) => text.indexOf(marker))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];

    const stableText = splitIndex === undefined ? text : text.slice(0, splitIndex).trimEnd();
    const dynamicText = splitIndex === undefined ? "." : text.slice(splitIndex).trimStart();
    if (stableText.length < HOIST_THRESHOLD) return;

    const systemBlock = {
      type: "text",
      text: stableText,
    };

    if (!Array.isArray(body.system)) {
      body.system = body.system ? [{ type: "text", text: body.system }] : [];
    }
    body.system.push(systemBlock);

    first.content = [{ type: "text", text: dynamicText || "." }];
  }


  private shouldUseProxyToolCacheWorkaround(provider: LLMProvider | undefined, body: Record<string, any>): boolean {
    if (!Array.isArray(body.tools) || body.tools.length === 0) return false;
    const configured = provider?.options?.proxyToolCacheWorkaround;
    if (typeof configured === "boolean") return configured;
    if (provider?.options?.disableProxyToolCacheAutoDetect) return false;

    try {
      const host = new URL(provider?.baseUrl || "").hostname.toLowerCase();
      return host === "api.opeapi.cn" || host.endsWith(".opeapi.cn");
    } catch {
      return false;
    }
  }

  private stableJson(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableJson(item)).join(",")}]`;
    }
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableJson(item)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  private moveToolSpecsIntoCachedSystemForProxy(body: Record<string, any>): void {
    if (!Array.isArray(body.tools) || body.tools.length === 0) return;
    if (!Array.isArray(body.system)) {
      body.system = body.system ? [{ type: "text", text: body.system }] : [];
    }
    if (body.system.some((block: any) =>
      typeof block?.text === "string" && block.text.includes("<ccr_cached_tool_specs>")
    )) {
      return;
    }

    const fullTools = JSON.parse(JSON.stringify(body.tools, (key, value) =>
      key === "cache_control" ? undefined : value
    ));
    const toolSpecsText = [
      "<ccr_cached_tool_specs>",
      "The provider may not cache the real tools field. Treat these as the full authoritative tool schemas; the compact tools field below only exposes callable names.",
      this.stableJson(fullTools),
      "</ccr_cached_tool_specs>",
    ].join("\n");

    const mergeTarget = [...body.system]
      .reverse()
      .find((block: any) => block?.type === "text" && typeof block.text === "string");
    if (mergeTarget) {
      mergeTarget.text = `${mergeTarget.text}\n\n${toolSpecsText}`;
    } else {
      body.system.push({ type: "text", text: toolSpecsText });
    }

    const mergedSystemText = body.system
      .map((block: any) => block?.type === "text" && typeof block.text === "string" ? block.text : JSON.stringify(block || ""))
      .join("\n\n");
    body.system = [{ type: "text", text: mergedSystemText }];

    body.tools = body.tools.map((tool: any) => ({
      name: tool.name,
      description: `Use this tool exactly according to its full schema in <ccr_cached_tool_specs>.`,
      input_schema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: true,
      },
    }));
  }

  private moveOversizedSystemTailToCachedUserTurn(body: Record<string, any>, provider?: LLMProvider): void {
    if (!provider?.options?.proxySystemTailToUserCache) return;
    if (!Array.isArray(body.system) || body.system.length !== 1) return;
    if (!Array.isArray(body.messages) || body.messages.length === 0) return;

    const systemBlock = body.system[0];
    const systemText = systemBlock?.type === "text" && typeof systemBlock.text === "string"
      ? systemBlock.text
      : "";
    const headChars = Number(provider?.options?.proxySystemHeadChars || 70000);
    const MIN_TAIL_CHARS = 4000;
    if (systemText.length <= headChars + MIN_TAIL_CHARS) return;

    const splitAt = this.findSafeSystemSplitIndex(systemText, headChars);
    const head = systemText.slice(0, splitAt).trimEnd();
    const tail = systemText.slice(splitAt).trimStart();
    if (tail.length < MIN_TAIL_CHARS) return;

    body.system = [{ ...systemBlock, text: head }];
    body.messages.unshift({
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "<ccr_cached_system_tail>",
            "This is stable instruction/context overflow moved from system to a cacheable user-prefix block. Treat it as authoritative system context, not as the current user request.",
            tail,
            "</ccr_cached_system_tail>",
          ].join("\n"),
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  }

  private findSafeSystemSplitIndex(text: string, target: number): number {
    const searchStart = Math.max(0, target - 3000);
    const searchEnd = Math.min(text.length, target + 3000);
    const window = text.slice(searchStart, searchEnd);
    const markers = ["\n<", "\n## ", "\n# ", "\n---", "\n\n"];
    for (const marker of markers) {
      const index = window.lastIndexOf(marker);
      if (index > 0) return searchStart + index;
    }
    return target;
  }

  private seedFirstHoistedTurnForCacheWarmup(body: Record<string, any>, provider?: LLMProvider): void {
    if (!provider?.options?.cacheWarmupFirstTurn) return;
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length !== 1) return;
    const first = messages[0];
    if (first?.role !== "user") return;
    if (!Array.isArray(first.content) || first.content.length !== 1) return;
    const firstText = first.content[0]?.type === "text" ? first.content[0]?.text : undefined;
    if (firstText !== ".") return;

    messages.push(
      {
        role: "assistant",
        content: [{ type: "text", text: "Context received." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Continue." }],
      }
    );
  }

  private ensureAnthropicCacheBreakpoints(
    body: Record<string, any>,
    provider?: LLMProvider,
    options: { skipToolsBreakpoint?: boolean; skipSystemBreakpoint?: boolean } = {}
  ): void {
    const MAX_CACHE_BREAKPOINTS = 4;

    const countCacheControls = (value: any): number => {
      if (!value) return 0;
      if (Array.isArray(value)) {
        return value.reduce((sum, item) => sum + countCacheControls(item), 0);
      }
      if (typeof value === "object") {
        return (
          (value.cache_control ? 1 : 0) +
          Object.entries(value)
            .filter(([key]) => key !== "cache_control")
            .reduce((sum, [, item]) => sum + countCacheControls(item), 0)
        );
      }
      return 0;
    };

    const blockTextLength = (block: any): number => {
      if (!block || typeof block !== "object") return 0;
      if (block.type === "text" && typeof block.text === "string") {
        return block.text.length;
      }
      if (block.type === "tool_result") {
        if (typeof block.content === "string") return block.content.length;
        return JSON.stringify(block.content || "").length;
      }
      return 0;
    };

    let cacheControlCount = countCacheControls(body.system) + countCacheControls(body.tools) + countCacheControls(body.messages);
    const addCacheControl = (block: any) => {
      if (
        cacheControlCount >= MAX_CACHE_BREAKPOINTS ||
        !block ||
        typeof block !== "object" ||
        block.cache_control
      ) {
        return false;
      }
      block.cache_control = { type: "ephemeral" };
      cacheControlCount++;
      return true;
    };

    if (!options.skipToolsBreakpoint && Array.isArray(body.tools) && body.tools.length > 0) {
      addCacheControl(body.tools[body.tools.length - 1]);
    }

    if (!options.skipSystemBreakpoint && Array.isArray(body.system) && body.system.length > 0) {
      body.system.forEach((block: any) => addCacheControl(block));
    } else if (!options.skipSystemBreakpoint && typeof body.system === "string" && body.system.length > 0) {
      body.system = [
        {
          type: "text",
          text: body.system,
          cache_control: { type: "ephemeral" },
        },
      ];
      cacheControlCount++;
    }

    // Many API proxies (e.g. opeapi.cn) only honor cache_control on system and tools,
    // ignoring it on message content blocks. Placing breakpoints on messages in that case
    // causes cache misses: req-1 writes a prefix of system+tools (45,922 tokens), but
    // req-2 writes system+tools+message[0] (46,320 tokens) — a different prefix that
    // doesn't match req-1's cache. By skipping message-level breakpoints entirely, all
    // requests share the same cache prefix (system+tools) and hit from req-2 onward.
    //
    // Control hierarchy (first truthy wins):
    //   1. Provider-level: provider.options.cacheMessagesBreakpoint (in config.json per-provider)
    //   2. Global: CACHE_MESSAGES_BREAKPOINT=true in config.json (sets CCR_CACHE_MESSAGES_BREAKPOINT=1)
    //   3. Default: false (skip message-level breakpoints)
    const enableMessageBreakpoints =
      provider?.options?.cacheMessagesBreakpoint ??
      (process.env.CCR_CACHE_MESSAGES_BREAKPOINT === "1");

    if (enableMessageBreakpoints) {
      const MIN_CACHEABLE_CHARS = 1200;
      const LARGE_FIRST_MSG_CHARS = 10000;

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const lastIndex = messages.length - 1;
      let stableEndIndex = messages[lastIndex]?.role === "user" ? lastIndex - 1 : lastIndex;
      if (stableEndIndex < 0 && messages[0]?.role === "user") {
        const firstContent = Array.isArray(messages[0]?.content) ? messages[0].content : [];
        const firstBlockLen = firstContent.length > 0 ? blockTextLength(firstContent[0]) : 0;
        if (firstBlockLen >= LARGE_FIRST_MSG_CHARS) {
          stableEndIndex = 0;
        }
      }
      const candidates: Array<{ block: any; length: number; position: number }> = [];

      for (let i = 0; i <= stableEndIndex; i++) {
        const message = messages[i];
        if (!Array.isArray(message?.content)) continue;
        for (let j = 0; j < message.content.length; j++) {
          const block = message.content[j];
          if (block?.cache_control) continue;
          if (block?.type !== "text" && block?.type !== "tool_result") continue;
          const length = blockTextLength(block);
          if (length < MIN_CACHEABLE_CHARS) continue;
          candidates.push({
            block,
            length,
            position: i * 1000 + j,
          });
        }
      }

      candidates
        .sort((a, b) => b.length - a.length || a.position - b.position)
        .forEach((candidate) => {
          addCacheControl(candidate.block);
        });
    }
  }

  private buildMessagesUrl(baseUrl: string): URL {
    const url = new URL(baseUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, "");

    if (normalizedPath.endsWith("/messages")) {
      return url;
    }

    if (!normalizedPath || normalizedPath === "/") {
      url.pathname = "/v1/messages";
      return url;
    }

    if (normalizedPath.endsWith("/v1")) {
      url.pathname = `${normalizedPath}/messages`;
      return url;
    }

    url.pathname = `${normalizedPath}/messages`;
    return url;
  }

  private hasMessageContent(content: UnifiedMessage["content"]): boolean {
    if (typeof content === "string") return content.length > 0;
    return Array.isArray(content) && content.length > 0;
  }

  private convertUnifiedContentToAnthropic(content: UnifiedMessage["content"]): any[] {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }

    if (!Array.isArray(content)) {
      return [];
    }

    return content
      .map((item: any) => {
        if (item.type === "text") {
          return {
            type: "text",
            text: item.text || "",
            ...(item.cache_control ? { cache_control: item.cache_control } : {}),
          };
        }

        if (item.type === "image_url") {
          const url = item.image_url?.url || "";
          if (url.startsWith("data:")) {
            const match = url.match(/^data:([^;]+);base64,(.*)$/);
            if (match) {
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: match[1],
                  data: match[2],
                },
              };
            }
          }

          return {
            type: "image",
            source: {
              type: "url",
              url,
            },
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  private convertAnthropicResponseToOpenAI(data: any): any {
    if (data?.error) {
      return { error: data.error };
    }

    const contentParts = Array.isArray(data?.content) ? data.content : [];
    const text = contentParts
      .filter((part: any) => part.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("");

    const toolCalls = contentParts
      .filter((part: any) => part.type === "tool_use")
      .map((part: any) => ({
        id: part.id,
        type: "function",
        function: {
          name: part.name || "",
          arguments: JSON.stringify(part.input || {}),
        },
      }));

    const stopReasonMapping: Record<string, string> = {
      end_turn: "stop",
      max_tokens: "length",
      tool_use: "tool_calls",
      stop_sequence: "stop",
    };

    return {
      id: data?.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: data?.model || "",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          logprobs: null,
          finish_reason:
            stopReasonMapping[data?.stop_reason] ||
            (toolCalls.length ? "tool_calls" : "stop"),
        },
      ],
      usage: {
        prompt_tokens: data?.usage?.input_tokens || 0,
        completion_tokens: data?.usage?.output_tokens || 0,
        total_tokens:
          (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0),
        prompt_tokens_details: {
          cached_tokens: data?.usage?.cache_read_input_tokens || 0,
        },
      },
    };
  }

  private async convertAnthropicStreamToOpenAI(
    anthropicStream: ReadableStream,
    context: TransformerContext
  ): Promise<ReadableStream> {
    return new ReadableStream({
      start: async (controller) => {
        const reader = anthropicStream.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = "";
        let messageId = `chatcmpl-${Date.now()}`;
        let model = "";
        let currentToolCall: { id: string; name: string } | null = null;
        let inputTokens = 0;
        let outputTokens = 0;
        let finished = false;
        let lastAnthropicUsage: Record<string, any> | null = null;
        let lastAnthropicStopReason: string | null = null;

        const maybeDelayForPromptCachePropagation = async () => {
          const cacheCreated = Number(lastAnthropicUsage?.cache_creation_input_tokens || 0);
          const cacheRead = Number(lastAnthropicUsage?.cache_read_input_tokens || 0);
          const threshold = Number(process.env.CCR_CACHE_PROPAGATION_DELAY_THRESHOLD || "20000");
          const delayMs = Number(process.env.CCR_CACHE_PROPAGATION_DELAY_MS || "3000");
          if (lastAnthropicStopReason !== "tool_use" || cacheRead > 0 || cacheCreated < threshold || delayMs <= 0) {
            return;
          }
          this.logger?.info?.(
            {
              reqId: context.req.id,
              cacheCreated,
              cacheRead,
              delayMs,
              stopReason: lastAnthropicStopReason,
            },
            "delaying OpenAI stream finish for prompt cache propagation"
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        };

        const enqueueChunk = (chunk: any) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        const finish = async () => {
          if (finished) return;
          finished = true;
          await maybeDelayForPromptCachePropagation();
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        };

        const finishReasonMapping: Record<string, string> = {
          end_turn: "stop",
          max_tokens: "length",
          tool_use: "tool_calls",
          stop_sequence: "stop",
        };

        const handleEvent = async (event: any) => {
          if (event?.error) {
            enqueueChunk({ error: event.error });
            return;
          }

          if (event.type === "message_start") {
            writeCacheUsageDebug(context?.req?.id, event.message?.usage || {}, {
              source: "anthropic_sse_message_start",
              messageId: event.message?.id,
            });
            messageId = event.message?.id || messageId;
            model = event.message?.model || model;
            inputTokens = event.message?.usage?.input_tokens || inputTokens;
            outputTokens = event.message?.usage?.output_tokens || outputTokens;
            enqueueChunk({
              id: messageId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant" },
                  finish_reason: null,
                },
              ],
            });
            return;
          }

          if (event.type === "content_block_start") {
            const block = event.content_block;
            if (block?.type === "tool_use") {
              currentToolCall = {
                id: block.id || `call_${Date.now()}`,
                name: block.name || "",
              };
              enqueueChunk({
                id: messageId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: currentToolCall.id,
                          type: "function",
                          function: {
                            name: currentToolCall.name,
                            arguments: "",
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            }
            return;
          }

          if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta?.type === "text_delta") {
              enqueueChunk({
                id: messageId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: delta.text || "" },
                    finish_reason: null,
                  },
                ],
              });
            } else if (delta?.type === "input_json_delta") {
              enqueueChunk({
                id: messageId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          ...(currentToolCall?.id ? { id: currentToolCall.id } : {}),
                          type: "function",
                          function: {
                            ...(currentToolCall?.name ? { name: currentToolCall.name } : {}),
                            arguments: delta.partial_json || "",
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            } else if (delta?.type === "thinking_delta") {
              enqueueChunk({
                id: messageId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { thinking: { content: delta.thinking || "" } },
                    finish_reason: null,
                  },
                ],
              });
            }
            return;
          }

          if (event.type === "message_delta") {
            lastAnthropicUsage = event.usage || null;
            lastAnthropicStopReason = event.delta?.stop_reason || null;
            writeCacheUsageDebug(context?.req?.id, event.usage || {}, {
              source: "anthropic_sse_message_delta",
              stopReason: event.delta?.stop_reason,
            });
            inputTokens =
              event.usage?.input_tokens ??
              event.usage?.cache_creation_input_tokens ??
              inputTokens;
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            const cachedTokens = event.usage?.cache_read_input_tokens || 0;
            enqueueChunk({
              id: messageId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason:
                    finishReasonMapping[event.delta?.stop_reason] || "stop",
                },
              ],
              usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
                prompt_tokens_details: {
                  cached_tokens: cachedTokens,
                },
              },
            });
            return;
          }

          if (event.type === "message_stop") {
            await finish();
          }
        };

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                await handleEvent(JSON.parse(data));
              } catch (error) {
                this.logger?.debug?.({
                  reqId: context?.req?.id,
                  error: error instanceof Error ? error.message : String(error),
                  data,
                }, "Failed to parse Anthropic stream event");
              }
            }
          }
          await finish();
        } catch (error) {
          controller.error(error);
        } finally {
          try {
            reader.releaseLock();
          } catch {}
          controller.close();
        }
      },
    });
  }

  private convertOpenAIResponseToAnthropic(
    openaiResponse: ChatCompletion,
    context: TransformerContext
  ): any {
    this.logger.debug(
      {
        reqId: context.req.id,
        response: openaiResponse,
      },
      `Original OpenAI response`
    );
    try {
      const choice = openaiResponse.choices[0];
      if (!choice) {
        throw new Error("No choices found in OpenAI response");
      }
      const content: any[] = [];
      if (choice.message.annotations) {
        const id = `srvtoolu_${uuidv4()}`;
        content.push({
          type: "server_tool_use",
          id,
          name: "web_search",
          input: {
            query: "",
          },
        });
        content.push({
          type: "web_search_tool_result",
          tool_use_id: id,
          content: choice.message.annotations.map((item) => {
            return {
              type: "web_search_result",
              url: item.url_citation.url,
              title: item.url_citation.title,
            };
          }),
        });
      }
      if (choice.message.content) {
        content.push({
          type: "text",
          text: choice.message.content,
        });
      }
      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        choice.message.tool_calls.forEach((toolCall) => {
          let parsedInput = {};
          try {
            const fn = (toolCall as any).function;
            const argumentsStr = fn?.arguments || "{}";

            if (typeof argumentsStr === "object") {
              parsedInput = argumentsStr;
            } else if (typeof argumentsStr === "string") {
              parsedInput = JSON.parse(argumentsStr);
            }
          } catch {
            const fn = (toolCall as any).function;
            parsedInput = { text: fn?.arguments || "" };
          }

          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: ((toolCall as any).function?.name as string) || "",
            input: parsedInput,
          });
        });
      }
      if ((choice.message as any)?.thinking?.content) {
        content.push({
          type: "thinking",
          thinking: (choice.message as any).thinking.content,
          signature: (choice.message as any).thinking.signature,
        });
      }
      const result = {
        id: openaiResponse.id,
        type: "message",
        role: "assistant",
        model: openaiResponse.model,
        content: content,
        stop_reason:
          choice.finish_reason === "stop"
            ? "end_turn"
            : choice.finish_reason === "length"
            ? "max_tokens"
            : choice.finish_reason === "tool_calls"
            ? "tool_use"
            : choice.finish_reason === "content_filter"
            ? "stop_sequence"
            : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens:
            (openaiResponse.usage?.prompt_tokens || 0) -
            (openaiResponse.usage?.prompt_tokens_details?.cached_tokens || 0),
          output_tokens: openaiResponse.usage?.completion_tokens || 0,
          cache_read_input_tokens:
            openaiResponse.usage?.prompt_tokens_details?.cached_tokens || 0,
        },
      };
      this.logger.debug(
        {
          reqId: context.req.id,
          result,
        },
        `Conversion complete, final Anthropic response`
      );
      return result;
    } catch {
      throw createApiError(
        `Provider error: ${JSON.stringify(openaiResponse)}`,
        500,
        "provider_error"
      );
    }
  }
}
