import { createAiSdkProviderAdapter } from "@swoosh-dev/ai-sdk";
import { hasApiKey, type ProviderAdapter } from "@swoosh-dev/router";

/** providerId (as used by models.dev / the catalog) → its AI SDK package + factory export. */
export interface ProviderEntry {
  readonly pkg: string;
  readonly factory: string;
}

export const providerRegistry: Record<string, ProviderEntry> = {
  openai: { pkg: "@ai-sdk/openai", factory: "openai" },
  anthropic: { pkg: "@ai-sdk/anthropic", factory: "anthropic" },
  google: { pkg: "@ai-sdk/google", factory: "google" },
  "google-vertex": { pkg: "@ai-sdk/google-vertex", factory: "vertex" },
  xai: { pkg: "@ai-sdk/xai", factory: "xai" },
  mistral: { pkg: "@ai-sdk/mistral", factory: "mistral" },
  groq: { pkg: "@ai-sdk/groq", factory: "groq" },
  deepseek: { pkg: "@ai-sdk/deepseek", factory: "deepseek" },
  cohere: { pkg: "@ai-sdk/cohere", factory: "cohere" },
  perplexity: { pkg: "@ai-sdk/perplexity", factory: "perplexity" },
  openrouter: { pkg: "@openrouter/ai-sdk-provider", factory: "openrouter" },
  togetherai: { pkg: "@ai-sdk/togetherai", factory: "togetherai" },
  "amazon-bedrock": { pkg: "@ai-sdk/amazon-bedrock", factory: "bedrock" },
  azure: { pkg: "@ai-sdk/azure", factory: "azure" },
};

export interface AutoProvidersOptions {
  /** Environment source for key detection. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** providerId → AI SDK package/factory. Defaults to {@link providerRegistry}. */
  readonly registry?: Record<string, ProviderEntry>;
  /** Module loader, defaults to dynamic `import`. Injectable for testing. */
  readonly load?: (id: string) => Promise<unknown>;
}

const get = (mod: unknown, name: string): unknown =>
  mod && typeof mod === "object" ? (mod as Record<string, unknown>)[name] : undefined;

/**
 * Build AI SDK provider adapters for every provider whose API key is present in
 * the environment *and* whose `@ai-sdk/*` package is installed — missing keys or
 * uninstalled packages are silently skipped. Requires `ai`; returns `[]` if it
 * isn't installed (nothing can execute without it).
 */
export const autoProviders = async (
  options: AutoProvidersOptions = {},
): Promise<ProviderAdapter[]> => {
  const load = options.load ?? ((id: string) => import(id));
  const registry = options.registry ?? providerRegistry;

  const ai = await load("ai").catch(() => null);
  const aiGenerateObject = get(ai, "generateObject");
  const aiGenerateText = get(ai, "generateText");
  if (typeof aiGenerateObject !== "function") return [];

  const adapters: ProviderAdapter[] = [];
  for (const [providerId, { pkg, factory }] of Object.entries(registry)) {
    if (!hasApiKey(providerId, { env: options.env })) continue;
    const mod = await load(pkg).catch(() => null);
    const make = get(mod, factory);
    if (typeof make !== "function") continue;

    adapters.push(
      createAiSdkProviderAdapter({
        providerId,
        models: (modelId: string) => (make as (id: string) => unknown)(modelId),
        generateObject: (request) =>
          (aiGenerateObject as (a: unknown) => Promise<unknown>)({
            model: request.model,
            schema: request.schema,
            prompt: request.prompt,
          }),
        generateText:
          typeof aiGenerateText === "function"
            ? async (request) => {
                const result = await (aiGenerateText as (a: unknown) => Promise<{ text: string }>)({
                  model: request.model,
                  prompt: request.prompt,
                });
                return result.text;
              }
            : undefined,
      }),
    );
  }
  return adapters;
};
