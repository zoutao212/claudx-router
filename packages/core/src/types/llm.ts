import type { ChatCompletionMessageParam as OpenAIMessage } from "openai/resources/chat/completions";
import type { MessageParam as AnthropicMessage } from "@anthropic-ai/sdk/resources/messages";
import type {
  ChatCompletion,
  ChatCompletionChunk,
} from "openai/resources/chat/completions";
import type {
  Message,
  MessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import { Transformer } from "./transformer";
import type { ProviderTokenizerConfig } from "./tokenizer";

export interface UrlCitation {
  url: string;
  title: string;
  content: string;
  start_index: number;
  end_index: number;
}
export interface Annotation {
  type: "url_citation";
  url_citation?: UrlCitation;
}

// 内容类型定义
export interface TextContent {
  type: "text";
  text: string;
  cache_control?: {
    type?: string;
  };
}

export interface ImageContent {
  type: "image_url";
  image_url: {
    url: string;
  };
  media_type: string;
}

export type MessageContent = TextContent | ImageContent;

// 统一的消息接口
export interface UnifiedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null | MessageContent[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  cache_control?: {
    type?: string;
  };
  thinking?: {
    content: string;
    signature?: string;
  };
}

// 统一的工具定义接口
export interface UnifiedTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
      additionalProperties?: boolean;
      $schema?: string;
    };
  };
}

export type ThinkLevel = "none" | "low" | "medium" | "high";

// 统一的请求接口
export interface UnifiedChatRequest {
  messages: UnifiedMessage[];
  model: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: UnifiedTool[];
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | string
    | { type: "function"; function: { name: string } };
  reasoning?: {
    // OpenAI-style
    effort?: ThinkLevel;

    // Anthropic-style
    max_tokens?: number;

    enabled?: boolean;
  };
}

// 统一的响应接口
export interface UnifiedChatResponse {
  id: string;
  model: string;
  content: string | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  annotations?: Annotation[];
}

// 流式响应相关类型
export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices?: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      thinking?: {
        content?: string;
        signature?: string;
      };
      tool_calls?: Array<{
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
      annotations?: Annotation[];
    };
    finish_reason?: string | null;
  }>;
}

// Anthropic 流式事件类型
export type AnthropicStreamEvent = MessageStreamEvent;

// OpenAI 流式块类型
export type OpenAIStreamChunk = ChatCompletionChunk;

// OpenAI 特定类型
export interface OpenAIChatRequest {
  messages: OpenAIMessage[];
  model: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: ChatCompletionTool[];
  tool_choice?:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } };
}

// Anthropic 特定类型
export interface AnthropicChatRequest {
  messages: AnthropicMessage[];
  model: string;
  max_tokens: number;
  temperature?: number;
  stream?: boolean;
  system?: string;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" } | { type: "tool"; name: string };
}

// 转换选项
export interface ConversionOptions {
  targetProvider: "openai" | "anthropic";
  sourceProvider: "openai" | "anthropic";
}

export interface ModelAlias {
  /** The actual model name sent to the provider's API */
  name: string;
  /** One or more alias names that clients can use to reference this model */
  alias: string | string[];
}

/** A model entry can be a plain string (the model name) or a ModelAlias object */
export type ModelEntry = string | ModelAlias;

export interface LLMProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ModelEntry[];
  /** Maximum concurrent requests allowed to this provider. Default: Infinity (no limit) */
  maxConcurrency?: number;
  /** Provider-level options for fine-tuning behavior */
  options?: {
    /** Whether to place cache_control breakpoints on message content blocks.
     *  Some proxies (e.g. opeapi.cn) ignore message-level cache_control.
     *  Set to false (default) to skip message breakpoints for consistent cache prefixes.
     *  Set to true when connecting directly to Anthropic API which supports them. */
    cacheMessagesBreakpoint?: boolean;
    /** Provider-level tool allow list. If set, only these tool/function names are sent upstream.
     *  Useful for providers/proxies that do not cache tools and would otherwise charge
     *  large tool schemas as normal input every request. */
    toolAllowList?: string[];
    /** Alias of toolAllowList for config readability. */
    allowedTools?: string[];
    /** Dynamically choose a smaller tool subset based on the current request text.
     *  This preserves tool availability for common workflows while avoiding full tool
     *  schema cost on providers/proxies that do not cache tools. */
    autoToolFilter?: boolean;
    /** Insert full Anthropic tool specs into cached system blocks and send minimized wire tools.
     *  This works around API proxies that accept /v1/messages but internally convert
     *  through OpenAI/sub2api-style schemas and drop tools[].cache_control.
     *  Defaults to auto-enable for known affected proxy hosts such as opeapi.cn. */
    proxyToolCacheWorkaround?: boolean;
    /** Move the tail of an oversized system block into a stable first user message with
     *  cache_control. Experimental workaround for proxies that only cache the first
     *  ~40k tokens of system but may cache later user-message prefixes. */
    proxySystemTailToUserCache?: boolean;
    /** Character budget kept in system before moving the tail to a cached user turn. */
    proxySystemHeadChars?: number;
    [key: string]: any;
  };
  transformer?: {
    [key: string]: {
      use?: Transformer[];
    };
  } & {
    use?: Transformer[];
  };
}

export type RegisterProviderRequest = Omit<LLMProvider, 'models'> & { models: ModelEntry[] };

export interface ModelRoute {
  provider: string;
  model: string;
  fullModel: string;
  /** Aliases that also resolve to this route */
  aliases?: string[];
}

export interface RequestRouteInfo {
  provider: LLMProvider;
  originalModel: string;
  targetModel: string;
}

export interface ConfigProvider {
  name: string;
  api_base_url: string;
  api_key: string;
  models: ModelEntry[];
  /** Maximum concurrent requests allowed to this provider. Default: Infinity (no limit) */
  max_concurrency?: number;
  transformer: {
    use?: string[] | Array<any>[];
  } & {
    [key: string]: {
      use?: string[] | Array<any>[];
    };
  };
  tokenizer?: ProviderTokenizerConfig;
}
