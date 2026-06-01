import assert from "node:assert/strict";
import { AnthropicTransformer } from "../src/transformer/anthropic.transformer";
import { DeepseekTransformer } from "../src/transformer/deepseek.transformer";
import { ConfigService } from "../src/services/config";
import { ProviderService } from "../src/services/provider";
import { TransformerService } from "../src/services/transformer";
import type { LLMProvider, UnifiedChatRequest } from "../src/types/llm";

const transformer = new AnthropicTransformer();

const provider: LLMProvider = {
  name: "opeapi-test",
  baseUrl: "https://api.opeapi.cn/v1/messages",
  apiKey: "test-key",
  models: ["claude-opus-4-7"],
};

const request: UnifiedChatRequest = {
  model: "claude-opus-4-7",
  messages: [
    {
      role: "system",
      content: "stable system prompt",
    },
    {
      role: "user",
      content: "please read a file",
    },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from disk with a detailed schema that should be cached via system for proxy compatibility.",
        parameters: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Absolute file path to read." },
            offset: { type: "number", description: "Line offset." },
            limit: { type: "number", description: "Line limit." },
          },
          required: ["filePath"],
          additionalProperties: false,
        },
      },
    },
  ],
};

const { body } = await transformer.transformRequestIn(request, provider);

assert.ok(Array.isArray(body.system), "system should be block array when proxy tool-cache workaround is active");
assert.equal(body.system.length, 1, "tool specs should be merged into an existing system block, not appended as a later uncached block");
assert.ok(
  typeof body.system[0].text === "string" && body.system[0].text.includes("<ccr_cached_tool_specs>"),
  "full tool specs should be inserted into the cached system block"
);
assert.equal(body.tools.length, 1);
assert.equal(body.tools[0].name, "read_file");
assert.equal(body.tools[0].input_schema.additionalProperties, true);
assert.deepEqual(body.tools[0].input_schema.required || [], []);
assert.ok(
  JSON.stringify(body.tools).length < JSON.stringify(request.tools).length,
  "wire tools should be minimized so proxy-lost tool cache no longer costs full schema each turn"
);

const tailProvider: LLMProvider = {
  ...provider,
  options: {
    proxySystemTailToUserCache: true,
    proxySystemHeadChars: 120,
  },
};
const tailRequest: UnifiedChatRequest = {
  ...request,
  messages: [
    {
      role: "system",
      content: `${"stable system paragraph\n\n".repeat(20)}tail marker ${"stable tail paragraph\n".repeat(200)}`,
    },
    {
      role: "user",
      content: "real current user request",
    },
  ],
};
const { body: tailBody } = await transformer.transformRequestIn(tailRequest, tailProvider);
assert.ok(Array.isArray(tailBody.system));
assert.ok(tailBody.system[0].text.length < 5000, "system head should be reduced when tail-to-user cache is enabled");
assert.equal(tailBody.messages[0].role, "user");
assert.ok(tailBody.messages[0].content[0].text.includes("<ccr_cached_system_tail>"));
assert.deepEqual(tailBody.messages[0].content[0].cache_control, { type: "ephemeral" });
assert.equal(tailBody.messages[1].role, "user");
assert.ok(tailBody.messages[1].content[0].text.includes("real current user request"));

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

const anthropicSse = [
  "event: message_start",
  "data: {",
  "data: \"type\":\"message_start\",",
  "data: \"message\":{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"minimax-m3\",\"content\":[],\"usage\":{\"input_tokens\":14,\"output_tokens\":0}}",
  "data: }",
  "",
  "event: content_block_start",
  "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
  "",
  "event: content_block_delta",
  "data: {",
  "data: \"type\":\"content_block_delta\",",
  "data: \"index\":0,",
  "data: \"delta\":{\"type\":\"text_delta\",\"text\":\"主人，德姨在。\"}",
  "data: }",
  "",
  "event: message_delta",
  "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"input_tokens\":14,\"output_tokens\":6,\"cache_read_input_tokens\":37462}}",
  "",
  "event: message_stop",
  "data: {\"type\":\"message_stop\"}",
  "",
].join("\n");

