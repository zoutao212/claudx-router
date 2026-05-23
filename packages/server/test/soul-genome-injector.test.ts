import assert from "node:assert/strict";
import { applySoulGenomeInjectionForTest } from "../src/utils/soulGenomeInjector";

(async () => {
  const requestBody = {
    model: "gpt-5.4",
    messages: [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "帮我排查 CodeBuddy hook 没执行，想让 CCR 自动注入 soul-genome" },
    ],
  };

  const logs: Array<Record<string, unknown>> = [];
  const result = await applySoulGenomeInjectionForTest(requestBody, {
    enabled: true,
    tokenBudget: 1200,
    memoryTopK: 3,
    requestContext: "workspace=D:/00_Git_GitHub_003/claude-code-router",
    callSoulInject: async ({ userInput, context, tokenBudget, memoryTopK }) => {
      assert.equal(userInput, "帮我排查 CodeBuddy hook 没执行，想让 CCR 自动注入 soul-genome");
      assert.equal(context, "workspace=D:/00_Git_GitHub_003/claude-code-router");
      assert.equal(tokenBudget, 1200);
      assert.equal(memoryTopK, 3);
      return "=== 灵魂人格上下文 (test) ===\n\n自动注入文本";
    },
    log: (record) => logs.push(record),
  });

  assert.equal(result.injected, true);
  assert.equal(requestBody.messages.length, 3);
  assert.equal(requestBody.messages[1].role, "system");
  assert.ok(String(requestBody.messages[1].content).includes("[CCR Soul Genome Auto Injection]"));
  assert.ok(String(requestBody.messages[1].content).includes("自动注入文本"));
  assert.equal(requestBody.messages[2].content, "帮我排查 CodeBuddy hook 没执行，想让 CCR 自动注入 soul-genome");
  assert.equal(logs.some((record) => record.phase === "soul_genome_inject" && record.injected === true), true);

  const second = await applySoulGenomeInjectionForTest(requestBody, {
    enabled: true,
    callSoulInject: async () => "duplicate should not be added",
    log: (record) => logs.push(record),
  });

  assert.equal(second.injected, false);
  assert.equal(requestBody.messages.length, 3);

  console.log("soul genome injector behavior ok");
})();

