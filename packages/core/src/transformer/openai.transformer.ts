import { Transformer } from "@/types/transformer";
import { LLMProvider, UnifiedChatRequest } from "@/types/llm";

export class OpenAITransformer implements Transformer {
  name = "OpenAI";
  endPoint = "/v1/chat/completions";
  logger?: any;

  async transformRequestIn(
    request: UnifiedChatRequest,
    provider: LLMProvider
  ): Promise<{ body: UnifiedChatRequest; config: { url: URL; headers: Record<string, string> } }> {
    this.prepareOpenAIRequest(request, provider);

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

  async auth(request: any, provider: LLMProvider): Promise<any> {
    this.prepareOpenAIRequest(request);

    return {
      body: request,
      config: {
        url: this.buildChatCompletionsUrl(provider.baseUrl),
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'text/event-stream, application/json, */*',
        },
      },
    };
  }

  private prepareOpenAIRequest(request: any, provider?: LLMProvider): void {
    this.ensureStreamUsage(request);
    this.ensureClaudeCacheBreakpoints(request, provider);
  }

  private ensureStreamUsage(request: any): void {
    if (!request?.stream) return;

    request.stream_options = {
      ...(request.stream_options || {}),
      include_usage: true,
    };
  }

  private ensureClaudeCacheBreakpoints(request: any, provider?: LLMProvider): void {
    if (!request?.model?.startsWith?.("claude-")) return;
    if (!Array.isArray(request.messages)) return;
    if (this.hasCacheControl(request.messages) || this.hasCacheControl(request.tools)) return;

    const MAX_CACHE_BREAKPOINTS = 4;
    let count = 0;

    const getContentLength = (block: any): number => {
      if (!block || typeof block !== "object") return 0;
      if (block.type === "text" && typeof block.text === "string") return block.text.length;
      if (block.type === "tool_result") {
        if (typeof block.content === "string") return block.content.length;
        return JSON.stringify(block.content || "").length;
      }
      return 0;
    };

    const addCacheControl = (block: any) => {
      if (count >= MAX_CACHE_BREAKPOINTS || !block || typeof block !== "object" || block.cache_control) {
        return false;
      }
      block.cache_control = { type: "ephemeral" };
      count++;
      return true;
    };

    if (Array.isArray(request.tools) && request.tools.length > 0) {
      addCacheControl(request.tools[request.tools.length - 1]);
    }

    const systemMessages = request.messages.filter((message: any) => message?.role === "system");
    const lastSystem = systemMessages[systemMessages.length - 1];
    if (lastSystem) {
      this.ensureMessageContentBlocks(lastSystem);
      const content = Array.isArray(lastSystem.content) ? lastSystem.content : [];
      addCacheControl(content[content.length - 1]);
    }

    // See anthropic.transformer.ts for detailed explanation.
    // Many API proxies ignore cache_control on message content blocks.
    // Control hierarchy: provider.options.cacheMessagesBreakpoint > global env > default (false)
    const enableMessageBreakpoints =
      provider?.options?.cacheMessagesBreakpoint ??
      (process.env.CCR_CACHE_MESSAGES_BREAKPOINT === "1");

    if (enableMessageBreakpoints) {
      const MIN_CACHEABLE_CHARS = 1200;
      const LARGE_FIRST_MSG_CHARS = 10000;

      const lastIndex = request.messages.length - 1;
      let stableEndIndex = request.messages[lastIndex]?.role === "user" ? lastIndex - 1 : lastIndex;
      if (stableEndIndex < 0 && request.messages[0]?.role === "user") {
        this.ensureMessageContentBlocks(request.messages[0]);
        const firstContent = Array.isArray(request.messages[0].content) ? request.messages[0].content : [];
        const firstBlockLen = firstContent.length > 0 ? getContentLength(firstContent[0]) : 0;
        if (firstBlockLen >= LARGE_FIRST_MSG_CHARS) {
          stableEndIndex = 0;
        }
      }
      const candidates: Array<{ block: any; length: number; position: number }> = [];

      for (let i = 0; i <= stableEndIndex; i++) {
        const message = request.messages[i];
        if (!message || message.role === "system") continue;
        this.ensureMessageContentBlocks(message);
        const content = Array.isArray(message.content) ? message.content : [];
        for (let j = 0; j < content.length; j++) {
          const block = content[j];
          if (block?.cache_control) continue;
          if (block?.type !== "text" && block?.type !== "tool_result") continue;
          const length = getContentLength(block);
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

  private ensureMessageContentBlocks(message: any): void {
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content }];
    }
  }

  private hasCacheControl(value: any): boolean {
    if (!value) return false;
    if (Array.isArray(value)) return value.some((item) => this.hasCacheControl(item));
    if (typeof value === "object") {
      if (value.cache_control) return true;
      return Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .some(([, item]) => this.hasCacheControl(item));
    }
    return false;
  }

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

    url.pathname = `${normalizedPath}/chat/completions`;
    return url;
  }
}