const sseResponse = new Response(anthropicSse, {
  headers: { "Content-Type": "text/event-stream" },
});
const converted = await transformer.transformResponseOut(sseResponse, { req: { id: "test-sse-frame-parser" } } as any);
const convertedText = await readStreamText(converted.body as ReadableStream<Uint8Array>);

assert.match(convertedText, /"delta":\{"role":"assistant"\}/);
assert.match(convertedText, /"delta":\{"content":"主人，德姨在。"\}/);
assert.match(convertedText, /"finish_reason":"stop"/);
assert.ok(convertedText.includes("data: [DONE]"));
assert.notEqual(convertedText.trim(), "data: [DONE]", "converted stream must not drop all Anthropic SSE chunks");

const splitAnthropicSseStream = new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();
    const cuts = [
      "event: message_start\nd",
      "ata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_split\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"minimax-m3\",\"content\":[],\"usage\":{\"input_tokens\":14,\"output_tokens\":0}}}\n\nevent: content_block_start\nd",
      "ata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\nd",
      "ata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"。*\"}}\n\nevent: content_block_stop\nd",
      "ata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":14,\"output_tokens\":253,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":37462}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ];
    for (const cut of cuts) controller.enqueue(encoder.encode(cut));
    controller.close();
  },
});
const splitConverted = await transformer.transformResponseOut(new Response(splitAnthropicSseStream, {
  headers: { "Content-Type": "text/event-stream" },
}), { req: { id: "test-sse-byte-split-parser" } } as any);
const splitConvertedText = await readStreamText(splitConverted.body as ReadableStream<Uint8Array>);

assert.match(splitConvertedText, /"delta":\{"role":"assistant"\}/);
assert.match(splitConvertedText, /"delta":\{"content":"。\*"\}/);
assert.match(splitConvertedText, /"finish_reason":"stop"/);
assert.notEqual(splitConvertedText.trim(), "data: [DONE]", "byte-split SSE stream must not collapse to DONE only");

const configService = new ConfigService({
  useJsonFile: false,
  useEnvironmentVariables: false,
  initialConfig: {
    providers: [
      {
        name: "minimax-m3-OpenCode",
        api_base_url: "https://opencode.ai/zen/go/v1",
        api_key: "test-key",
        api: "Anthropic",
        models: [{ name: "minimax-m3", alias: ["minimax-m3-OpenCode"] }],
      },
      {
        name: "opencode-deepseek",
        api_base_url: "https://opencode.ai/zen/go/v1",
        api_key: "test-key",
        api: "OpenAI",
        models: [{ name: "deepseek-v4-flash" }],
      },
    ],
  },
});
const transformerService = new TransformerService(configService, { info() {}, warn() {}, error() {} });
transformerService.registerTransformer("Anthropic", new AnthropicTransformer());
transformerService.registerTransformer("OpenAI", { name: "OpenAI" } as any);
transformerService.registerTransformer("deepseek", DeepseekTransformer as any);
const providerService = new ProviderService(configService, transformerService, { info() {}, warn() {}, error() {} });

const anthropicOpencodeProvider = providerService.getProvider("minimax-m3-OpenCode");
assert.ok(anthropicOpencodeProvider?.transformer?.use?.some((item: any) => item?.name === "Anthropic"));
assert.ok(
  !anthropicOpencodeProvider?.transformer?.use?.some((item: any) => item?.name === "deepseek"),
  "Anthropic opencode provider must not auto-attach deepseek transformer",
);

const openAiOpencodeProvider = providerService.getProvider("opencode-deepseek");
assert.ok(openAiOpencodeProvider?.transformer?.use?.some((item: any) => item?.name === "deepseek"));

console.log("proxy tool cache workaround behavior ok");





