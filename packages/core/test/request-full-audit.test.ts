import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendUnifiedRequest } from "../src/utils/request";
import type { UnifiedChatRequest } from "../src/types/llm";

const auditDir = mkdtempSync(join(tmpdir(), "ccr-request-audit-"));
const oldAuditDir = process.env.CCR_MESSAGE_AUDIT_DIR;
const oldFullAudit = process.env.CCR_FULL_REQUEST_AUDIT;
const oldFetch = globalThis.fetch;

process.env.CCR_MESSAGE_AUDIT_DIR = auditDir;
process.env.CCR_FULL_REQUEST_AUDIT = "1";

let capturedBody = "";
globalThis.fetch = (async (_url: any, init?: any) => {
  capturedBody = String(init?.body || "");
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as any;

try {
  const request: UnifiedChatRequest = {
    model: "audit-test-model",
    messages: [
      { role: "system", content: "base system" },
      {
        role: "user",
        content: "<rules>soul-genome</rules> UserPromptSubmit systemMessage [Soul Genome] [灵魂进化摘要]",
      },
    ],
    stream: false,
  };

  await sendUnifiedRequest(
    "https://example.invalid/v1/chat/completions",
    request,
    { headers: {}, TIMEOUT: 5_000 },
    { req: { id: "audit-test-req" } },
  );

  assert.equal(capturedBody, JSON.stringify(request), "fetch should receive the final request body");

  const files = readdirSync(auditDir);
  const messageAuditFile = files.find((name) => name.startsWith("message-audit-") && name.endsWith(".json"));
  const fullAuditFile = files.find((name) => name.startsWith("final-request-") && name.endsWith(".json"));

  assert.ok(messageAuditFile, "message audit file should be written");
  assert.ok(fullAuditFile, "full final request audit file should be written when CCR_FULL_REQUEST_AUDIT=1");

  const messageAudit = JSON.parse(readFileSync(join(auditDir, messageAuditFile!), "utf-8"));
  assert.equal(messageAudit.injectionDiagnostics.markerPresence.soulGenome.present, true);
  assert.equal(messageAudit.injectionDiagnostics.markerPresence.userPromptSubmit.present, true);
  assert.equal(messageAudit.injectionDiagnostics.markerPresence.systemMessage.present, true);
  assert.deepEqual(messageAudit.injectionDiagnostics.markerPresence.soulGenome.locations, ["messages[1].content"]);

  const fullAudit = JSON.parse(readFileSync(join(auditDir, fullAuditFile!), "utf-8"));
  assert.deepEqual(fullAudit.body, request);
  assert.equal(fullAudit.bodyJson, JSON.stringify(request));
  assert.equal(fullAudit.bodyBytes, Buffer.byteLength(JSON.stringify(request), "utf8"));

  console.log("request full audit behavior ok");
} finally {
  globalThis.fetch = oldFetch;
  if (oldAuditDir === undefined) delete process.env.CCR_MESSAGE_AUDIT_DIR;
  else process.env.CCR_MESSAGE_AUDIT_DIR = oldAuditDir;
  if (oldFullAudit === undefined) delete process.env.CCR_FULL_REQUEST_AUDIT;
  else process.env.CCR_FULL_REQUEST_AUDIT = oldFullAudit;
  rmSync(auditDir, { recursive: true, force: true });
}
