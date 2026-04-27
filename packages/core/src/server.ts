import Fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  FastifyPluginAsync,
  FastifyPluginCallback,
  FastifyPluginOptions,
  FastifyRegisterOptions,
  preHandlerHookHandler,
  onRequestHookHandler,
  preParsingHookHandler,
  preValidationHookHandler,
  preSerializationHookHandler,
  onSendHookHandler,
  onResponseHookHandler,
  onTimeoutHookHandler,
  onErrorHookHandler,
  onRouteHookHandler,
  onRegisterHookHandler,
  onReadyHookHandler,
  onListenHookHandler,
  onCloseHookHandler,
  FastifyBaseLogger,
  FastifyLoggerOptions,
  FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import { ConfigService, AppConfig } from "./services/config";
import { errorHandler } from "./api/middleware";
import { registerApiRoutes, handleTransformerEndpoint } from "./api/routes";
import { ProviderService } from "./services/provider";
import { TransformerService } from "./services/transformer";
import { TokenizerService } from "./services/tokenizer";
import { router, calculateTokenCount, searchProjectBySession } from "./utils/router";
import { sessionUsageCache } from "./utils/cache";
import { Transformer } from "./types/transformer";

// Extend FastifyRequest to include custom properties
declare module "fastify" {
  interface FastifyRequest {
    provider?: string;
    model?: string;
    scenarioType?: string;
  }
  interface FastifyInstance {
    _server?: Server;
  }
}

/**
 * Listener protocol configuration — determines which transformer endpoints are exposed.
 * - "openai": Exposes /v1/chat/completions and /v1/responses
 * - "anthropic": Exposes /v1/messages
 * - "all": Exposes all transformer endpoints (same as main server)
 */
export type ListenerProtocol = "openai" | "anthropic" | "all";

/**
 * Configuration for an additional listener that exposes a specific protocol on a dedicated port.
 */
export interface ListenerConfig {
  /** Unique name for this listener (used in logging) */
  name: string;
  /** Port number to listen on */
  port: number;
  /** Host to bind to (defaults to "127.0.0.1") */
  host?: string;
  /** Protocol to expose — determines which transformer endpoints are registered */
  protocol: ListenerProtocol;
  /** Optional API key for authentication (if different from main server) */
  apiKey?: string;
}

interface ServerOptions extends FastifyServerOptions {
  initialConfig?: AppConfig;
}

// Application factory
function createApp(options: FastifyServerOptions = {}): FastifyInstance {
  const fastify = Fastify({
    bodyLimit: 50 * 1024 * 1024,
    ...options,
  });

  // Register error handler
  fastify.setErrorHandler(errorHandler);

  // Register CORS
  fastify.register(cors);
  return fastify;
}

// Server class
class Server {
  private app: FastifyInstance;
  configService: ConfigService;
  providerService!: ProviderService;
  transformerService: TransformerService;
  tokenizerService: TokenizerService;
  /** Additional listener Fastify instances keyed by listener name */
  private listenerApps: Map<string, FastifyInstance> = new Map();

  constructor(options: ServerOptions = {}) {
    console.log('Server constructor called');
    const { initialConfig, ...fastifyOptions } = options;
    console.log('Creating Fastify app...');
    this.app = createApp({
      ...fastifyOptions,
      logger: fastifyOptions.logger ?? true,
    });
    console.log('Fastify app created');

    console.log('Creating ConfigService...');
    this.configService = new ConfigService(options);
    console.log('ConfigService created');

    console.log('Creating TransformerService...');
    this.transformerService = new TransformerService(
      this.configService,
      this.app.log
    );
    console.log('TransformerService created');

    console.log('Creating TokenizerService...');
    this.tokenizerService = new TokenizerService(
      this.configService,
      this.app.log
    );
    console.log('TokenizerService created');

    console.log('Initializing TransformerService...');
    this.transformerService.initialize().then(() => {
      console.log('TransformerService initialization completed');
      console.log('Creating ProviderService...');
      this.providerService = new ProviderService(
        this.configService,
        this.transformerService,
        this.app.log
      );
      console.log('ProviderService created');
    }).catch((error) => {
      console.error('Failed to initialize TransformerService:', error);
    });

    console.log('Initializing TokenizerService...');
    // Initialize tokenizer service
    this.tokenizerService.initialize().catch((error) => {
      console.error(`Failed to initialize TokenizerService: ${error}`);
    });
    console.log('TokenizerService initialization started');
  }

