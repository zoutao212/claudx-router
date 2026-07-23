---
sidebar_position: 2
title: OpenAI Responses Prompt Cache Incident
sidebar_label: Responses Prompt Cache Incident
---

# OpenAI Responses Prompt Cache Miss Incident

This document records a production-like cache miss investigated through CCR runtime diagnostics. It exists to protect the request transformation contract from future regressions.

## Status

- **Affected path:** OpenAI-compatible `POST /v1/chat/completions` converted to upstream `POST /v1/responses`
- **Affected transformer:** `OpenAIResponsesTransformer`
- **Observed model family:** GPT models routed through an `openai-responses` provider
- **Symptom:** every request reported `cached_tokens: 0` despite a stable, growing conversation prefix
- **Root cause:** the final Responses request did not contain `prompt_cache_key`
- **Resolution:** preserve caller keys, prefer a conversation header when available, and otherwise derive a deterministic key from stable conversation identity

This incident is separate from Anthropic `cache_control` breakpoints and Anthropic message-history normalization. Do not apply this diagnosis to those paths without runtime evidence.

## User-visible symptom

The billing dashboard showed a sequence of large requests with no cache-read tokens. Input tokens increased as the conversation grew, but each request was billed as a full prompt read.

Representative upstream usage captured by `cache-debug-20260723.jsonl`:

| CCR request | Input tokens | Cached tokens | Request relation |
|---|---:|---:|---|
| `req-1` | 28,578 | 0 | Baseline |
| `req-2` | 28,946 | 0 | Previous input plus appended items |
| `req-3` | 29,102 | 0 | Previous input plus appended items |
| `req-4` | 29,199 | 0 | Previous input plus appended items |
| `req-5` | 29,547 | 0 | Previous input plus appended items |
| `req-6` | 29,703 | 0 | Previous input plus appended items |

A low first-token latency is not proof of a cache hit. The authoritative signal is the upstream usage field:

```json
{
  "input_tokens_details": {
    "cached_tokens": 0
  }
}
```

## Request path

The relevant data flow is:

```text
OpenAI client request
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
  prompt cache key selection
        |
        v
sendUnifiedRequest()
        |
        v
Upstream POST /v1/responses
        |
        v
response.completed.usage.input_tokens_details.cached_tokens
```

The cache key must exist in the final body sent by `sendUnifiedRequest()`. A key present only in the inbound request or an intermediate object is insufficient.

## Runtime evidence

### Stable cacheable prefix

Safe cache diagnostics showed that the cacheable structures were stable across adjacent requests:

- `instructionsHash = 0ce52225209fa2c0`
- `toolsHash = 5f2eec07d36c197a`
- `controlsHash = 1f7fb105067256a5`
- tool count remained `22`
- the common `input` prefix remained byte-for-byte identical
- every adjacent difference was `section: "input_append"`

This ruled out changes in instructions, tools, model controls, and prior conversation history. The request body hash changed only because new conversation items were appended at the end, which is the expected shape for prefix caching.

### Missing cache key

Every failed runtime request contained:

```json
{
  "format": "responses",
  "promptCacheKeyPresent": false
}
```

At the same time, every upstream completion reported:

```json
{
  "input_tokens_details": {
    "cache_write_tokens": 0,
    "cached_tokens": 0
  }
}
```

The original implementation generated a key only from the `x-conversation-id` header. The main request path correctly passed the Fastify request and its headers into the transformer, so `promptCacheKeyPresent: false` proved that no effective conversation header or explicit body key was available for these live requests.

### Controlled A/B proof

Two controlled request pairs were sent through the same running CCR instance and the same upstream provider.

#### Stable explicit key

Both requests used the same long prompt and the same explicit `prompt_cache_key`:

| Attempt | Prompt tokens | Cached tokens |
|---|---:|---:|
| First | 6,419 | 0 |
| Second | 6,419 | **5,888** |

#### No key

Both requests used a different but identical long prompt and omitted `prompt_cache_key`:

| Attempt | Prompt tokens | Cached tokens |
|---|---:|---:|
| First | 9,622 | 0 |
| Second | 9,622 | **0** |

This A/B test established all of the following:

