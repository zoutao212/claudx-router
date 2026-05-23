import assert from "node:assert/strict";
import { AnthropicTransformer } from "../src/transformer/anthropic.transformer";
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

console.log("proxy tool cache workaround behavior ok");

