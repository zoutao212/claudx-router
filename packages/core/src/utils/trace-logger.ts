import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type TraceRecord = Record<string, unknown>;

type TraceOptions = {
  enabled: boolean;
  dir: string;
  maxFieldLength: number;
};

let cachedStream:
  | {
      key: string;
      stream: ReturnType<typeof createWriteStream>;
      opts: TraceOptions;
    }
  | undefined;

const sseConsoleBuffers = new Map<
  string,
  {
    text: string;
    bytes: number;
    lastFlushAt: number;
    meta: Record<string, unknown>;
  }
>();

function asNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getTraceOptions(): TraceOptions {
  const enabled =
    parseBoolean(process.env.CCR_TRACE) ||
    parseBoolean(process.env.CLAUDE_CODE_ROUTER_TRACE) ||
    parseBoolean(process.env.TRACE);

  const dir =
    process.env.CCR_TRACE_DIR ||
    process.env.CLAUDE_CODE_ROUTER_TRACE_DIR ||
    process.env.TRACE_DIR ||
    join(process.cwd(), "logs", "trace");

  const maxFieldLength = Number.parseInt(
    process.env.CCR_TRACE_MAX_FIELD_LENGTH ||
      process.env.CLAUDE_CODE_ROUTER_TRACE_MAX_FIELD_LENGTH ||
      "200000",
    10
  );

  return {
    enabled,
    dir,
    maxFieldLength: Number.isFinite(maxFieldLength) ? maxFieldLength : 200000,
  };
}

function isoDateKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getStream(): { stream: ReturnType<typeof createWriteStream>; opts: TraceOptions } | undefined {
  const opts = getTraceOptions();
  if (!opts.enabled) return undefined;

  const dateKey = isoDateKey(new Date());
  const key = `${opts.dir}|${dateKey}`;

  if (cachedStream && cachedStream.key === key) {
    return { stream: cachedStream.stream, opts: cachedStream.opts };
  }

  if (!existsSync(opts.dir)) {
    mkdirSync(opts.dir, { recursive: true });
  }

  const filePath = join(opts.dir, `${dateKey}.jsonl`);
  const stream = createWriteStream(filePath, { flags: "a" });
  cachedStream = { key, stream, opts };
  return { stream, opts };
}

function truncateDeep(value: unknown, maxLen: number): unknown {
  if (typeof value === "string") {
    if (value.length <= maxLen) return value;
    return value.slice(0, maxLen) + `...<truncated:${value.length - maxLen}>`;
  }
  if (Array.isArray(value)) {
    return value.map((v) => truncateDeep(v, maxLen));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateDeep(v, maxLen);
    }
    return out;
  }
  return value;
}

export function redactHeaders(headers: unknown): Record<string, unknown> {
  const obj = (headers && typeof headers === "object" ? headers : {}) as Record<
    string,
    unknown
  >;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (
      lk === "authorization" ||
      lk === "x-api-key" ||
      lk === "cookie" ||
      lk === "set-cookie"
    ) {
      out[k] = "<redacted>";
      continue;
    }
    out[k] = v;
  }
  return out;
}

