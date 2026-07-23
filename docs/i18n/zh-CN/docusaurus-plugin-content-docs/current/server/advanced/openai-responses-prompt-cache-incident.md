---
title: OpenAI Responses 提示词缓存事故记录
sidebar_position: 2
---

# OpenAI Responses 提示词缓存未命中事故记录

本文记录一次经过 CCR 真实运行日志和上游 A/B 对照确认的缓存未命中问题。目的不是解释一次故障，而是固定这条请求转换链的工程约束，防止未来修改代码后再次破坏缓存，却又重新经历漫长排查。

## 状态摘要

- **受影响入口：** OpenAI 兼容的 `POST /v1/chat/completions`
- **上游出口：** `POST /v1/responses`
- **受影响转换器：** `OpenAIResponsesTransformer`
- **已观察模型：** 通过 `openai-responses` Provider 路由的 GPT 模型
- **故障表现：** 多轮请求具有稳定且持续增长的公共前缀，但每次都返回 `cached_tokens: 0`
- **直接根因：** 最终发送给 Responses 上游的请求没有 `prompt_cache_key`
- **修复策略：** 保留调用方显式键；有会话头时优先使用会话头；否则根据稳定会话身份确定性派生缓存键

本问题与 Anthropic 的 `cache_control` 断点、Anthropic 消息历史重组不是同一类问题。没有运行时证据时，不要把本文结论直接套用到 Anthropic 路径。

## 用户可见现象

计费面板连续显示大输入请求，却没有任何缓存读取 Token。随着对话增长，输入 Token 不断增加，但每轮仍按完整提示词读取计费。

`cache-debug-20260723.jsonl` 捕获的代表性上游 usage：

| CCR 请求 | 输入 Token | 缓存 Token | 与前一请求的关系 |
|---|---:|---:|---|
| `req-1` | 28,578 | 0 | 基线请求 |
| `req-2` | 28,946 | 0 | 保留原前缀，仅在尾部追加新项 |
| `req-3` | 29,102 | 0 | 保留原前缀，仅在尾部追加新项 |
| `req-4` | 29,199 | 0 | 保留原前缀，仅在尾部追加新项 |
| `req-5` | 29,547 | 0 | 保留原前缀，仅在尾部追加新项 |
| `req-6` | 29,703 | 0 | 保留原前缀，仅在尾部追加新项 |

首字延迟低不能证明命中了缓存。唯一可靠的结果信号是上游 usage：

```json
{
  "input_tokens_details": {
    "cached_tokens": 0
  }
}
```

## 请求链路

本问题涉及的数据流如下：

```text
OpenAI 客户端请求
  POST /v1/chat/completions
        |
        v
handleTransformerEndpoint()
  packages/core/src/api/routes.ts
        |
        v
processRequestTransformers()
        |
        v
OpenAIResponsesTransformer.transformRequestIn()
        |
        v
buildResponsesRequest()
  messages -> instructions + input
  OpenAI tools -> Responses tools
  选择或派生 prompt_cache_key
        |
        v
sendUnifiedRequest()
        |
        v
上游 POST /v1/responses
        |
        v
response.completed.usage.input_tokens_details.cached_tokens
```

缓存键必须存在于 `sendUnifiedRequest()` 最终发送的请求体中。只在入站请求或中间对象里存在，没有意义。

## 运行时证据

### 可缓存前缀稳定

安全缓存诊断证明，相邻请求的核心可缓存结构完全稳定：

- `instructionsHash = 0ce52225209fa2c0`
- `toolsHash = 5f2eec07d36c197a`
- `controlsHash = 1f7fb105067256a5`
- 工具数量始终为 `22`
- 公共 `input` 前缀逐项、逐字节一致
- 每次相邻差异都是 `section: "input_append"`

这排除了指令、工具、模型控制参数和既有会话历史被改写的可能。完整请求体 Hash 变化只是因为尾部增加了新会话项，这是前缀缓存应当支持的正常形态。

### 缓存键缺失

所有未命中的真实请求都记录了：

```json
{
  "format": "responses",
  "promptCacheKeyPresent": false
}
```

同时，每次上游完成事件都返回：

```json
{
  "input_tokens_details": {
    "cache_write_tokens": 0,
    "cached_tokens": 0
  }
}
```

原实现只从 `x-conversation-id` 请求头生成缓存键。主请求链已经正确把 Fastify 请求和请求头传入转换器，因此 `promptCacheKeyPresent: false` 可以直接证明：这批真实请求既没有显式 Body 缓存键，也没有转换器可用的会话头。

### 受控 A/B 证明

通过同一个正在运行的 CCR 实例和同一个上游 Provider，执行了两组连续请求。

#### 显式稳定缓存键

两次请求使用完全相同的长提示词和相同 `prompt_cache_key`：

| 次数 | Prompt Token | 缓存 Token |
|---|---:|---:|
| 第一次 | 6,419 | 0 |
| 第二次 | 6,419 | **5,888** |

#### 不提供缓存键

使用另一份全新但两次完全相同的长提示词，不提供 `prompt_cache_key`：