  async register<Options extends FastifyPluginOptions = FastifyPluginOptions>(
    plugin: FastifyPluginAsync<Options> | FastifyPluginCallback<Options>,
    options?: FastifyRegisterOptions<Options>
  ): Promise<void> {
    await (this.app as any).register(plugin, options);
  }

  addHook(hookName: "onRequest", hookFunction: onRequestHookHandler): void;
  addHook(hookName: "preParsing", hookFunction: preParsingHookHandler): void;
  addHook(
    hookName: "preValidation",
    hookFunction: preValidationHookHandler
  ): void;
  addHook(hookName: "preHandler", hookFunction: preHandlerHookHandler): void;
  addHook(
    hookName: "preSerialization",
    hookFunction: preSerializationHookHandler
  ): void;
  addHook(hookName: "onSend", hookFunction: onSendHookHandler): void;
  addHook(hookName: "onResponse", hookFunction: onResponseHookHandler): void;
  addHook(hookName: "onTimeout", hookFunction: onTimeoutHookHandler): void;
  addHook(hookName: "onError", hookFunction: onErrorHookHandler): void;
  addHook(hookName: "onRoute", hookFunction: onRouteHookHandler): void;
  addHook(hookName: "onRegister", hookFunction: onRegisterHookHandler): void;
  addHook(hookName: "onReady", hookFunction: onReadyHookHandler): void;
  addHook(hookName: "onListen", hookFunction: onListenHookHandler): void;
  addHook(hookName: "onClose", hookFunction: onCloseHookHandler): void;
  public addHook(hookName: string, hookFunction: any): void {
    this.app.addHook(hookName as any, hookFunction);
  }

  public async registerNamespace(name: string, options?: any) {
    if (!name) throw new Error("name is required");
    if (name === '/') {
      await this.app.register(async (fastify) => {
        fastify.decorate('configService', this.configService);
        fastify.decorate('transformerService', this.transformerService);
        fastify.decorate('providerService', this.providerService);
        fastify.decorate('tokenizerService', this.tokenizerService);
        // Add router hook for main namespace
        fastify.addHook('preHandler', async (req: any, reply: any) => {
          const url = new URL(`http://127.0.0.1${req.url}`);
          if (url.pathname.endsWith("/v1/messages")) {
            // Skip router if model provider middleware already resolved the provider
            if (!req.provider) {
              await router(req, reply, {
                configService: this.configService,
                tokenizerService: this.tokenizerService,
              });
            }
          }
        });
        await registerApiRoutes(fastify);
      });
      return
    }
    if (!options) throw new Error("options is required");
    const configService = new ConfigService({
      initialConfig: {
        providers: options.Providers,
        Router: options.Router,
      }
    });
    const transformerService = new TransformerService(
      configService,
      this.app.log
    );
    await transformerService.initialize();
    const providerService = new ProviderService(
      configService,
      transformerService,
      this.app.log
    );
    const tokenizerService = new TokenizerService(
      configService,
      this.app.log
    );
    await tokenizerService.initialize();
    await this.app.register(async (fastify) => {
      fastify.decorate('configService', configService);
      fastify.decorate('transformerService', transformerService);
      fastify.decorate('providerService', providerService);
      fastify.decorate('tokenizerService', tokenizerService);
      // Add router hook for namespace
      fastify.addHook('preHandler', async (req: any, reply: any) => {
        const url = new URL(`http://127.0.0.1${req.url}`);
        if (url.pathname.endsWith("/v1/messages")) {
          // Skip router if model provider middleware already resolved the provider
          if (!req.provider) {
            await router(req, reply, {
              configService,
              tokenizerService,
            });
          }
        }
      });
      await registerApiRoutes(fastify);
    }, { prefix: name });
  }

