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
      requestUrl: typeof url === "string" ? url : url.toString(),
      useProxy: config.httpsProxy,
    },
    "final request"
  );

  return fetch(typeof url === "string" ? url : url.toString(), fetchOptions).then(
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
