import { TransformerConstructor } from "@/types/transformer";
import {
  LLMProvider,
  RegisterProviderRequest,
  ModelRoute,
  RequestRouteInfo,
  ConfigProvider,
  ModelEntry,
  ModelAlias,
} from "../types/llm";
import { ConfigService } from "./config"; 
import { TransformerService } from "./transformer";
import { ProviderSemaphore } from "../utils/semaphore";

/**
 * Normalize a ModelEntry to always return the actual model name string.
 * - If it's a plain string, return it as-is.
 * - If it's a ModelAlias object, return its .name field.
 */
function normalizeModelName(entry: ModelEntry): string {
  return typeof entry === "string" ? entry : entry.name;
}

/**
 * Extract aliases from a ModelEntry.
 * - Plain string: no aliases.
 * - ModelAlias object: returns the alias array (always string[]).
 */
function extractAliases(entry: ModelEntry): string[] {
  if (typeof entry === "string") return [];
  const alias = (entry as ModelAlias).alias;
  if (!alias) return [];
  return Array.isArray(alias) ? alias : [alias];
}

export class ProviderService {
  private providers: Map<string, LLMProvider> = new Map();
  private modelRoutes: Map<string, ModelRoute> = new Map();
  readonly semaphore: ProviderSemaphore;

  constructor(private readonly configService: ConfigService, private readonly transformerService: TransformerService, private readonly logger: any) {
    this.semaphore = new ProviderSemaphore(logger);
    this.initializeCustomProviders();
  }

  private initializeCustomProviders() {
    const providersConfig =
      this.configService.get<ConfigProvider[]>("providers");
    if (providersConfig && Array.isArray(providersConfig)) {
      this.initializeFromProvidersArray(providersConfig);
      return;
    }
  }

  private initializeFromProvidersArray(providersConfig: ConfigProvider[]) {
    providersConfig.forEach((providerConfig: ConfigProvider) => {
      try {
        const normalizedProviderConfig = this.normalizeProviderConfig(
          providerConfig as ConfigProvider & { api?: string }
        );

        if (
          !normalizedProviderConfig.name ||
          !normalizedProviderConfig.api_base_url ||
          !normalizedProviderConfig.api_key
        ) {
          return;
        }

        const transformer: LLMProvider["transformer"] = {}

        if (normalizedProviderConfig.transformer) {
          Object.keys(normalizedProviderConfig.transformer).forEach(key => {
            if (key === 'use') {
              if (Array.isArray(normalizedProviderConfig.transformer.use)) {
                transformer.use = normalizedProviderConfig.transformer.use.map((transformer) => {
                  if (Array.isArray(transformer) && typeof transformer[0] === 'string') {
                    const Constructor = this.transformerService.getTransformer(transformer[0]);
                    if (Constructor) {
                      return new (Constructor as TransformerConstructor)(transformer[1]);
                    }
                  }
                  if (typeof transformer === 'string') {
                    const transformerInstance = this.transformerService.getTransformer(transformer);
                    if (typeof transformerInstance === 'function') {
                      return new transformerInstance();
                    }
                    return transformerInstance;
                  }
                }).filter((transformer) => typeof transformer !== 'undefined');
              }
            } else {
              if (Array.isArray(normalizedProviderConfig.transformer[key]?.use)) {
                transformer[key] = {
                  use: normalizedProviderConfig.transformer[key].use.map((transformer) => {
                    if (Array.isArray(transformer) && typeof transformer[0] === 'string') {
                      const Constructor = this.transformerService.getTransformer(transformer[0]);
                      if (Constructor) {
                        return new (Constructor as TransformerConstructor)(transformer[1]);
                      }
                    }
                    if (typeof transformer === 'string') {
                      const transformerInstance = this.transformerService.getTransformer(transformer);
                      if (typeof transformerInstance === 'function') {
                        return new transformerInstance();
                      }
                      return transformerInstance;
                    }
                  }).filter((transformer) => typeof transformer !== 'undefined')
                }
              }
            }
          })
        }

        this.registerProvider({
          name: normalizedProviderConfig.name,
          baseUrl: normalizedProviderConfig.api_base_url,
          apiKey: normalizedProviderConfig.api_key,
          models: normalizedProviderConfig.models || [],
          maxConcurrency: normalizedProviderConfig.max_concurrency,
          transformer: this.hasTransformerEntries(transformer)
            ? transformer
            : undefined,
        });

        this.logger.info(`${normalizedProviderConfig.name} provider registered`);
      } catch (error) {
        this.logger.error(`${providerConfig.name} provider registered error: ${error}`);
      }
    });
  }

