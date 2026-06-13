/**
 * Conventional environment-variable names that hold each provider's API key,
 * keyed by the provider id used in capability catalogs (matching models.dev).
 * Several providers accept more than one conventional name; the first present
 * one counts. Extend or override this map for providers not listed here.
 */
export const apiKeyEnvVars: Record<string, readonly string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-vertex": ["GOOGLE_VERTEX_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  cohere: ["COHERE_API_KEY", "CO_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  togetherai: ["TOGETHER_AI_API_KEY", "TOGETHER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  azure: ["AZURE_API_KEY", "AZURE_OPENAI_API_KEY"],
};

export interface HasApiKeyOptions {
  /** Environment source. Defaults to `process.env` (or `{}` where unavailable). */
  readonly env?: Record<string, string | undefined>;
  /** Override the env-var name(s) to check for this provider. */
  readonly vars?: readonly string[];
}

const defaultEnv = (): Record<string, string | undefined> =>
  typeof process !== "undefined" && process.env ? process.env : {};

/**
 * The env-var name(s) checked for a provider. Falls back to a derived
 * `<PROVIDER>_API_KEY` name for providers not in {@link apiKeyEnvVars}
 * (e.g. `"gemini"` → `"GEMINI_API_KEY"`).
 */
export const apiKeyEnvVarsFor = (providerId: string): readonly string[] =>
  apiKeyEnvVars[providerId] ?? [`${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];

/**
 * Whether an API key for `providerId` is present in the environment. Pairs with
 * a provider adapter's `isAvailable`:
 *
 *     createCallbackProviderAdapter({
 *       providerId: "openai",
 *       isAvailable: () => hasApiKey("openai"),
 *       generateObject,
 *     });
 *
 * Reads `process.env` by default (guarded for non-Node runtimes); pass `env` to
 * use a different source, or `vars` to override the variable names.
 */
export const hasApiKey = (providerId: string, options: HasApiKeyOptions = {}): boolean => {
  const env = options.env ?? defaultEnv();
  const vars = options.vars ?? apiKeyEnvVarsFor(providerId);
  return vars.some((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
};
