export type RuntimeEventLevel = "info" | "success" | "error";

export interface RuntimeEvent {
  id: number;
  timestamp: string;
  level: RuntimeEventLevel;
  requestId?: string;
  provider?: string;
  model?: string;
  message: string;
  detail?: string;
  durationMs?: number;
}

const maxEvents = 200;
const maxTrackedRequests = 1000;
let nextEventId = 1;
const events: RuntimeEvent[] = [];

type RequestState = "pending" | "success" | "failed";

type UsageSnapshot = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export interface RuntimeMetrics {
  requests: {
    total: number;
    successful: number;
    failed: number;
    active: number;
  };
  tokens: UsageSnapshot & {
    reportedRequests: number;
  };
  cacheHitRate: number | null;
}

const requestStates = new Map<string, RequestState>();
const requestUsage = new Map<string, UsageSnapshot>();
const runtimeMetrics: RuntimeMetrics = {
  requests: {
    total: 0,
    successful: 0,
    failed: 0,
    active: 0,
  },
  tokens: {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedRequests: 0,
  },
  cacheHitRate: null,
};

function rememberRequest<T>(map: Map<string, T>, requestId: string, value: T): void {
  map.delete(requestId);
  map.set(requestId, value);
  if (map.size > maxTrackedRequests) {
    const oldestRequestId = map.keys().next().value;
    if (oldestRequestId) map.delete(oldestRequestId);
  }
}

function readUsageNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function extractUsageSnapshot(usage: Record<string, any>): Partial<UsageSnapshot> {
  const inputTokens = readUsageNumber(usage.input_tokens, usage.prompt_tokens);
  const completionTokens = readUsageNumber(usage.output_tokens, usage.completion_tokens);
  const cacheReadTokens = readUsageNumber(
    usage.cache_read_input_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_tokens_details?.cached_tokens,
  );
  const cacheWriteTokens = readUsageNumber(usage.cache_creation_input_tokens);
  const usesAnthropicCacheAccounting =
    usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  const promptTokens = inputTokens === undefined
    ? undefined
    : inputTokens
      + (usesAnthropicCacheAccounting ? (cacheReadTokens || 0) + (cacheWriteTokens || 0) : 0);

  return {
    promptTokens,
    completionTokens,
    totalTokens: readUsageNumber(usage.total_tokens),
    cacheReadTokens,
    cacheWriteTokens,
  };
}

export function recordRuntimeRequestStarted(requestId: string | undefined): void {
  if (!requestId || requestStates.has(requestId)) return;
  rememberRequest(requestStates, requestId, "pending");
  runtimeMetrics.requests.total += 1;
  runtimeMetrics.requests.active += 1;
}

export function recordRuntimeRequestSucceeded(requestId: string | undefined): void {
  if (!requestId) return;
  const previous = requestStates.get(requestId);
  if (previous === "success" || previous === "failed") return;
  if (!previous) {
    runtimeMetrics.requests.total += 1;
  } else {
    runtimeMetrics.requests.active = Math.max(0, runtimeMetrics.requests.active - 1);
  }
  runtimeMetrics.requests.successful += 1;
  rememberRequest(requestStates, requestId, "success");
}

export function recordRuntimeRequestFailed(requestId: string | undefined): void {
  if (!requestId) return;
  const previous = requestStates.get(requestId);
  if (previous === "success" || previous === "failed") return;
  if (!previous) {
    runtimeMetrics.requests.total += 1;
  } else {
    runtimeMetrics.requests.active = Math.max(0, runtimeMetrics.requests.active - 1);
  }
  runtimeMetrics.requests.failed += 1;
  rememberRequest(requestStates, requestId, "failed");
}

export function recordRuntimeUsage(requestId: string | undefined, usage: unknown): void {
  if (!requestId || !usage || typeof usage !== "object") return;

  const wasReported = requestUsage.has(requestId);
  const previous = requestUsage.get(requestId) || {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const partial = extractUsageSnapshot(usage as Record<string, any>);
  const nextPromptTokens = partial.promptTokens ?? previous.promptTokens;
  const nextCompletionTokens = partial.completionTokens ?? previous.completionTokens;
  const next = {
    promptTokens: nextPromptTokens,
    completionTokens: nextCompletionTokens,
    totalTokens: partial.totalTokens ?? nextPromptTokens + nextCompletionTokens,
    cacheReadTokens: partial.cacheReadTokens ?? previous.cacheReadTokens,
    cacheWriteTokens: partial.cacheWriteTokens ?? previous.cacheWriteTokens,
  };

  for (const key of Object.keys(next) as Array<keyof UsageSnapshot>) {
    runtimeMetrics.tokens[key] += next[key] - previous[key];
  }
  if (!wasReported) runtimeMetrics.tokens.reportedRequests += 1;
  rememberRequest(requestUsage, requestId, next);
  runtimeMetrics.cacheHitRate = runtimeMetrics.tokens.promptTokens > 0
    ? runtimeMetrics.tokens.cacheReadTokens / runtimeMetrics.tokens.promptTokens
    : null;
}

export function getRuntimeMetrics(): RuntimeMetrics {
  return {
    requests: { ...runtimeMetrics.requests },
    tokens: { ...runtimeMetrics.tokens },
    cacheHitRate: runtimeMetrics.cacheHitRate,
  };
}

export function recordRuntimeEvent(event: Omit<RuntimeEvent, "id" | "timestamp">): RuntimeEvent {
  const entry: RuntimeEvent = {
    id: nextEventId++,
    timestamp: new Date().toISOString(),
    ...event,
  };

  events.push(entry);
  if (events.length > maxEvents) {
    events.splice(0, events.length - maxEvents);
  }
  return entry;
}

export function getRuntimeEvents(limit = 100): RuntimeEvent[] {
  const count = Math.max(1, Math.min(Number.isFinite(limit) ? Math.floor(limit) : 100, maxEvents));
  return events.slice(-count).reverse();
}