| 次数 | Prompt Token | 缓存 Token |
|---|---:|---:|
| 第一次 | 9,622 | 0 |
| 第二次 | 9,622 | **0** |

这组 A/B 证明了五件事：

1. 上游 Provider 支持提示词缓存。
2. CCR 能正确转发显式缓存键。
3. CCR 能正确映射上游缓存 Token usage。
4. 对本次观察到的 Provider，仅有稳定前缀、没有稳定缓存键时不会命中。
5. 缺陷位于缓存键生成，而不是计费面板、响应映射或前缀稳定性。

## 根因

旧缓存键策略实际等价于：

```text
调用方显式 prompt_cache_key
  或 x-conversation-id 派生键
  或不发送缓存键
```

原单元测试手工提供了 `x-conversation-id`，而真实客户端没有发送这个请求头。因此测试覆盖的是一个理想化请求，不是实际流量。

代码实现和测试彼此一致，却同时与运行时事实不一致。这正是问题在“测试通过”后仍然存在，并导致排查过程反复、长久的原因。

## 已实施策略

转换器现在按以下优先级选择缓存键：

```text
1. 保留调用方提供的非空 prompt_cache_key。
2. 存在 x-conversation-id 时，使用 cursor:<x-conversation-id>。
3. 否则根据稳定会话身份派生 ccr:<digest>。
```

派生身份由以下字段组成：

```text
model
+ instructions/system messages
+ tools
+ 第一个非 system 会话项
```

摘要使用 SHA-256，并截取 32 个十六进制字符，添加 `ccr:` 命名空间。

### 为什么选择这些字段

- **模型：** 防止不同模型身份意外共用缓存键。
- **指令：** 隔离行为规则或系统策略不同的会话。
- **工具定义：** 隔离可调用能力和 schema 不同的会话。
- **首个会话项：** 在不包含后续追加轮次的前提下标识会话。

后续轮次绝对不能参与派生键身份。否则对话每增长一次，缓存键就变化一次，缓存会永久处于冷状态。

### 隐私约束

CCR 只把摘要放入派生缓存键，不会把原始指令、工具 schema 或用户文本写入 `prompt_cache_key`。安全缓存诊断也只记录键是否存在和键的短 Hash，不记录键值与提示词原文。

## 必须保持的代码不变量

未来任何修改都必须保持以下约束。

### 缓存键不变量

1. 调用方显式提供的非空 `prompt_cache_key` 永远优先。
2. 同一会话尾部追加历史时，缓存键保持不变。
3. 第一个会话项不同，应生成不同派生键。
4. 指令或工具定义不同，应生成不同派生键。
5. 缓存键不得包含请求 ID、TCP 端口、时间戳、随机 UUID、响应 ID或当前历史长度。
6. 没有首个会话项的空请求，不得获得一个所有请求共享的随意兜底键。
7. 缓存键生成不得修改入站请求对象。

### 请求前缀不变量

同一会话的相邻轮次必须满足：

- `model` 稳定。
- `instructions` 稳定。
- `tools` 稳定并保持确定性顺序。
- 之前的 `input` 项逐项、逐字节一致。
- 新项只追加在 `input` 尾部。

稳定缓存键无法弥补被改写的请求前缀。缓存命中同时要求“键稳定”和“前缀稳定”。

### Usage 映射不变量

Responses usage：

```json
{
  "input_tokens": 55310,
  "input_tokens_details": {
    "cached_tokens": 28160
  },
  "output_tokens": 90,
  "total_tokens": 55400
}
```

转换为 OpenAI 兼容响应后必须保留为：

```json
{
  "prompt_tokens": 55310,
  "prompt_tokens_details": {
    "cached_tokens": 28160
  },
  "completion_tokens": 90,
  "total_tokens": 55400
}
```

如果上游 usage 已经大于零，但客户端或面板仍显示零，应排查响应 usage 映射，而不是继续修改请求缓存键。

## 回归测试

核心回归测试：

```text
packages/core/test/openai-responses-cache.test.ts
```

必须覆盖：

- 保留显式缓存键
- 根据 `x-conversation-id` 生成键
- 没有会话头时确定性生成兜底键
- 追加消息时键保持稳定
- 首个用户消息不同时键应不同
- 指令、工具和 `input` 前缀稳定
- Responses 到 Chat Completions 的缓存 usage 映射
- 安全诊断不持久化提示词原文

必须在 core 包上下文运行，确保 TypeScript 路径别名正确解析：

```bash
pnpm --filter @musistudio/llms tsx test/openai-responses-cache.test.ts
```

路由级测试：

```text
packages/core/test/openai-responses-end-to-end.test.ts
```

该测试故意不发送 `x-conversation-id`，并断言相邻两轮到达上游时具有相同派生键。

```bash
pnpm --filter @musistudio/llms tsx test/openai-responses-end-to-end.test.ts
```

事故处理时，该路由级用例在进入缓存断言前，被仓库既有且无关的导出错误阻塞：`plugins/index.ts` 导出了 `getGlobalTokenSpeedStats`，但 `token-speed.ts` 没有提供该导出。不要把这个测试基础设施错误误报为缓存回归失败。

构建验证：

