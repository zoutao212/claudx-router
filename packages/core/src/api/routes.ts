import {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { RegisterProviderRequest, LLMProvider } from "@/types/llm";
import { sendUnifiedRequest } from "@/utils/request";
import { redactHeaders, traceLog, traceStream, traceInit } from "@/utils/trace-logger";
import { createApiError } from "./middleware";
import { version } from "../../package.json";
import { ConfigService } from "@/services/config";
import { ProviderService } from "@/services/provider";
import { TransformerService } from "@/services/transformer";

import { Transformer } from "@/types/transformer";

// Extend FastifyInstance to include custom services
declare module "fastify" {
  interface FastifyInstance {
    configService: ConfigService;
    providerService: ProviderService;
    transformerService: TransformerService;
  }

  interface FastifyRequest {
    provider?: string;
  }
}

/**
 * Main handler for transformer endpoints
 * Coordinates the entire request processing flow: validate provider, handle request transformers,
 * send request, handle response transformers, format response
 */
export async function handleTransformerEndpoint(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any
) {
  const body = req.body as any;
  const providerName = req.provider!;
  const provider = fastify.providerService.getProvider(providerName);

  traceLog({
    phase: "inbound_request",
    reqId: (req as any).id,
    method: (req as any).method,
    url: req.url,
    provider: providerName,
    model: body?.model,
    headers: redactHeaders(req.headers as any),
    body,
  });

  // Validate provider exists
  if (!provider) {
    throw createApiError(
      `Provider '${providerName}' not found`,
      404,
      "provider_not_found"
    );
  }

  // Acquire concurrency slot for this provider
  const release = await fastify.providerService.semaphore.acquire(providerName);

  try {
    if (req.url.includes("/v1/v1/")) {
      req.log.warn(
        {
          url: req.url,
          endpoint: transformer.endPoint,
          provider: providerName,
        },
        "duplicate_v1_prefix_detected"
      );
    }

    // Process request transformer chain
    const { requestBody, config, bypass } = await processRequestTransformers(
      body,
      provider,
      transformer,
      req.headers,
      {
        req,
      }
    );

    // Send request to LLM provider
    const response = await sendRequestToProvider(
      requestBody,
      config,
      provider,
      fastify,
      bypass,
      transformer,
      {
        req,
      }
    );

    traceLog({
      phase: "provider_response_headers",
      reqId: (req as any).id,
      provider: providerName,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers?.get?.("Content-Type"),
    });

    // Process response transformer chain
    const finalResponse = await processResponseTransformers(
      requestBody,
      response,
      provider,
      transformer,
      bypass,
      {
        req,
      }
    );

    traceLog({
      phase: "outbound_response_headers",
      reqId: (req as any).id,
      provider: providerName,
      status: finalResponse.status,
      statusText: finalResponse.statusText,
      contentType: finalResponse.headers?.get?.("Content-Type"),
    });

    // Format and return response
    return formatResponse(finalResponse, reply, body, release);
  } catch (error: any) {
    // Handle fallback if error occurs
    if (error.code === 'provider_response_error') {
      const fallbackResult = await handleFallback(req, reply, fastify, transformer, error);
      if (fallbackResult) {
        // Fallback succeeded — release original provider's slot
        // (fallback already released its own slot via finally in handleFallback)
        release();
        return fallbackResult;
      }
    }
    throw error;
  } finally {
    // Release concurrency slot only for non-stream responses or errors.
    // For streaming responses, release is handled after stream ends in formatResponse.
    // We check if release was already consumed by formatResponse or fallback path.
    // This is safe because release() is idempotent.
    release();
  }
}

/**
 * Handle fallback logic when request fails
 * Tries each fallback model in sequence until one succeeds
 */
async function handleFallback(
  req: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  transformer: any,
  error: any
): Promise<any> {
  const scenarioType = (req as any).scenarioType || 'default';
  const fallbackConfig = fastify.configService.get<any>('fallback');

  if (!fallbackConfig || !fallbackConfig[scenarioType]) {
    return null;
  }

  const fallbackList = fallbackConfig[scenarioType] as string[];
  if (!Array.isArray(fallbackList) || fallbackList.length === 0) {
    return null;
  }

  req.log.warn(`Request failed for ${(req as any).scenarioType}, trying ${fallbackList.length} fallback models`);

  // Try each fallback model in sequence
  for (const fallbackModel of fallbackList) {
    let fallbackRelease: (() => void) | null = null;
    try {
      req.log.info(`Trying fallback model: ${fallbackModel}`);

      // Update request with fallback model
      const newBody = { ...(req.body as any) };
      const [fallbackProvider, ...fallbackModelName] = fallbackModel.split('/');
      newBody.model = fallbackModelName.join('/');

      // Create new request object with updated provider and body
      const newReq = {
        ...req,
        provider: fallbackProvider,
        body: newBody,
      };

      const provider = fastify.providerService.getProvider(fallbackProvider);
      if (!provider) {
        req.log.warn(`Fallback provider '${fallbackProvider}' not found, skipping`);
        continue;
      }

      // Acquire concurrency slot for fallback provider
      fallbackRelease = await fastify.providerService.semaphore.acquire(fallbackProvider);

      // Process request transformer chain
      const { requestBody, config, bypass } = await processRequestTransformers(
        newBody,
        provider,
        transformer,
        req.headers,
        { req: newReq }
      );

      // Send request to LLM provider
      const response = await sendRequestToProvider(
        requestBody,
        config,
        provider,
        fastify,
        bypass,
        transformer,
        { req: newReq }
      );

      // Process response transformer chain
      const finalResponse = await processResponseTransformers(
        requestBody,
        response,
        provider,
        transformer,
        bypass,
        { req: newReq }
      );

      req.log.info(`Fallback model ${fallbackModel} succeeded`);

      // Format and return response
      return formatResponse(finalResponse, reply, newBody);
    } catch (fallbackError: any) {
      req.log.warn(`Fallback model ${fallbackModel} failed: ${fallbackError.message}`);
      continue;
    } finally {
      // Release fallback provider's concurrency slot
      fallbackRelease?.();
    }
  }

  req.log.error(`All fallback models failed for yichu ${scenarioType}`);
  return null;
}

/**
 * Process request transformer chain
 * Sequentially execute transformRequestOut, provider transformers, model-specific transformers
 * Returns processed request body, config, and flag indicating whether to skip transformers
 */
async function processRequestTransformers(
  body: any,
  provider: any,
  transformer: any,
  headers: any,
  context: any
) {
  let requestBody = body;
  let config: any = {};
  let bypass = false;

  // Check if transformers should be bypassed (passthrough mode)
  bypass = shouldBypassTransformers(provider, transformer, body);

  if (bypass) {
    // Clean up headers that should not be forwarded to downstream providers
    const headersToClean = ["content-length", "host", "x-api-key", "connection", "transfer-encoding"];
    if (headers instanceof Headers) {
      for (const h of headersToClean) {
        headers.delete(h);
      }
    } else if (headers && typeof headers === "object") {
      for (const h of headersToClean) {
        delete headers[h];
      }
    }
    config.headers = headers;
  }

  // Execute transformer's transformRequestOut method
  if (!bypass && typeof transformer.transformRequestOut === "function") {
    const transformOut = await transformer.transformRequestOut(requestBody);
    if (transformOut.body) {
      requestBody = transformOut.body;
      config = transformOut.config || {};
    } else {
      requestBody = transformOut;
    }
  }

  // Execute provider-level transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of provider.transformer.use) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      const transformIn = await providerTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
      if (transformIn.body) {
        requestBody = transformIn.body;
        config = { ...config, ...transformIn.config };
      } else {
        requestBody = transformIn;
      }
    }
  }

  // Execute model-specific transformers
  if (!bypass && provider.transformer?.[body.model]?.use?.length) {
    for (const modelTransformer of provider.transformer[body.model].use) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformRequestIn !== "function"
      ) {
        continue;
      }
      requestBody = await modelTransformer.transformRequestIn(
        requestBody,
        provider,
        context
      );
    }
  }

  return { requestBody, config, bypass };
}