function consoleLog(record: TraceRecord, maxLen = 300): void {
  const phase = String(record.phase || "unknown");
  const ts = String(record.ts || new Date().toISOString());

  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "..." : s);
  const shortenPath = (s: string) => {
    const normalized = s.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 4) return normalized;
    return parts.slice(0, 1).join("/") + "/.../" + parts.slice(-2).join("/");
  };
  const normalizeExtra = (obj: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        const key = k.toLowerCase();
        const maybePath = key.includes("path") || key.includes("file") || key.includes("filename") || key.includes("dir");
        const s = maybePath ? shortenPath(v) : v;
        out[k] = truncate(s, 140);
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  const isSseChunk = phase.endsWith(":chunk") && phase.includes("sse");
  const isSseTerminal =
    (phase.endsWith(":done") || phase.endsWith(":cancel")) && phase.includes("sse");

  const getExtra = () =>
    normalizeExtra(
      Object.fromEntries(
        Object.entries(record).filter(
          ([k]) => !["ts", "phase", "body", "bodyText", "text", "message"].includes(k)
        )
      ) as Record<string, unknown>
    );

  const flushKeyFromRecord = () => {
    const reqId = typeof record.reqId === "string" ? record.reqId : "";
    const requestUrl = typeof (record as any).requestUrl === "string" ? String((record as any).requestUrl) : "";
    return `${phase.split(":")[0]}|${reqId}|${requestUrl}`;
  };

  const flushBuffer = (key: string, reason: "threshold" | "interval" | "terminal") => {
    const buf = sseConsoleBuffers.get(key);
    if (!buf || !buf.text) return;
    const extraStr = Object.keys(buf.meta).length ? ` ${JSON.stringify({ ...buf.meta, flush: reason })}` : "";
    console.log(`[${ts}] upstream_sse:chunk${extraStr ? " " + JSON.stringify({ ...buf.meta, flush: reason }) : ""} | ${buf.text.slice(0, maxLen)}`);
    buf.text = "";
    buf.bytes = 0;
    buf.lastFlushAt = Date.now();
  };

  if (isSseChunk) {
    const key = flushKeyFromRecord();
    const buf = sseConsoleBuffers.get(key) || {
      text: "",
      bytes: 0,
      lastFlushAt: 0,
      meta: {},
    };

    const text = typeof record.text === "string" ? record.text : "";
    const bytes = typeof (record as any).bytes === "number" ? (record as any).bytes : 0;

    if (!buf.lastFlushAt) buf.lastFlushAt = Date.now();
    buf.text += text;
    buf.bytes += bytes;
    buf.meta = getExtra();
    sseConsoleBuffers.set(key, buf);

    const flushChars = asNumberEnv("CCR_TRACE_SSE_CONSOLE_FLUSH_CHARS", 160);
    const flushIntervalMs = asNumberEnv("CCR_TRACE_SSE_CONSOLE_FLUSH_INTERVAL_MS", 800);
    const now = Date.now();
    if (buf.text.length >= flushChars) {
      flushBuffer(key, "threshold");
    } else if (now - buf.lastFlushAt >= flushIntervalMs) {
      flushBuffer(key, "interval");
    }
    return;
  }

  if (isSseTerminal) {
    const key = flushKeyFromRecord();
    flushBuffer(key, "terminal");
    sseConsoleBuffers.delete(key);
  }

  const body = (() => {
    if (record.body) return JSON.stringify(record.body).slice(0, maxLen);
    if (record.bodyText && typeof record.bodyText === "string") return record.bodyText.slice(0, maxLen);
    if (record.text && typeof record.text === "string") return record.text.slice(0, maxLen);
    if (record.message && typeof record.message === "string") return record.message;
    return "";
  })();

  const extra = getExtra();
  const bodyOut = typeof body === "string" ? truncate(body, maxLen) : body;
  console.log(`[${ts}] ${phase}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""} | ${bodyOut}`);
}

export function traceLog(record: TraceRecord): void {
  const out = getStream();
  if (!out) return;

  const { stream, opts } = out;
  const enriched: TraceRecord = {
    ts: new Date().toISOString(),
    ...record,
  };

  const safe = truncateDeep(enriched, opts.maxFieldLength);
  try {
    stream.write(JSON.stringify(safe) + "\n");
  } catch {
    stream.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        phase: "trace_logger_error",
        message: "Failed to serialize trace record",
      }) + "\n"
    );
  }

  // Also echo a truncated version to console for dev visibility (opt-in)
  if (process.env.CCR_TRACE_CONSOLE === "1") {
    consoleLog(safe as TraceRecord);
  }

  // Always log important events to console for operational visibility
  const phase = String(record.phase || "unknown");
  const isImportant = [
    "incoming_request",
    "request_completed", 
    "request_error",
    "upstream_retry",
    "provider_response_error"
  ].includes(phase);
  
  if (isImportant) {
    const reqId = typeof record.reqId === "string" ? record.reqId : "";
    const status = record.status || record.statusCode || "";
    const retryAttempt = record.retryAttempt || "";
    const retryMax = record.retryMax || "";
    const bodySha256 = (typeof record.bodySha256 === "string" && record.bodySha256) ? record.bodySha256.slice(0, 8) + "..." : "";
    
    let consoleMsg = `[CCR] ${phase}`;
    if (reqId) consoleMsg += ` ${reqId}`;
    if (status) consoleMsg += ` status:${status}`;
    if (retryAttempt && retryMax) consoleMsg += ` retry:${retryAttempt}/${retryMax}`;
    if (bodySha256) consoleMsg += ` hash:${bodySha256}`;
    
    console.log(consoleMsg);
  }
}

// Export a one-time init logger to help verify tracing works at startup
export function traceInit(): void {
  traceLog({ phase: "trace_init", message: "Trace logger initialized and working" });
}

export async function traceStream(
  params: {
    reqId?: string;
    stream: ReadableStream<Uint8Array>;
    phase: string;
    meta?: Record<string, unknown>;
  }
): Promise<ReadableStream<Uint8Array>> {
  const out = getStream();
  if (!out) return params.stream;

  const reader = params.stream.getReader();
  const decoder = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        traceLog({
          phase: params.phase + ":done",
          reqId: params.reqId,
          ...params.meta,
        });
        controller.close();
        return;
      }
      if (value) {
        const text = decoder.decode(value, { stream: true });
        traceLog({
          phase: params.phase + ":chunk",
          reqId: params.reqId,
          bytes: value.byteLength,
          text,
          ...params.meta,
        });
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      traceLog({
        phase: params.phase + ":cancel",
        reqId: params.reqId,
        reason: typeof reason === "string" ? reason : undefined,
        ...params.meta,
      });
      try {
        reader.cancel(reason);
      } catch {
        return;
      }
    },
  });
}
