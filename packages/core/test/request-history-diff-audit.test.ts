import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendUnifiedRequest } from "../src/utils/request";
import type { UnifiedChatRequest } from "../src/types/llm";

const auditDir = mkdtempSync(join(tmpdir(), "ccr-history-diff-audit-"));
const oldAuditDir = process.env.CCR_MESSAGE_AUDIT_DIR;
const oldHistoryAudit = process.env.CCR_HISTORY_DIFF_AUDIT;
const oldFetch = globalThis.fetch;

process.env.CCR_MESSAGE_AUDIT_DIR = auditDir;
process.env.CCR_HISTORY_DIFF_AUDIT = "1";

globalThis.fetch = (async () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as any;

try {
  const baseRequest: UnifiedChatRequest = {
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "stable system" },
      { role: "user", content: "stable user" },
      { role: "assistant", content: "stable answer" },
    ],
    stream: false,
  };

  const nextRequest: UnifiedChatRequest = {
    ...baseRequest,
    messages: [
      ...baseRequest.messages,
      { role: "assistant", content: "" },
      { role: "tool", content: "same short tool result", tool_call_id: "call_1" },
      { role: "assistant", content: "" },
      { role: "tool", content: "same short tool result", tool_call_id: "call_2" },
    ],
  };

  await sendUnifiedRequest(
    "https://example.invalid/v1/chat/completions",
    baseRequest,
    { headers: {}, TIMEOUT: 5_000 },
    { req: { id: "history-1", body: baseRequest, url: "/v1/chat/completions" } },
  );

  await sendUnifiedRequest(
    "https://example.invalid/v1/chat/completions",
    nextRequest,
    { headers: {}, TIMEOUT: 5_000 },
    { req: { id: "history-2", body: nextRequest, url: "/v1/chat/completions" } },
  );

  const sanitizedRequest: UnifiedChatRequest = {
    ...nextRequest,
    messages: [
      { role: "system", content: "abc-ciyuanshen-ccr" },
      ...nextRequest.messages.slice(1),
    ],
  };

  await sendUnifiedRequest(
    "https://example.invalid/v1/chat/completions",
    sanitizedRequest,
    { headers: {}, TIMEOUT: 5_000 },
    { req: { id: "history-3", body: sanitizedRequest, url: "/v1/chat/completions" } },
  );

  const file = readdirSync(auditDir).find((name) => name.startsWith("history-diff-audit-") && name.endsWith(".jsonl"));
  assert.ok(file, "history diff audit jsonl should be written");

  const records = readFileSync(join(auditDir, file!), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const second = records.find((record) => record.reqId === "history-2");

  assert.ok(second, "second request should have a history diff record");
  assert.equal(second.model, "gpt-5.5");
  assert.equal(second.requestPath, "/v1/chat/completions");
  assert.equal(second.inboundVsFinal.source, "client");
  assert.equal(second.inboundVsFinal.firstDiff, undefined);
  assert.equal(second.previousFinalDiff.commonPrefixMessages, 3);
  assert.equal(second.previousFinalDiff.appendedTail.length, 4);
  assert.equal(second.previousFinalDiff.appendedTail[0].tailSource, "presentInInboundSameIndex");
  assert.equal(second.previousFinalDiff.appendedTail[1].tailSource, "presentInInboundSameIndex");
  assert.equal(second.previousFinalDiff.appendedTail[2].tailSource, "presentInInboundSameIndex");
  assert.equal(second.previousFinalDiff.appendedTail[3].tailSource, "presentInInboundSameIndex");
  assert.equal(second.anomalies.emptyAssistantMessages.length, 2);
  assert.equal(second.anomalies.repeatedToolContentHashes.length, 1);
  assert.equal(second.anomalies.repeatedToolContentHashes[0].count, 2);

  const third = records.find((record) => record.reqId === "history-3");
  assert.ok(third, "third request should have a history diff record");
  assert.equal(third.inboundVsFinal.source, "ccr");
  assert.deepEqual(third.inboundVsFinal.firstDiff, {
    index: 0,
    inbound: {
      role: "system",
      contentLength: 18,
      contentHash: "3879c8b97e6d08eb",
    },
    final: {
      role: "system",
      contentLength: 13,
      contentHash: "4c6aedc602966f44",
    },
  });

  console.log("history diff audit behavior ok");
} finally {
  globalThis.fetch = oldFetch;
  if (oldAuditDir === undefined) delete process.env.CCR_MESSAGE_AUDIT_DIR;
  else process.env.CCR_MESSAGE_AUDIT_DIR = oldAuditDir;
  if (oldHistoryAudit === undefined) delete process.env.CCR_HISTORY_DIFF_AUDIT;
  else process.env.CCR_HISTORY_DIFF_AUDIT = oldHistoryAudit;
  rmSync(auditDir, { recursive: true, force: true });
}