/**
 * Determine if transformers should be bypassed (passthrough mode)
 * Skip other transformers when provider only uses one transformer and it matches the current one
 */
function shouldBypassTransformers(
  provider: any,
  transformer: any,
  body: any
): boolean {
  // Never bypass when the request is in Responses API format (from Codex CLI).
  // These requests need transformRequestOut to convert Responses API → Chat Completions,
  // and transformRequestIn to rewrite the URL to /chat/completions.
  if (body.input && !body.messages) {
    return false;
  }
  return (
    provider.transformer?.use?.length === 1 &&
    provider.transformer.use[0].name === transformer.name &&
    (!provider.transformer?.[body.model]?.use.length ||
      (provider.transformer?.[body.model]?.use.length === 1 &&
        provider.transformer?.[body.model]?.use[0].name === transformer.name))
  );
}

/**
 * Send request to LLM provider
 * Handle authentication, build request config, send request and handle errors
 */
async function sendRequestToProvider(
  requestBody: any,
  config: any,
  provider: any,
  fastify: FastifyInstance,
  bypass: boolean,
  transformer: any,
  context: any
) {
  // Handle authentication in passthrough mode
  if (bypass && typeof transformer.auth === "function") {
    const auth = await transformer.auth(requestBody, provider);
    if (auth.body) {
      requestBody = auth.body;
      let headers = config.headers || {};
      if (auth.config?.headers) {
        headers = {
          ...headers,
          ...auth.config.headers,
        };
        delete headers.host;
        delete auth.config.headers;
      }
      config = {
        ...config,
        ...auth.config,
        headers,
      };
    } else {
      requestBody = auth;
    }
  }

  // Resolve URL after auth processing so that auth can override the URL
  const url = config.url || new URL(provider.baseUrl);

  // Send HTTP request
  // Prepare headers
  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${provider.apiKey}`,
    ...(config?.headers || {}),
  };

  for (const key in requestHeaders) {
    if (requestHeaders[key] === "undefined") {
      delete requestHeaders[key];
    } else if (
      ["authorization", "Authorization"].includes(key) &&
      requestHeaders[key]?.includes("undefined")
    ) {
      delete requestHeaders[key];
    }
  }

  const response = await sendUnifiedRequest(
    url,
    requestBody,
    {
      httpsProxy: fastify.configService.getHttpsProxy(),
      ...config,
      headers: JSON.parse(JSON.stringify(requestHeaders)),
    },
    context,
    fastify.log
  );

  // Handle request errors
  if (!response.ok) {
    const errorText = await response.text();
    fastify.log.error(
      `[provider_response_error] Error from provider(${provider.name}/${requestBody.model}: ${response.status}): ${errorText}`,
    );
    throw createApiError(
      `Error from provider(${provider.name}/${requestBody.model}: ${response.status}): ${errorText}`,
      response.status,
      "provider_response_error"
    );
  }

  return response;
}

/**
 * Process response transformer chain
 * Sequentially execute provider transformers, model-specific transformers, transformer's transformResponseIn
 */
async function processResponseTransformers(
  requestBody: any,
  response: any,
  provider: any,
  transformer: any,
  bypass: boolean,
  context: any
) {
  let finalResponse = response;

  // Execute provider-level response transformers
  if (!bypass && provider.transformer?.use?.length) {
    for (const providerTransformer of Array.from(
      provider.transformer.use
    ).reverse() as Transformer[]) {
      if (
        !providerTransformer ||
        typeof providerTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await providerTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute model-specific response transformers
  if (!bypass && provider.transformer?.[requestBody.model]?.use?.length) {
    for (const modelTransformer of Array.from(
      provider.transformer[requestBody.model].use
    ).reverse() as Transformer[]) {
      if (
        !modelTransformer ||
        typeof modelTransformer.transformResponseOut !== "function"
      ) {
        continue;
      }
      finalResponse = await modelTransformer.transformResponseOut!(
        finalResponse,
        context
      );
    }
  }

  // Execute transformer's transformResponseIn method
  if (!bypass && transformer.transformResponseIn) {
    finalResponse = await transformer.transformResponseIn(
      finalResponse,
      context
    );
  }

  return finalResponse;
}

/**
 * Format and return response
 * Handle HTTP status codes, format streaming and regular responses
 * For streaming responses, the release function is called when the stream ends
 * to properly respect provider concurrency limits.
 */
function formatResponse(response: any, reply: FastifyReply, body: any, release?: () => void) {
  // Set HTTP status code
  if (!response.ok) {
    reply.code(response.status);
  }

  // Handle streaming response
  const isStream = body.stream === true;
  if (isStream) {
    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");
    if (response.body) {
      const traced = traceStream({
        reqId: (reply.request as any).id,
        stream: response.body,
        phase: "sse_to_client",
        meta: {
          url: (reply.request as any).url,
        },
      });

      // Wrap the stream to release the semaphore when the stream ends
      if (release) {
        const originalStream = traced as any;
        const wrappedStream = wrapStreamWithRelease(originalStream, release);
        return reply.send(wrappedStream as any);
      }

      return reply.send(traced as any);
    }

    if (release) {
      const originalStream = response.body as any;
      const wrappedStream = wrapStreamWithRelease(originalStream, release);
      return reply.send(wrappedStream as any);
    }

    return reply.send(response.body);
  } else {
    // Handle regular JSON response — release immediately since response is complete
    try {
      const cloned = response.clone();
      void cloned.text().then((text: string) => {
        traceLog({
          phase: "json_to_client",
          reqId: (reply.request as any).id,
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers?.get?.("Content-Type"),
          bodyText: text,
        });
      });
    } catch {
      traceLog({
        phase: "json_to_client_clone_failed",
        reqId: (reply.request as any).id,
      });
    }
    return response.json();
  }
}

/**
 * Wrap a stream so that the release function is called
 * when the stream finishes (either normally or on error).
 * Handles both Web ReadableStream and Node.js Readable streams.
 */
function wrapStreamWithRelease(stream: any, release: () => void): any {
  let released = false;
  const safeRelease = () => {
    if (!released) {
      released = true;
      release();
    }
  };

  // Web ReadableStream (has getReader method)
  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();
    return new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            safeRelease();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
          safeRelease();
        }
      },
      cancel() {
        reader.cancel();
        safeRelease();
      },
    });
  }

  // Node.js Readable stream (has on/pipe methods, no getReader)
  if (typeof stream.on === "function") {
    stream.on("end", safeRelease);
    stream.on("error", safeRelease);
    stream.on("close", safeRelease);
    return stream;
  }

  // Unknown stream type — just release immediately after a short delay
  safeRelease();
  return stream;
}

export const registerApiRoutes = async (
  fastify: FastifyInstance
) => {
  // Emit a trace init line to verify logging works at startup
  traceInit();

  const registerV1CompatibleGet = (
    path: string,
    handler: (request: FastifyRequest, reply: FastifyReply) => any
  ) => {
    fastify.get(path, handler);
    if (path.startsWith("/v1/")) {
      fastify.get(`/v1${path}`, handler);
    }
  };

  const registerV1CompatiblePost = (
    path: string,
    handler: (request: FastifyRequest, reply: FastifyReply) => any
  ) => {
    fastify.post(path, handler);
    if (path.startsWith("/v1/")) {
      fastify.post(`/v1${path}`, handler);
    }
  };

  // Add /v1/models endpoint for Claude Code model discovery
  registerV1CompatibleGet(
    "/v1/models",
    async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      if (request.url.includes("/v1/v1/")) {
        request.log.warn(
          { url: request.url },
          "duplicate_v1_prefix_detected_for_models"
        );
      }
      return await fastify.providerService.getAvailableModels();
    } catch (error) {
      fastify.log.error({ err: error }, "Error in /v1/models");
      throw createApiError("Failed to get models", 500, "models_error");
    }
    }
  );

  // Health and info endpoints
  fastify.get("/", async () => {
    return { message: "LLMs API", version };
  });

  fastify.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Concurrency status endpoint — shows per-provider concurrency stats
  fastify.get("/v1/concurrency", async () => {
    const providers = fastify.providerService.getProviders();
    const stats: Record<string, { active: number; queued: number; limit: number | undefined }> = {};
    for (const provider of providers) {
      stats[provider.name] = fastify.providerService.semaphore.getStats(provider.name);
    }
    return { timestamp: new Date().toISOString(), providers: stats };
  });

  const transformersWithEndpoint =
    fastify.transformerService.getTransformersWithEndpoint();

  for (const { transformer } of transformersWithEndpoint) {
    if (transformer.endPoint) {
      registerV1CompatiblePost(
        transformer.endPoint,
        async (req: FastifyRequest, reply: FastifyReply) => {
          return handleTransformerEndpoint(req, reply, fastify, transformer);
        }
      );
    }
  }

  fastify.post(
    "/providers",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array" },
          },
          required: ["id", "name", "type", "baseUrl", "apiKey", "models"],
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: RegisterProviderRequest }>,
      reply: FastifyReply
    ) => {
      // Validation
      const { name, baseUrl, apiKey, models } = request.body;

      if (!name?.trim()) {
        throw createApiError(
          "Provider name is required",
          400,
          "invalid_request"
        );
      }

      if (!baseUrl || !isValidUrl(baseUrl)) {
        throw createApiError(
          "Valid base URL is required",
          400,
          "invalid_request"
        );
      }

      if (!apiKey?.trim()) {
        throw createApiError("API key is required", 400, "invalid_request");
      }

      if (!models || !Array.isArray(models) || models.length === 0) {
        throw createApiError(
          "At least one model is required",
          400,
          "invalid_request"
        );
      }

      // Check if provider already exists
      if (fastify.providerService.getProvider(request.body.name)) {
        throw createApiError(
          `Provider with name '${request.body.name}' already exists`,
          400,
          "provider_exists"
        );
      }

      return fastify.providerService.registerProvider(request.body);
    }
  );

  fastify.get("/providers", async () => {
    return fastify.providerService.getProviders();
  });

  fastify.get(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const provider = fastify.providerService.getProvider(
        request.params.id
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.put(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["openai", "anthropic"] },
            baseUrl: { type: "string" },
            apiKey: { type: "string" },
            models: { type: "array", items: { type: "string" } },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: Partial<LLMProvider>;
      }>,
      reply
    ) => {
      const provider = fastify.providerService.updateProvider(
        request.params.id,
        request.body
      );
      if (!provider) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return provider;
    }
  );

  fastify.delete(
    "/providers/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const success = fastify.providerService.deleteProvider(
        request.params.id
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return { message: "Provider deleted successfully" };
    }
  );

  fastify.patch(
    "/providers/:id/toggle",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { enabled: boolean };
      }>,
      reply
    ) => {
      const success = fastify.providerService.toggleProvider(
        request.params.id,
        request.body.enabled
      );
      if (!success) {
        throw createApiError("Provider not found", 404, "provider_not_found");
      }
      return {
        message: `Provider ${
          request.body.enabled ? "enabled" : "disabled"
        } successfully`,
      };
    }
  );
};

// Helper function
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