```bash
pnpm build:core
pnpm build:server
pnpm build:docs
```

## 运行时验证流程

### 1. 开启安全缓存诊断

设置：

```bat
set CCR_CACHE_DEBUG=1
```

然后重启 CCR。已经运行的 `ts-node` 进程不会热加载源码和配置变更。

### 2. 在同一会话产生至少两个相邻轮次

第二次请求必须完整保留第一次请求前缀，并在尾部增加 assistant、user 或 tool 项。

### 3. 检查缓存诊断

打开：

```text
~/.claude-code-router/logs/cache-debug-YYYYMMDD.jsonl
```

期望请求记录：

```json
{
  "kind": "cache_request_structure",
  "summary": {
    "format": "responses",
    "promptCacheKeyPresent": true
  },
  "adjacentDiff": {
    "section": "input_append"
  }
}
```

期望第二次 usage 记录：

```json
{
  "kind": "cache_usage_attribution",
  "usage": {
    "input_tokens_details": {
      "cached_tokens": 1
    }
  }
}
```

实际缓存 Token 数量会变化，但必须大于零才能确认命中。

## 最短诊断矩阵

| 观察结果 | 优先排查位置 |
|---|---|
| `promptCacheKeyPresent: false` | 缓存键选择或请求转换 |
| 相邻轮次缓存键 Hash 变化 | 派生规则或会话 ID 不稳定 |
| 键稳定，但 `instructionsHash` 变化 | 动态指令或 system 注入 |
| 键稳定，但 `toolsHash` 变化 | 工具 schema 或顺序被修改 |
| 相邻差异不是 `input_append` | 历史转换或前缀重写 |
| 键与前缀稳定，上游仍为 `cached_tokens: 0` | Provider 缓存能力、策略、TTL 或路由亲和性 |
| 上游 `cached_tokens > 0`，客户端/面板显示零 | 响应 usage 映射或 UI 计费统计 |
| 源码已改但运行行为不变 | CCR 未重启或启动了错误构建产物 |

按表格从上到下排查。不要首先比较完整 `bodyHash`，因为对话增长时完整请求体本来就必须变化。

## 常见错误方向

### 把完整请求体变化当成缓存失效证据

后续轮次一定会产生不同的完整请求体。应检查的是“前一请求是否仍是后一请求的精确前缀”，不是 `bodyHash` 是否相等。

### 用延迟判断缓存命中

快速响应也可能返回零缓存 Token。必须检查上游 usage。

### 只测试人为添加的会话头

始终提供 `x-conversation-id` 的测试保护不了不发送该头的真实客户端。无请求头路径是强制回归场景。

### 使用随机兜底键

随机 UUID 会让每次请求进入不同缓存分片，效果等同于关闭缓存复用。

### 用完整当前历史生成键

历史每轮都增长，因此键每轮都会变化。只能使用会话期间保持稳定的身份字段。

### 未确认上游 usage 就修改计费面板

上游返回零时，面板显示零是正确行为。应先修复请求。

## 代码职责归属

该行为主要由以下文件负责：

- `packages/core/src/transformer/openai.responses.transformer.ts`
  - Responses 请求构造
  - 缓存键选择与派生
  - 缓存 Token 响应映射
- `packages/core/src/utils/request.ts`
  - 最终请求缓存诊断
  - 相邻前缀比较
  - usage 归因诊断
- `packages/core/src/api/routes.ts`
  - 转换器上下文和请求头传递
- `packages/core/test/openai-responses-cache.test.ts`
  - 聚焦缓存契约回归
- `packages/core/test/openai-responses-end-to-end.test.ts`
  - 路由级无请求头回归

任何会改变 Responses 请求结构的修改，都必须重新运行缓存回归。

## 代码审查清单

修改 Responses 转换器后，合并前逐项确认：

- [ ] 显式 `prompt_cache_key` 被保留。
- [ ] 存在稳定首项时，无请求头请求能够得到确定性缓存键。
- [ ] 追加轮次不会改变派生键。
- [ ] 修改指令、工具、模型或首个会话项会改变派生键。
- [ ] 既有 `input` 项保持精确一致，新项只追加到尾部。
- [ ] 缓存 Token usage 在响应转换后仍存在。
- [ ] 缓存诊断只包含 Hash 和计数，不包含提示词原文。
- [ ] 聚焦缓存回归通过。
- [ ] core 与 server 构建通过。
- [ ] 运行时验证前已经重启 CCR。
- [ ] 真实第二次请求出现 `cached_tokens > 0`。

## 最终结论

本次故障不是提示词前缀发生了细微变化。运行时 Hash 已经证明指令、工具、控制参数和既有输入前缀稳定。决定性缺陷是：真实请求没有有效的 `prompt_cache_key`，而观察到的上游需要稳定缓存键才能复用提示词缓存。原测试通过手工添加真实客户端并不发送的会话头，掩盖了这一缺口。

长期修复不是写死某个键，而是使用只依赖稳定会话身份、不会泄露提示词原文的确定性兜底键；同时通过无请求头回归测试和运行时诊断，把“键错误、前缀错误、上游不支持、usage 映射错误”四类问题明确分开。