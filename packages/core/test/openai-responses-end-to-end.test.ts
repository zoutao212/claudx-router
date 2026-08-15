import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import Server from "../src/server";

async function getFreePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function readRequestBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const upstreamBodies: any[] = [];
const upstream = createHttpServer(async (req, res) => {
  try {
    assert.equal(req.url, "/v1/responses");
    upstreamBodies.push(JSON.parse(await readRequestBody(req)));
    const requestNumber = upstreamBodies.length;
    const completed = {
      type: "response.completed",
      response: {
        id: `resp_${requestNumber}`,
        model: "gpt-cache-e2e",
        status: "completed",
        output: [],
        usage: {
          input_tokens: requestNumber === 1 ? 100 : 140,
          input_tokens_details: {
            cached_tokens: requestNumber === 1 ? 0 : 80,
            cache_write_tokens: 0,
          },
          output_tokens: 5,
          total_tokens: requestNumber === 1 ? 105 : 145,
        },
      },
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

const upstreamPort = await getFreePort();
await new Promise<void>((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(upstreamPort, "127.0.0.1", resolve);
});

const routerPort = await getFreePort();
const auditDir = mkdtempSync(join(tmpdir(), "ccr-responses-e2e-"));
const oldAuditDir = process.env.CCR_CACHE_DEBUG_DIR;
const oldCacheDebug = process.env.CCR_CACHE_DEBUG;
process.env.CCR_CACHE_DEBUG_DIR = auditDir;
process.env.CCR_CACHE_DEBUG = "1";

const router = new Server({
  logger: false,
  useJsonFile: false,
  useEnvironmentVariables: false,
  initialConfig: {
    HOST: "127.0.0.1",
    PORT: routerPort,
    providers: [{
      name: "deepseek-responses-mock",
      api_base_url: `http://127.0.0.1:${upstreamPort}/v1/responses`,
      api_key: "test-key",
      api: "openai-responses",
      models: [{ name: "gpt-cache-e2e", alias: "gpt-cache-e2e-alias" }],
    }],
  },
} as any);

async function postChat(messages: any[], model = "gpt-cache-e2e"): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages,
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
    }),
  });
  assert.equal(response.status, 200);
  return response.text();
}

async function postResponses(body: Record<string, any>): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.text();
}

try {
  await router.start();

  const baseMessages = [
    { role: "system", content: "stable system" },
    { role: "user", content: "first question" },
  ];
  const firstResponse = await postChat(baseMessages);
  const secondResponse = await postChat([
    ...baseMessages,
    { role: "assistant", content: "first answer" },
    { role: "user", content: "second question" },
  ]);
  await postChat(baseMessages, "gpt-cache-e2e-alias");
  await postChat(baseMessages, "deepseek-responses-mock/gpt-cache-e2e-alias");

  const nativeInput = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "native responses request" }],
  }];
  const nativeResponse = await postResponses({
    model: "gpt-cache-e2e-alias",
    stream: true,
    input: nativeInput,
    tools: [{ type: "web_search" }],
  });

  const provider = (router as any).providerService.getProvider("deepseek-responses-mock");
  assert.deepEqual(
    provider.transformer.use.map((item: any) => item.name),
    ["openai-responses"],
  );

  const runtimeEventsResponse = await fetch(`http://127.0.0.1:${routerPort}/api/runtime-events?limit=50`);
  assert.equal(runtimeEventsResponse.status, 200);
  const runtimeEvents = await runtimeEventsResponse.json() as {
    events: Array<{ provider?: string; message: string; detail?: string }>;
  };
  const nativeUpstreamEvent = runtimeEvents.events.find((event) =>
    event.provider === "deepseek-responses-mock" &&
    event.message === "正在请求上游"
  );
  assert.equal(
    nativeUpstreamEvent?.detail,
    `openai-responses · http://127.0.0.1:${upstreamPort}/v1/responses`,
  );
  const nativeTransformEvent = runtimeEvents.events.find((event) =>
    event.provider === "deepseek-responses-mock" &&
    event.message === "已转换 API 格式"
  );
  assert.equal(
    nativeTransformEvent?.detail,
    "openai-responses → openai-responses · openai-responses.auth",
  );

  const modelsResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/models`);
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json() as { data: Array<{ id: string }> };
  const modelIds = new Set(models.data.map((model) => model.id));
  assert.ok(modelIds.has("gpt-cache-e2e-alias"));
  assert.ok(modelIds.has("deepseek-responses-mock/gpt-cache-e2e-alias"));

  assert.equal(upstreamBodies.length, 5);
  assert.equal(upstreamBodies[2].model, "gpt-cache-e2e");
  assert.equal(upstreamBodies[3].model, "gpt-cache-e2e");
  const native = upstreamBodies[4];
  assert.equal(native.model, "gpt-cache-e2e");
  assert.deepEqual(native.input, nativeInput);
  assert.equal(native.messages, undefined);
  assert.deepEqual(native.tools, [{ type: "web_search" }]);
  assert.equal(native.input[0].content[0].type, "input_text");
  assert.match(nativeResponse, /response\.completed/);
  const [first, second] = upstreamBodies;
  assert.match(first.prompt_cache_key, /^ccr:[a-f0-9]{32}$/);
  assert.equal(second.prompt_cache_key, first.prompt_cache_key);
  assert.equal(second.instructions, first.instructions);
  assert.deepEqual(second.tools, first.tools);
  assert.deepEqual(second.input.slice(0, first.input.length), first.input);
  assert.equal(second.input.length - first.input.length, 2);
  assert.equal(first.messages, undefined);
  assert.equal(first.store, false);
  assert.equal(first.parallel_tool_calls, false);

  assert.match(firstResponse, /"cached_tokens":0/);
  assert.match(secondResponse, /"cached_tokens":80/);

  const logFile = readdirSync(auditDir).find((name) => name.startsWith("cache-debug-") && name.endsWith(".jsonl"));
  assert.ok(logFile);
  const records = readFileSync(join(auditDir, logFile!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const requestRecords = records.filter((record) => record.kind === "cache_request_structure");
  assert.equal(requestRecords.length, 5);
  assert.equal(requestRecords[0].summary.format, "responses");
  assert.equal(requestRecords[1].adjacentDiff.section, "input_append");
  assert.equal(requestRecords[1].adjacentDiff.commonInputItems, 1);
  assert.equal(requestRecords[1].adjacentDiff.appendedItems, 2);
  assert.equal(requestRecords[4].summary.format, "responses");
  assert.equal(
    records.some((record) =>
      record.kind === "cache_usage_attribution" &&
      record.usage?.input_tokens_details?.cached_tokens === 80
    ),
    true,
  );

  console.log("openai responses end-to-end cache behavior ok");
} finally {
  await (router as any).app.close().catch(() => undefined);
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  if (oldAuditDir === undefined) delete process.env.CCR_CACHE_DEBUG_DIR;
  else process.env.CCR_CACHE_DEBUG_DIR = oldAuditDir;
  if (oldCacheDebug === undefined) delete process.env.CCR_CACHE_DEBUG;
  else process.env.CCR_CACHE_DEBUG = oldCacheDebug;
  rmSync(auditDir, { recursive: true, force: true });
}