  private normalizeProviderConfig(
    providerConfig: ConfigProvider & { api?: string }
  ): ConfigProvider {
    const apiTransformerName =
      typeof providerConfig.api === "string" ? providerConfig.api.trim() : "";

    if (!apiTransformerName) {
      return providerConfig;
    }

    if (!this.transformerService.hasTransformer(apiTransformerName)) {
      this.logger.warn(
        `Provider '${providerConfig.name}' references unknown api transformer '${apiTransformerName}'`
      );
      return providerConfig;
    }

    const transformerConfig = providerConfig.transformer
      ? { ...providerConfig.transformer }
      : {};
    const currentUse = Array.isArray(transformerConfig.use)
      ? [...transformerConfig.use]
      : [];
    const alreadyConfigured = currentUse.some((item) =>
      Array.isArray(item) ? item[0] === apiTransformerName : item === apiTransformerName
    );

    if (!alreadyConfigured) {
      transformerConfig.use = [apiTransformerName, ...currentUse];
    }

    // Auto-add DeepseekTransformer for DeepSeek-related providers.
    // DeepSeek's API requires reasoning_content to be passed back on assistant messages
    // when thinking mode is active. The DeepseekTransformer handles this conversion
    // (thinking back to reasoning_content on requests, and reasoning_content to thinking
    // on responses). Match by provider name or base URL containing "deepseek" or
    // "opencode.ai" (which proxies DeepSeek models).
    const deepseekTransformerName = "deepseek";
    if (this.transformerService.hasTransformer(deepseekTransformerName)) {
      const providerLower = providerConfig.name.toLowerCase();
      const baseUrlLower = (providerConfig.api_base_url || "").toLowerCase();
      if (
        providerLower.includes("deepseek") ||
        baseUrlLower.includes("deepseek") ||
        baseUrlLower.includes("opencode.ai")
      ) {
        const use = Array.isArray(transformerConfig.use)
          ? transformerConfig.use
          : [];
        const alreadyHasDeepseek = use.some((item: any) =>
          Array.isArray(item)
            ? item[0] === deepseekTransformerName
            : item === deepseekTransformerName
        );
        if (!alreadyHasDeepseek) {
          transformerConfig.use = [...use, deepseekTransformerName];
        }
      }
    }

    return {
      ...providerConfig,
      transformer: transformerConfig as ConfigProvider["transformer"],
    };
  }

  private hasTransformerEntries(transformer: LLMProvider["transformer"]): boolean {
    return Object.entries(transformer).some(([key, value]) => {
      if (key === "use") {
        return Array.isArray(value) && value.length > 0;
      }

      return Array.isArray(value?.use) && value.use.length > 0;
    });
  }

  registerProvider(request: RegisterProviderRequest): LLMProvider {
    // Normalize models to plain strings for the internal LLMProvider
    const normalizedModels = request.models.map((m) => normalizeModelName(m));
    const provider: LLMProvider = {
      ...request,
      models: normalizedModels,
    };

    this.providers.set(provider.name, provider);

    // Register concurrency limit with the semaphore
    this.semaphore.setLimit(provider.name, provider.maxConcurrency);

    request.models.forEach((entry) => {
      const modelName = normalizeModelName(entry);
      const aliases = extractAliases(entry);
      const fullModel = `${provider.name}/${modelName}`;
      const route: ModelRoute = {
        provider: provider.name,
        model: modelName,
        fullModel,
        aliases: aliases.length > 0 ? aliases : undefined,
      };

      // Register the full "provider/model" route
      this.modelRoutes.set(fullModel, route);

      // Register the bare model name as a route (if not already taken)
      if (!this.modelRoutes.has(modelName)) {
        this.modelRoutes.set(modelName, route);
      }

      // Register each alias as an additional route pointing to the same model
      for (const alias of aliases) {
        if (!this.modelRoutes.has(alias)) {
          this.modelRoutes.set(alias, route);
        }
        // Also register "provider/alias" format
        const fullAlias = `${provider.name}/${alias}`;
        if (!this.modelRoutes.has(fullAlias)) {
          this.modelRoutes.set(fullAlias, route);
        }
      }
    });

    return provider;
  }