1. The upstream provider supported prompt caching.
2. CCR forwarded an explicit cache key correctly.
3. CCR mapped upstream cached-token usage correctly.
4. For the observed provider, a stable prefix without a stable cache key did not produce a cache hit.
5. The defect was in cache-key generation, not billing display, response mapping, or prefix stability.

## Root cause

The previous cache-key policy was effectively:

```text
explicit prompt_cache_key
  OR x-conversation-id-derived key
  OR no key
```

The unit test supplied `x-conversation-id` manually. The real client did not. Therefore the test covered an idealized request that was not representative of the live traffic.

The implementation and test agreed with each other, but both disagreed with runtime reality. This is why the issue survived an apparently successful test and took repeated investigation to isolate.

## Implemented policy

The transformer now selects a cache key in this order:

```text
1. Preserve a non-empty caller-provided prompt_cache_key.
2. Otherwise use cursor:<x-conversation-id> when that header exists.
3. Otherwise derive ccr:<digest> from stable conversation identity.
```

The derived identity contains:

```text
model
+ instructions/system messages
+ tool definitions
+ first non-system conversation item
```

The digest is SHA-256 truncated to 32 hexadecimal characters and namespaced with `ccr:`.

### Why these fields

- **Model:** prevents accidental key reuse across model identities.
- **Instructions:** separates conversations operating under different behavior or policy.
- **Tools:** separates conversations with different callable capabilities or schemas.
- **First conversation item:** identifies the conversation without including later appended turns.

Later turns must not participate in derived key identity. If they do, the key changes on every request and the cache becomes permanently cold.

### Privacy property

CCR sends only the digest in the derived key. It does not place raw instructions, tool schemas, or user text inside `prompt_cache_key`. Safe cache diagnostics also record only key presence and a short hash, not the key or prompt contents.

## Required invariants

Future changes must preserve all of these invariants.

### Cache key invariants

1. A caller-provided non-empty `prompt_cache_key` always wins.
2. The same conversation produces the same key as history is appended.
3. Different first conversation items produce different derived keys.
4. Different instructions or tool definitions produce different derived keys.
5. The key must not include request ID, TCP port, timestamp, random UUID, response ID, or current history length.
6. Empty requests without a first conversation item must not receive an arbitrary shared fallback key.
7. Cache-key generation must not mutate the inbound request.

### Request prefix invariants

For adjacent turns in one conversation:

- `model` remains stable.
- `instructions` remains stable.
- `tools` remains stable and preserves deterministic ordering.
- previous `input` items remain byte-for-byte identical.
- new items are appended only at the end.

A stable key cannot compensate for a rewritten prefix. Both key stability and prefix stability are required.

### Usage mapping invariants

Responses usage:

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

must remain visible to OpenAI-compatible clients as:

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

If upstream usage is non-zero but the dashboard reports zero, inspect response usage mapping rather than request cache-key generation.

## Regression tests

The primary regression test is:

```text
packages/core/test/openai-responses-cache.test.ts
```

It must verify:

- explicit key preservation
- `x-conversation-id` key generation
- no-header deterministic fallback generation
- key stability when messages are appended
- key separation for a different first user message
- stable instructions, tools, and input prefix
- Responses-to-Chat-Completions cached-token usage mapping
- safe diagnostics do not persist prompt text

Run it from the core package context so TypeScript path aliases resolve correctly:

```bash
pnpm --filter @musistudio/llms tsx test/openai-responses-cache.test.ts
```

The route-level test is:

```text
packages/core/test/openai-responses-end-to-end.test.ts
```

It intentionally sends no `x-conversation-id` header and asserts that two adjacent turns arrive upstream with the same derived key.

```bash
pnpm --filter @musistudio/llms tsx test/openai-responses-end-to-end.test.ts
```

At the time of the incident, this route-level test was blocked before reaching the cache assertions by an unrelated existing export mismatch: `plugins/index.ts` exported `getGlobalTokenSpeedStats`, while `token-speed.ts` did not provide that export. Do not misreport that harness failure as a prompt-cache test failure.

Build verification:

```bash
pnpm build:core
pnpm build:server
pnpm build:docs
```

## Runtime verification procedure

### 1. Enable safe cache diagnostics

Set:

```bat
set CCR_CACHE_DEBUG=1
```

Restart CCR. Configuration and source changes are not hot-loaded into an already running `ts-node` process.

### 2. Generate at least two adjacent turns

Use the same conversation and provider. The second request must contain the full first request prefix plus appended assistant/user or tool items.

### 3. Inspect the cache diagnostics

Open:

```text
~/.claude-code-router/logs/cache-debug-YYYYMMDD.jsonl
```

Expected request record:

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

Expected second usage record:

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

The exact cached-token count varies. It must be greater than zero for a confirmed hit.

## Fast diagnosis matrix

| Observation | Most likely fault area |
|---|---|
| `promptCacheKeyPresent: false` | Cache-key selection or request transformation |
| Key hash changes between adjacent turns | Unstable key derivation or conversation ID |
| Key stable, but `instructionsHash` changes | Dynamic instructions or system injection |
| Key stable, but `toolsHash` changes | Tool schema/order mutation |
| Adjacent diff is not `input_append` | History conversion or prefix rewriting |
| Stable key and prefix, upstream `cached_tokens: 0` | Provider cache capability, policy, TTL, or routing affinity |
| Upstream `cached_tokens > 0`, client/dashboard shows zero | Response usage mapping or UI accounting |
| Source changed but runtime behavior did not | CCR process was not restarted or wrong build was launched |

Follow this matrix from top to bottom. Do not start by comparing the full body hash: it must change as a conversation grows.

## Common wrong turns

### Treating full body changes as proof of cache invalidation

A later turn must have a different full body. The relevant question is whether the earlier request remains an exact prefix, not whether `bodyHash` stays equal.

### Trusting latency as cache evidence

Fast responses may still report zero cached tokens. Always inspect upstream usage.

### Testing only with a synthetic conversation header

A test that always supplies `x-conversation-id` cannot protect clients that do not send it. The no-header path is mandatory.

### Generating a random fallback key

A random UUID prevents every subsequent request from sharing the same cache shard. Random fallback keys are equivalent to disabling cache reuse.

### Using the entire current history in the key

The history grows every turn, so the key changes every turn. Derive identity only from fields that remain stable for the conversation.

### Fixing the dashboard before checking upstream usage

If upstream returns zero, the dashboard is displaying the correct result. Repair the request first.

## Code ownership

The behavior is primarily owned by:

- `packages/core/src/transformer/openai.responses.transformer.ts`
  - Responses request construction
  - cache-key selection and derivation
  - cached-token response mapping
- `packages/core/src/utils/request.ts`
  - final-request cache diagnostics
  - adjacent prefix comparison
  - usage attribution diagnostics
- `packages/core/src/api/routes.ts`
  - transformer context and request-header propagation
- `packages/core/test/openai-responses-cache.test.ts`
  - focused cache contract regression
- `packages/core/test/openai-responses-end-to-end.test.ts`
  - route-level no-header regression

Any change to these files that affects Responses request shape must rerun the cache regression.

## Review checklist

Before merging a change to the Responses transformer:

- [ ] Explicit `prompt_cache_key` is preserved.
- [ ] No-header requests receive a deterministic key when a stable first item exists.
- [ ] Appending turns does not change the derived key.
- [ ] Changing instructions, tools, model, or the first conversation item changes the key.
- [ ] Previous `input` items remain exact and new items append at the tail.
- [ ] Cached-token usage survives response conversion.
- [ ] Cache diagnostics contain hashes and counts only, not prompt text.
- [ ] Focused cache regression passes.
- [ ] Core and server builds pass.
- [ ] CCR is restarted before runtime verification.
- [ ] A real second request reports `cached_tokens > 0`.

## Final conclusion

The incident was not caused by a subtly changing prompt prefix. Runtime hashes proved that instructions, tools, controls, and prior input were stable. The decisive defect was that live requests had no effective `prompt_cache_key`, while the observed upstream required a stable key to reuse prompt cache. The original test hid this gap by supplying a conversation header that the real client did not send.

The durable fix is a deterministic, privacy-preserving fallback key based only on stable conversation identity, backed by no-header regression coverage and runtime diagnostics that distinguish key failures, prefix failures, upstream failures, and usage-mapping failures.