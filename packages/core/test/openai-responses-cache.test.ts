import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIResponsesTransformer } from "../src/transformer/openai.responses.transformer";
import { sendUnifiedRequest } from "../src/utils/request";
import type { LLMProvider, UnifiedChatRequest } from "../src/types/llm";

const provider: LLMProvider = {
  name: "responses-test",
  baseUrl: "https://api.aijws.com/v1/responses",
  apiKey: "test-key",
  models: ["gpt-5.6-sol"],
};

function buildChatRequest(): UnifiedChatRequest {
  return {
    model: "gpt-5.6-sol",
    stream: true,
    max_tokens: 2048,
    temperature: 0.2,
    reasoning: { effort: "high" },
    messages: [
      { role: "system", content: "first system" },
      { role: "system", content: [{ type: "text", text: "second system" }] },
      { role: "user", content: "first user" },
      {
        role: "assistant",
        content: "tool incoming",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "Read", arguments: "{\"path\":\"a.ts\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "Read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    }],
    tool_choice: "auto",
  };
}

async function testRequestConversion(): Promise<void> {
  const transformer = new OpenAIResponsesTransformer();
  const request = buildChatRequest();
  const context = { req: { id: "convert-1", headers: { "x-conversation-id": "conversation-123" } } };
  const converted = await transformer.transformRequestIn(request, provider, context) as any;
  const body = converted.body;

  assert.equal(converted.config.url.toString(), "https://api.aijws.com/v1/responses");
  assert.equal(body.prompt_cache_key, "cursor:conversation-123");
  assert.equal(body.instructions, "first system\n\nsecond system");
  assert.equal(body.temperature, undefined);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.max_output_tokens, 2048);
  assert.equal(body.store, false);
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.reasoning, { effort: "high", summary: "detailed" });
  assert.equal(body.input.length, 4);
  assert.deepEqual(body.input[0], {
    role: "user",
    content: [{ type: "input_text", text: "first user" }],
  });
  assert.deepEqual(body.input[1], {
    role: "assistant",
    content: [{ type: "output_text", text: "tool incoming" }],
  });
  assert.deepEqual(body.input[2], {
    type: "function_call",
    arguments: "{\"path\":\"a.ts\"}",
    name: "Read",
    call_id: "call_1",
    status: "completed",
  });
  assert.deepEqual(body.input[3], {
    type: "function_call_output",
    call_id: "call_1",
    output: "file contents",
  });
  assert.equal(body.tools[0].name, "Read");
  assert.ok(Array.isArray(request.messages), "conversion must not mutate the inbound request");
  assert.equal((request as any).input, undefined);

  const nextRequest = buildChatRequest();
  nextRequest.messages.push({ role: "user", content: "next user" });
  const nextConverted = await transformer.transformRequestIn(nextRequest, provider, context) as any;
  assert.equal(nextConverted.body.prompt_cache_key, body.prompt_cache_key);
  assert.equal(nextConverted.body.instructions, body.instructions);
  assert.deepEqual(nextConverted.body.tools, body.tools);
  assert.deepEqual(nextConverted.body.input.slice(0, body.input.length), body.input);

  const derived = await transformer.transformRequestIn(buildChatRequest(), provider, { req: { headers: {} } }) as any;
  const derivedNext = await transformer.transformRequestIn(nextRequest, provider, { req: { headers: {} } }) as any;
  assert.match(derived.body.prompt_cache_key, /^ccr:[a-f0-9]{32}$/);
  assert.equal(derivedNext.body.prompt_cache_key, derived.body.prompt_cache_key);

  const differentConversation = buildChatRequest();
  differentConversation.messages[2] = { role: "user", content: "different first user" };
  const differentDerived = await transformer.transformRequestIn(
    differentConversation,
    provider,
    { req: { headers: {} } },
  ) as any;
  assert.notEqual(differentDerived.body.prompt_cache_key, derived.body.prompt_cache_key);

  const explicitKeyRequest = { ...buildChatRequest(), prompt_cache_key: "caller-key" } as any;
  const explicitKey = await transformer.transformRequestIn(explicitKeyRequest, provider, context) as any;
  assert.equal(explicitKey.body.prompt_cache_key, "caller-key");
}