  getProviders(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  updateProvider(
    id: string,
    updates: Partial<LLMProvider>
  ): LLMProvider | null {
    const provider = this.providers.get(id);
    if (!provider) {
      return null;
    }

    const updatedProvider = {
      ...provider,
      ...updates,
      updatedAt: new Date(),
    };

    this.providers.set(id, updatedProvider);

    if (updates.models) {
      // Clean up old routes
      provider.models.forEach((modelEntry) => {
        const modelName = normalizeModelName(modelEntry);
        const fullModel = `${provider.name}/${modelName}`;
        this.modelRoutes.delete(fullModel);
        this.modelRoutes.delete(modelName);
        // Also clean up any aliases from old routes
        const aliases = extractAliases(modelEntry);
        for (const alias of aliases) {
          this.modelRoutes.delete(alias);
          this.modelRoutes.delete(`${provider.name}/${alias}`);
        }
      });

      // Register new routes
      updates.models.forEach((modelEntry) => {
        const modelName = normalizeModelName(modelEntry);
        const aliases = extractAliases(modelEntry);
        const fullModel = `${provider.name}/${modelName}`;
        const route: ModelRoute = {
          provider: provider.name,
          model: modelName,
          fullModel,
          aliases: aliases.length > 0 ? aliases : undefined,
        };
        this.modelRoutes.set(fullModel, route);
        if (!this.modelRoutes.has(modelName)) {
          this.modelRoutes.set(modelName, route);
        }
        for (const alias of aliases) {
          if (!this.modelRoutes.has(alias)) {
            this.modelRoutes.set(alias, route);
          }
          const fullAlias = `${provider.name}/${alias}`;
          if (!this.modelRoutes.has(fullAlias)) {
            this.modelRoutes.set(fullAlias, route);
          }
        }
      });
    }

    return updatedProvider;
  }

  deleteProvider(id: string): boolean {
    const provider = this.providers.get(id);
    if (!provider) {
      return false;
    }

    provider.models.forEach((modelEntry) => {
      const modelName = normalizeModelName(modelEntry);
      const fullModel = `${provider.name}/${modelName}`;
      this.modelRoutes.delete(fullModel);
      this.modelRoutes.delete(modelName);
      // Also clean up aliases
      const aliases = extractAliases(modelEntry);
      for (const alias of aliases) {
        this.modelRoutes.delete(alias);
        this.modelRoutes.delete(`${provider.name}/${alias}`);
      }
    });

    // Clean up semaphore limit
    this.semaphore.removeLimit(provider.name);

    this.providers.delete(id);
    return true;
  }

  toggleProvider(name: string, enabled: boolean): boolean {
    const provider = this.providers.get(name);
    if (!provider) {
      return false;
    }
    return true;
  }

  resolveModelRoute(modelName: string): RequestRouteInfo | null {
    const route = this.modelRoutes.get(modelName);
    if (!route) {
      return null;
    }

    const provider = this.providers.get(route.provider);
    if (!provider) {
      return null;
    }

    return {
      provider,
      originalModel: modelName,
      targetModel: route.model,
    };
  }

  getAvailableModelNames(): string[] {
    // Return all keys from modelRoutes (includes actual model names + aliases)
    return Array.from(this.modelRoutes.keys());
  }

  getModelRoutes(): ModelRoute[] {
    return Array.from(this.modelRoutes.values());
  }

  private parseTransformerConfig(transformerConfig: any): any {
    if (!transformerConfig) return {};

    if (Array.isArray(transformerConfig)) {
      return transformerConfig.reduce((acc, item) => {
        if (Array.isArray(item)) {
          const [name, config = {}] = item;
          acc[name] = config;
        } else {
          acc[item] = {};
        }
        return acc;
      }, {});
    }

    return transformerConfig;
  }

  async getAvailableModels(): Promise<{
    object: string;
    data: Array<{
      id: string;
      object: string;
      owned_by: string;
      provider: string;
    }>;
  }> {
    const models: Array<{
      id: string;
      object: string;
      owned_by: string;
      provider: string;
    }> = [];
    const seenIds = new Set<string>();

    // Iterate modelRoutes to include all registered names (actual + aliases)
    this.modelRoutes.forEach((route, key) => {
      if (seenIds.has(key)) return;
      seenIds.add(key);

      models.push({
        id: key,
        object: "model",
        owned_by: route.provider,
        provider: route.provider,
      });
    });

    return {
      object: "list",
      data: models,
    };
  }
}
