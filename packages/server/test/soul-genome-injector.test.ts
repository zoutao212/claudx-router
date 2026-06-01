import assert from "node:assert/strict";
import { applySoulGenomeInjectionForTest, extractSoulInjectTextForTest } from "../src/utils/soulGenomeInjector";

(async () => {
  // ===== Test 0: 标准 MCP tools/call 包装返回解析 =====
  assert.equal(
    extractSoulInjectTextForTest({
      content: [{ type: "text", text: "wrapped soul text" }],
    }),
    "wrapped soul text",
  );

  console.log("Test 0: MCP wrapped soul_inject response parsing ok");

  // ===== Test 1: OpenAI 格式注入 (原始测试) =====
  const requestBody1 = {
    model: "gpt-5.4",
    messages: [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "帮我排查 CodeBuddy hook 没执行，想让 CCR 自动注入 soul-genome" },
    ],
  };

  const logs: Array<Record<string, unknown>> = [];
  const result1 = await applySoulGenomeInjectionForTest(requestBody1, {
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

  assert.equal(result1.injected, true);
  assert.equal(requestBody1.messages.length, 3);
  assert.equal(requestBody1.messages[1].role, "system");
  assert.ok(String(requestBody1.messages[1].content).includes("[CCR Soul Genome Auto Injection]"));
  assert.ok(String(requestBody1.messages[1].content).includes("自动注入文本"));
  assert.equal(requestBody1.messages[2].content, "帮我排查 CodeBuddy hook 没执行，想让 CCR 自动注入 soul-genome");
  assert.equal(logs.some((record) => record.phase === "soul_genome_inject" && record.injected === true), true);

  // ===== Test 2: 重复注入防护 =====
  const second = await applySoulGenomeInjectionForTest(requestBody1, {
    enabled: true,
    callSoulInject: async () => "duplicate should not be added",
    log: (record) => logs.push(record),
  });

  assert.equal(second.injected, false);
  assert.equal(requestBody1.messages.length, 3);

  console.log("Test 1 & 2: OpenAI format injection ok");

  // ===== Test 3: 无 system 角色消息的 OpenAI 格式（unshift 到开头） =====
  const requestBody3 = {
    model: "glm-5.1",
    messages: [
      { role: "user", content: "hello world" },
    ],
  };

  const result3 = await applySoulGenomeInjectionForTest(requestBody3, {
    enabled: true,
    callSoulInject: async () => "injected at head",
    log: () => {},
  });

  assert.equal(result3.injected, true);
  assert.equal(requestBody3.messages[0].role, "system");
  assert.ok(String(requestBody3.messages[0].content).includes("[CCR Soul Genome Auto Injection]"));

  console.log("Test 3: OpenAI format (no prior system) injection ok");

  // ===== Test 4: 无 enabled 配置 =====
  const result4 = await applySoulGenomeInjectionForTest({ messages: [{ role: "user", content: "x" }] }, {
    enabled: false,
    callSoulInject: async () => "should not be called",
    log: () => {},
  });

  assert.equal(result4.injected, false);
  assert.equal(result4.reason, "disabled");

  console.log("Test 4: disabled config ok");

  // ===== Test 5: 空用户消息 =====
  const result5 = await applySoulGenomeInjectionForTest({
    model: "test",
    messages: [{ role: "user", content: "   " }],
  }, {
    enabled: true,
    callSoulInject: async () => "should not be called",
    log: () => {},
  });

  assert.equal(result5.injected, false);
  assert.equal(result5.reason, "empty_user_input");

  console.log("Test 5: empty user input ok");

  console.log("all soul genome injector tests passed");
})();