  async start(): Promise<void> {
    console.log('Server.start() method ENTERED');
    console.log('Server.start() method entered');

    // Ensure providerService is initialized before proceeding
    if (!this.providerService) {
      console.log('Waiting for providerService to initialize...');
      await new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (this.providerService) {
            clearInterval(checkInterval);
            resolve(void 0);
          }
        }, 100);
      });
      console.log('providerService is now initialized');
    }

    try {
      console.log('Setting app._server = this');
      this.app._server = this;

      console.log('Adding preHandler hook');
      this.app.addHook("preHandler", (req, reply, done) => {
        const url = new URL(`http://127.0.0.1${req.url}`);
        if (url.pathname.endsWith("/v1/messages") && req.body) {
          const body = req.body as any;
          req.log.info({ data: body, type: "request body" });
          if (!body.stream) {
            body.stream = false;
          }
        }
        done();
      });

      console.log('Registering namespace');
      await this.registerNamespace('/')

      console.log('Adding model provider middleware');
      this.app.addHook(
        "preHandler",
        async (req: FastifyRequest, reply: FastifyReply) => {
          const url = new URL(`http://127.0.0.1${req.url}`);
          if ((url.pathname.endsWith("/v1/messages") || url.pathname.endsWith("/v1/chat/completions") || url.pathname.endsWith("/v1/responses")) && req.body) {
            try {
              const body = req.body as any;
              if (!body || !body.model) {
                return reply
                  .code(400)
                  .send({ error: "Missing model in request body" });
              }
              // Apply model migrations (e.g., "gpt-5.4" → "glm-5.1")
              // This allows clients like Codex to use their native model names
              // while the router maps them to the actual available models
              const modelMigrations = this.configService.get<Record<string, string>>("ModelMigrations");
              if (modelMigrations && body.model in modelMigrations) {
                const originalModel = body.model;
                body.model = modelMigrations[body.model];
                req.log.info(`Model migration: "${originalModel}" → "${body.model}"`);
              }

              // If model contains a slash, it's in "provider/model" format
              if (body.model.includes("/")) {
                const [provider, ...model] = body.model.split("/");
                body.model = model.join("/");
                req.provider = provider;
                req.model = model;
              } else {
                // Model without provider prefix — resolve via providerService
                // (e.g., "glm-5.1" → provider "yuanjing", targetModel "zai-org/GLM-5.1-FP8")
                const route = this.providerService?.resolveModelRoute?.(body.model);
                if (route) {
                  req.provider = route.provider.name;
                  // If the resolved target model differs from the requested model (alias case),
                  // rewrite body.model to the actual model name so the provider receives the correct one
                  if (route.targetModel !== body.model) {
                    req.log.info(`Model alias resolved: "${body.model}" → "${route.targetModel}"`);
                    body.model = route.targetModel;
                  }
                  req.model = [route.targetModel];
                } else {
                  // Fallback: use the model name as provider (legacy behavior)
                  req.provider = body.model;
                  req.model = [];
                }
              }
              return;
            } catch (err) {
              req.log.error({error: err}, "Error in modelProviderMiddleware:");
              return reply.code(500).send({ error: "Internal server error" });
            }
          }
        }
      );

      console.log('Server.start() called');
      const port = parseInt(this.configService.get("PORT") || "3000", 10);
      const host = this.configService.get("HOST") || "127.0.0.1";
      console.log(`Attempting to listen on ${host}:${port}`);

      const address = await this.app.listen({
        port: port,
        host: host,
      });

      console.log(`Server successfully listening on ${address}`);

      this.app.log.info(`LLMs API server listening on ${address}`);

      const shutdown = async (signal: string) => {
        this.app.log.info(`Received ${signal}, shutting down gracefully...`);
        await this.stopListeners();
        await this.app.close();
        process.exit(0);
      };

      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    } catch (error) {
      console.error('Detailed server startup error:', error);
      console.error('Error type:', typeof error);
      console.error('Error message:', error instanceof Error ? error.message : String(error));
      console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      this.app.log.error(`Error starting server: ${error}`);
      process.exit(1);
    }
  }

  /**
   * Start additional listener servers based on the "Listeners" config array.
   * Each listener exposes a specific protocol on a dedicated port.
   * This allows clients using different API protocols (OpenAI vs Anthropic)
   * to connect to the appropriate port without protocol conversion on their side.
   */
  async startListeners(): Promise<void> {
    const listeners = this.configService.get<ListenerConfig[]>("Listeners");
    if (!listeners || !Array.isArray(listeners) || listeners.length === 0) {
      return;
    }

    for (const listenerConfig of listeners) {
      try {
        await this._startListener(listenerConfig);
      } catch (error) {
        console.error(`Failed to start listener '${listenerConfig.name}':`, error);
        this.app.log.error(`Failed to start listener '${listenerConfig.name}': ${error}`);
      }
    }
  }

  private async _startListener(config: ListenerConfig): Promise<void> {
    const { name, port, host = "127.0.0.1", protocol } = config;

    if (!name || !port || !protocol) {
      this.app.log.warn(`Skipping invalid listener config: name=${name}, port=${port}, protocol=${protocol}`);
      return;
    }

    const listenerApp = Fastify({
      bodyLimit: 50 * 1024 * 1024,
      logger: true,
    });

    listenerApp.setErrorHandler(errorHandler);
    listenerApp.register(cors);

    // Decorate with shared services so route handlers can access them
    listenerApp.decorate('configService', this.configService);
    listenerApp.decorate('transformerService', this.transformerService);
    listenerApp.decorate('providerService', this.providerService);
    listenerApp.decorate('tokenizerService', this.tokenizerService);

    // Add model provider middleware (same as main server)
    listenerApp.addHook(
      "preHandler",
      async (req: FastifyRequest, reply: FastifyReply) => {
        const url = new URL(`http://127.0.0.1${req.url}`);
        if ((url.pathname.endsWith("/v1/messages") || url.pathname.endsWith("/v1/chat/completions") || url.pathname.endsWith("/v1/responses")) && req.body) {
          try {
            const body = req.body as any;
            if (!body || !body.model) {
              return reply.code(400).send({ error: "Missing model in request body" });
            }
            // Apply model migrations
            const modelMigrations = this.configService.get<Record<string, string>>("ModelMigrations");
            if (modelMigrations && body.model in modelMigrations) {
              const originalModel = body.model;
              body.model = modelMigrations[body.model];
              req.log.info(`Model migration: "${originalModel}" → "${body.model}"`);
            }
            if (body.model.includes("/")) {
              const [provider, ...model] = body.model.split("/");
              body.model = model.join("/");
              req.provider = provider;
              req.model = model;
            } else {
              const route = this.providerService?.resolveModelRoute?.(body.model);
              if (route) {
                req.provider = route.provider.name;
                if (route.targetModel !== body.model) {
                  req.log.info(`Model alias resolved: "${body.model}" → "${route.targetModel}"`);
                  body.model = route.targetModel;
                }
                req.model = [route.targetModel];
              } else {
                req.provider = body.model;
                req.model = [];
              }
            }
          } catch (err) {
            req.log.error({ error: err }, "Error in listener modelProviderMiddleware");
            return reply.code(500).send({ error: "Internal server error" });
          }
        }
      }
    );

    // Add router hook
    listenerApp.addHook('preHandler', async (req: any, reply: any) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      if (url.pathname.endsWith("/v1/messages")) {
        // Skip router if model provider middleware already resolved the provider
        if (!req.provider) {
          await router(req, reply, {
            configService: this.configService,
            tokenizerService: this.tokenizerService,
          });
        }
      }
    });

    // Register routes based on protocol
    this._registerListenerRoutes(listenerApp, protocol);

    // Health and models endpoints (always available)
    listenerApp.get("/", async () => ({
      message: "LLMs API Listener",
      listener: name,
      protocol,
    }));
    listenerApp.get("/health", async () => ({
      status: "ok",
      listener: name,
      protocol,
      timestamp: new Date().toISOString(),
    }));
    listenerApp.get("/v1/models", async () => {
      return await this.providerService.getAvailableModels();
    });

    // Start listening
    const address = await listenerApp.listen({ port, host });
    this.listenerApps.set(name, listenerApp);
    this.app.log.info(`Listener '${name}' (${protocol}) listening on ${address}`);

    // Debug: print registered routes
    const routes = listenerApp.printRoutes();
    this.app.log.info(`Listener '${name}' registered routes: ${routes}`);
  }

  /**
   * Register transformer endpoint routes for a listener based on its protocol.
   */
  private _registerListenerRoutes(fastify: FastifyInstance, protocol: ListenerProtocol): void {
    const transformersWithEndpoint = this.transformerService.getTransformersWithEndpoint();

    this.app.log.info(`Registering listener routes for protocol '${protocol}', found ${transformersWithEndpoint.length} transformers with endpoints`);

    for (const { name, transformer } of transformersWithEndpoint) {
      if (!transformer.endPoint) continue;

      const shouldRegister = this._shouldRegisterEndpoint(transformer.endPoint, protocol);
      this.app.log.info(`  Transformer '${name}' (endPoint: ${transformer.endPoint}) → shouldRegister: ${shouldRegister}`);

      if (!shouldRegister) continue;

      // Register both /v1/... and /v1/v1/... variants (matching main server behavior)
      const handler = async (req: FastifyRequest, reply: FastifyReply) => {
        return this._handleListenerRequest(req, reply, fastify, transformer);
      };

      fastify.post(transformer.endPoint, handler);
      console.log(`[Listener:${protocol}] Registered POST ${transformer.endPoint}`);
      if (transformer.endPoint.startsWith("/v1/")) {
        fastify.post(`/v1${transformer.endPoint}`, handler);
        console.log(`[Listener:${protocol}] Registered POST /v1${transformer.endPoint}`);
      }
    }
  }

  /**
   * Determine whether an endpoint should be registered for a given protocol.
   */
  private _shouldRegisterEndpoint(endPoint: string, protocol: ListenerProtocol): boolean {
    if (protocol === "all") return true;

    const openaiEndpoints = ["/v1/chat/completions", "/v1/responses"];
    const anthropicEndpoints = ["/v1/messages"];

    switch (protocol) {
      case "openai":
        return openaiEndpoints.some(
          (ep) => endPoint === ep || endPoint.startsWith(ep + "/")
        );
      case "anthropic":
        return anthropicEndpoints.some(
          (ep) => endPoint === ep || endPoint.startsWith(ep + "/")
        );
      default:
        return true;
    }
  }

  /**
   * Handle a request on a listener — delegates to the same logic as the main server.
   */
  private async _handleListenerRequest(
    req: FastifyRequest,
    reply: FastifyReply,
    fastify: FastifyInstance,
    transformer: Transformer
  ): Promise<any> {
    return handleTransformerEndpoint(req, reply, fastify, transformer);
  }

  /**
   * Stop all listener servers gracefully.
   */
  async stopListeners(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [name, listenerApp] of this.listenerApps) {
      this.app.log.info(`Stopping listener '${name}'...`);
      closePromises.push(listenerApp.close());
    }
    await Promise.all(closePromises);
    this.listenerApps.clear();
  }
}

// Export for external use
export default Server;
export { sessionUsageCache };
export { router };
export { calculateTokenCount };
export { searchProjectBySession };
export type { RouterScenarioType, RouterFallbackConfig } from "./utils/router";
export { ConfigService } from "./services/config";
export { ProviderService } from "./services/provider";
export { TransformerService } from "./services/transformer";
export { TokenizerService } from "./services/tokenizer";
export { pluginManager, tokenSpeedPlugin, getTokenSpeedStats, getGlobalTokenSpeedStats, CCRPlugin, CCRPluginOptions, PluginMetadata } from "./plugins";
export { SSEParserTransform, SSESerializerTransform, rewriteStream } from "./utils/sse";