async function testUsageMappingAndSafeDiagnostics(): Promise<void> {
  const transformer = new OpenAIResponsesTransformer();
  const auditDir = mkdtempSync(join(tmpdir(), "ccr-responses-cache-"));
  const oldAuditDir = process.env.CCR_CACHE_DEBUG_DIR;
  const oldCacheDebug = process.env.CCR_CACHE_DEBUG;
  const oldFetch = globalThis.fetch;

  process.env.CCR_CACHE_DEBUG_DIR = auditDir;
  process.env.CCR_CACHE_DEBUG = "1";
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as any;

  try {
    const baseBody = {
      model: "gpt-5.6-sol",
      stream: true,
      prompt_cache_key: "cursor:conversation-123",
      instructions: "private instruction text",
      tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
      input: [{ role: "user", content: [{ type: "input_text", text: "private user text" }] }],
    };
    const nextBody = {
      ...baseBody,
      input: [
        ...baseBody.input,
        { role: "assistant", content: [{ type: "output_text", text: "private answer" }] },
      ],
    };

    await sendUnifiedRequest(
      "https://example.invalid/v1/responses",
      baseBody as any,
      { headers: {}, TIMEOUT: 5_000 },
      { req: { id: "cache-1", url: "/v1/chat/completions" } },
    );
    await sendUnifiedRequest(
      "https://example.invalid/v1/responses",
      nextBody as any,
      { headers: {}, TIMEOUT: 5_000 },
      { req: { id: "cache-2", url: "/v1/chat/completions" } },
    );

    const completedEvent = {
      type: "response.completed",
      response: {
        id: "resp_test",
        model: "gpt-5.6-sol",
        output: [],
        usage: {
          input_tokens: 55310,
          input_tokens_details: { cached_tokens: 28160, cache_write_tokens: 0 },
          output_tokens: 90,
          total_tokens: 55400,
        },
      },
    };
    const response = new Response(`event: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const transformed = await transformer.transformResponseOut(response, { req: { id: "cache-2" } });
    const output = await transformed.text();
    const chunks = output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    const terminal = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason === "stop");

    assert.deepEqual(terminal.usage, {
      prompt_tokens: 55310,
      completion_tokens: 90,
      total_tokens: 55400,
      prompt_tokens_details: { cached_tokens: 28160 },
    });

    const logFile = readdirSync(auditDir).find((name) => name.startsWith("cache-debug-") && name.endsWith(".jsonl"));
    assert.ok(logFile, "cache diagnostics should be written");
    const logText = readFileSync(join(auditDir, logFile!), "utf8");
    assert.equal(logText.includes("private instruction text"), false);
    assert.equal(logText.includes("private user text"), false);
    assert.equal(logText.includes("private answer"), false);

    const records = logText.trim().split("\n").map((line) => JSON.parse(line));
    const first = records.find((record) => record.kind === "cache_request_structure" && record.reqId === "cache-1");
    const second = records.find((record) => record.kind === "cache_request_structure" && record.reqId === "cache-2");
    const usage = records.find((record) => record.kind === "cache_usage_attribution" && record.reqId === "cache-2");
    assert.equal(first.summary.format, "responses");
    assert.equal(first.summary.promptCacheKeyPresent, true);
    assert.equal(first.summary.inputCount, 1);
    assert.equal(second.adjacentDiff.section, "input_append");
    assert.equal(second.adjacentDiff.commonInputItems, 1);
    assert.equal(second.adjacentDiff.appendedItems, 1);
    assert.equal(usage.usage.input_tokens_details.cached_tokens, 28160);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldAuditDir === undefined) delete process.env.CCR_CACHE_DEBUG_DIR;
    else process.env.CCR_CACHE_DEBUG_DIR = oldAuditDir;
    if (oldCacheDebug === undefined) delete process.env.CCR_CACHE_DEBUG;
    else process.env.CCR_CACHE_DEBUG = oldCacheDebug;
    rmSync(auditDir, { recursive: true, force: true });
  }
}

await testRequestConversion();
await testUsageMappingAndSafeDiagnostics();
console.log("openai responses cache behavior ok");