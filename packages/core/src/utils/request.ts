import { ProxyAgent } from "undici";
import { UnifiedChatRequest } from "../types/llm";
import { redactHeaders, traceLog, traceStream } from "./trace-logger";
import { createHash } from "node:crypto";

let lastRequestBodySha256: string | null = null;
let lastRequestBodySha256AtMs = 0;

export function sendUnifiedRequest(
  url: URL | string,
  request: UnifiedChatRequest,
  config: any,
  context: any,
  logger?: any
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (config.headers) {
    Object.entries(config.headers).forEach(([key, value]) => {
      if (value) {
        headers.set(key, value as string);
      }
    });
  }
  let combinedSignal: AbortSignal;
  const timeoutSignal = AbortSignal.timeout(config.TIMEOUT ?? 60 * 1000 * 60);

  if (config.signal) {
    const controller = new AbortController();
    const abortHandler = () => controller.abort();
    config.signal.addEventListener("abort", abortHandler);
    timeoutSignal.addEventListener("abort", abortHandler);
    combinedSignal = controller.signal;
  } else {
    combinedSignal = timeoutSignal;
  }

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: headers,
    body: JSON.stringify(request),
    signal: combinedSignal,
  };

  const headerObject: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerObject[key] = value;
  });

  traceLog({
    phase: "upstream_request",
    reqId: context?.req?.id,
    requestUrl: typeof url === "string" ? url : url.toString(),
    method: fetchOptions.method,
    headers: redactHeaders(headerObject),
    body: request,
    useProxy: config.httpsProxy,
  });

  if (config.httpsProxy) {
    (fetchOptions as any).dispatcher = new ProxyAgent(
      new URL(config.httpsProxy).toString()
    );
  }

  const bodyStr = typeof fetchOptions.body === "string" ? fetchOptions.body : "";
  const bodyByteLength = Buffer.byteLength(bodyStr, "utf8");
  const bodySha256 = createHash("sha256").update(bodyStr).digest("hex");
  const nowMs = Date.now();
  const possible_retry =
    lastRequestBodySha256 === bodySha256 && nowMs - lastRequestBodySha256AtMs <= 5_000;
  lastRequestBodySha256 = bodySha256;
  lastRequestBodySha256AtMs = nowMs;

  const retryMax = Number.parseInt(process.env.CCR_UPSTREAM_RETRY_MAX || "2", 10);
  const retryTotalMs = Number.parseInt(process.env.CCR_UPSTREAM_RETRY_TOTAL_MS || "5000", 10);
  const retryBaseMs = Number.parseInt(process.env.CCR_UPSTREAM_RETRY_BASE_MS || "300", 10);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const shouldRetryStatus = (status: number) => status === 502 || status === 503 || status === 504;

  const shouldRetryResponse = (response: Response) => {
    const ct = response.headers.get("Content-Type") || "";
    // Never retry once the upstream is a stream. Retrying would duplicate side effects
    // and is not safe after the body starts.
    if (ct.includes("text/event-stream")) return false;
    return shouldRetryStatus(response.status);
  };

  logger?.debug(
    {
      reqId: context.req.id,
      request: fetchOptions,
      headers: headerObject,
      bodyByteLength,
      bodySha256,
      retryHint: {
        possible_retry,
        windowMs: 5_000,
      },
      retryAttempt: 0,
      retryMax,
      requestUrl: typeof url === "string" ? url : url.toString(),
      useProxy: config.httpsProxy,
    },
    "final request"
  );

  const fetchWithRetries = async () => {
    const requestUrl = typeof url === "string" ? url : url.toString();
    const startMs = Date.now();

    for (let attempt = 0; attempt <= retryMax; attempt++) {
      try {
        const response = await fetch(requestUrl, fetchOptions);

        if (attempt < retryMax && shouldRetryResponse(response)) {
          logger?.warn?.(
            {
              reqId: context.req.id,
              bodySha256,
              retryAttempt: attempt + 1,
              retryMax,
              status: response.status,
              requestUrl,
            },
            "upstream_retry"
          );
          const elapsed = Date.now() - startMs;
          const delay = Math.min(retryBaseMs * Math.pow(2, attempt), 2_000);
          if (elapsed + delay > retryTotalMs) {
            return response;
          }

          // Drain/close body quickly to free resources before retry
          // IMPORTANT: only do this if we are actually going to retry.
          try {
            response.body?.cancel();
          } catch {}

          await sleep(delay);
          continue;
        }

        return response;
      } catch (error) {
        if (attempt < retryMax) {
          logger?.warn?.(
            {
              reqId: context.req.id,
              bodySha256,
              retryAttempt: attempt + 1,
              retryMax,
              retryTotalMs,
              retryBaseMs,
              error: error instanceof Error ? error.message : String(error),
              requestUrl,
            },
            "upstream_retry"
          );
          const elapsed = Date.now() - startMs;
          const delay = Math.min(retryBaseMs * Math.pow(2, attempt), 2_000);
          if (elapsed + delay > retryTotalMs) {
            throw error;
          }
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }

    // unreachable
    return fetch(requestUrl, fetchOptions);
  };

  return fetchWithRetries().then(
    async (response) => {
      try {
        traceLog({
          phase: "upstream_response_headers",
          reqId: context?.req?.id,
          requestUrl: typeof url === "string" ? url : url.toString(),
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get("Content-Type"),
        });

        const ct = response.headers.get("Content-Type") || "";
        if (ct.includes("text/event-stream") && response.body) {
          const wrapped = await traceStream({
            reqId: context?.req?.id,
            stream: response.body as any,
            phase: "upstream_sse",
            meta: {
              requestUrl: typeof url === "string" ? url : url.toString(),
              status: response.status,
            },
          });
          return new Response(wrapped as any, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }

        if (ct.includes("application/json")) {
          try {
            const cloned = response.clone();
            void cloned.text().then((text) => {
              traceLog({
                phase: "upstream_response_body",
                reqId: context?.req?.id,
                requestUrl: typeof url === "string" ? url : url.toString(),
                status: response.status,
                contentType: ct,
                bodyText: text,
              });
            });
          } catch {
            traceLog({
              phase: "upstream_response_clone_failed",
              reqId: context?.req?.id,
              requestUrl: typeof url === "string" ? url : url.toString(),
            });
          }
        }
      } catch {
        traceLog({
          phase: "upstream_trace_failed",
          reqId: context?.req?.id,
        });
      }

      return response;
    }
  );
}
