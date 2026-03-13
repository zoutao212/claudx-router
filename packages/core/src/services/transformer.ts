import { Transformer, TransformerConstructor } from "@/types/transformer";
import { ConfigService } from "./config";
import Transformers from "@/transformer";
import Module from "node:module";

interface TransformerConfig {
  transformers: Array<{
    name: string;
    type: "class" | "module";
    path?: string;
    options?: any;
  }>;
}

export class TransformerService {
  private transformers: Map<string, Transformer | TransformerConstructor> =
    new Map();
  private logBuffer: string[] = [];
  private logBufferLength = 0;
  private readonly MIN_LOG_LENGTH = 200;
  private readonly MAX_LOG_LENGTH = 300;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: any
  ) {}

  registerTransformer(name: string, transformer: Transformer): void {
    this.transformers.set(name, transformer);
    this.bufferLogMessage(
      `register transformer: ${name}${
        transformer.endPoint
          ? ` (endpoint: ${transformer.endPoint})`
          : " (no endpoint)"
      }`
    );
  }

  private bufferLogMessage(message: string): void {
    this.logBuffer.push(message);
    this.logBufferLength += message.length;

    // Check if buffer should be flushed
    if (this.logBufferLength >= this.MIN_LOG_LENGTH) {
      this.flushLogBuffer();
    }
  }

  private flushLogBuffer(): void {
    if (this.logBuffer.length > 0) {
      this.logger.info(this.logBuffer.join('\n'));
      this.logBuffer = [];
      this.logBufferLength = 0;
    }
  }

  // Call this method when service is shutting down or when you want to force flush remaining logs
  forceFlushLogs(): void {
    this.flushLogBuffer();
  }

  getTransformer(
    name: string
  ): Transformer | TransformerConstructor | undefined {
    return this.transformers.get(name);
  }

  getAllTransformers(): Map<string, Transformer | TransformerConstructor> {
    return new Map(this.transformers);
  }

  getTransformersWithEndpoint(): { name: string; transformer: Transformer }[] {
    const result: { name: string; transformer: Transformer }[] = [];

    this.transformers.forEach((transformer, name) => {
      // Check if it's an instance with endPoint
      if (typeof transformer === 'object' && transformer.endPoint) {
        result.push({ name, transformer });
      }
    });

    return result;
  }

  getTransformersWithoutEndpoint(): {
    name: string;
    transformer: Transformer;
  }[] {
    const result: { name: string; transformer: Transformer }[] = [];

    this.transformers.forEach((transformer, name) => {
      // Check if it's an instance without endPoint
      if (typeof transformer === 'object' && !transformer.endPoint) {
        result.push({ name, transformer });
      }
    });

    return result;
  }

  removeTransformer(name: string): boolean {
    return this.transformers.delete(name);
  }

  hasTransformer(name: string): boolean {
    return this.transformers.has(name);
  }

  async registerTransformerFromConfig(config: {
    path?: string;
    options?: any;
  }): Promise<boolean> {
    try {
      if (config.path) {
        const module = require(require.resolve(config.path));
        if (module) {
          const instance = new module(config.options);
          // Set logger for transformer instance
          if (instance && typeof instance === "object") {
            (instance as any).logger = this.logger;
          }
          if (!instance.name) {
            throw new Error(
              `Transformer instance from ${config.path} does not have a name property.`
            );
          }
          this.registerTransformer(instance.name, instance);
          return true;
        }
      }
      return false;
    } catch (error: any) {
      this.logger.error(
        `load transformer (${config.path}) \nerror: ${error.message}\nstack: ${error.stack}`
      );
      return false;
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.registerDefaultTransformersInternal();
      await this.loadFromConfig();
      // Force flush any remaining log messages
      this.forceFlushLogs();
    } catch (error: any) {
      this.logger.error(
        `TransformerService init error: ${error.message}\nStack: ${error.stack}`
      );
    }
  }

  private async registerDefaultTransformersInternal(): Promise<void> {
    try {
      Object.values(Transformers).forEach(
        (TransformerStatic: any) => {
          if (
            "TransformerName" in TransformerStatic &&
            typeof TransformerStatic.TransformerName === "string"
          ) {
            this.registerTransformer(
              TransformerStatic.TransformerName,
              TransformerStatic
            );
          } else {
            const transformerInstance = new TransformerStatic();
            // Set logger for transformer instance
            if (
              transformerInstance &&
              typeof transformerInstance === "object"
            ) {
              (transformerInstance as any).logger = this.logger;
            }
            this.registerTransformer(
              transformerInstance.name!,
              transformerInstance
            );
          }
        }
      );
    } catch (error) {
      this.logger.error({ error }, "transformer regist error:");
    }
  }

  private async loadFromConfig(): Promise<void> {
    const transformers = this.configService.get<
      TransformerConfig["transformers"]
    >("transformers", []);
    for (const transformer of transformers) {
      await this.registerTransformerFromConfig(transformer);
    }
  }
}
