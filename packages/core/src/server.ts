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
import { registerApiRoutes } from "./api/routes";
import { ProviderService } from "./services/provider";
import { TransformerService } from "./services/transformer";
import { TokenizerService } from "./services/tokenizer";
import { router, calculateTokenCount, searchProjectBySession } from "./utils/router";
import { sessionUsageCache } from "./utils/cache";

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
            await router(req, reply, {
              configService: this.configService,
              tokenizerService: this.tokenizerService,
            });
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
          await router(req, reply, {
            configService,
            tokenizerService,
          });
        }
      });
      await registerApiRoutes(fastify);
    }, { prefix: name });
  }

  async start(): Promise<void> {
    console.log('🚀 Server.start() method ENTERED');
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
              // If model contains a comma, it's in "provider,model" format
              if (body.model.includes(",")) {
                const [provider, ...model] = body.model.split(",");
                body.model = model.join(",");
                req.provider = provider;
                req.model = model;
              } else {
                // Model without provider prefix — resolve via providerService
                // (e.g., "glm-5.1" → provider "yuanjing", model "glm-5.1")
                const route = this.providerService?.resolveModelRoute?.(body.model);
                if (route) {
                  req.provider = route.provider.name;
                  // Don't change body.model — the model name stays as-is
                  // (the transformer will handle stripping the provider prefix)
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

      this.app.log.info(`🚀 LLMs API server listening on ${address}`);

      const shutdown = async (signal: string) => {
        this.app.log.info(`Received ${signal}, shutting down gracefully...`);
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
