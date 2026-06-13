import {
  type CapabilityCatalog,
  ModelRouter,
  type ProviderAdapter,
  type RoutingPreference,
} from "@semafore/router";
import { defaultCatalog } from "@semafore/capabilities";
import { autoProviders } from "./providers";

// Re-export the whole toolkit so the drop-in is a single import surface.
export * from "@semafore/router";
export * from "@semafore/judge";
export { createAiSdkProviderAdapter, type AiSdkProviderOptions } from "@semafore/ai-sdk";
export {
  capabilities,
  defaultCatalog,
  defaultOverrides,
  meta as capabilitiesMeta,
} from "@semafore/capabilities";
export {
  autoProviders,
  providerRegistry,
  type AutoProvidersOptions,
  type ProviderEntry,
} from "./providers";

export interface CreateRouterOptions {
  /** Capability catalog. Defaults to the bundled, enriched `@semafore/capabilities` dataset. */
  readonly catalog?: CapabilityCatalog;
  /** Provider adapters. Defaults to AI-SDK providers auto-wired from present API keys. */
  readonly providers?: readonly ProviderAdapter[];
  /** Preference used when a request omits one. Defaults to `"balanced"`. */
  readonly defaultPreference?: RoutingPreference;
  /** Environment source for key-based provider auto-wiring. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  /** Module loader for auto-wiring, defaults to dynamic `import`. Injectable for testing. */
  readonly load?: (id: string) => Promise<unknown>;
}

/**
 * Batteries-included router. With no arguments it uses the enriched default
 * catalog and auto-wires AI SDK adapters for every provider whose API key is in
 * the environment (and whose `@ai-sdk/*` package is installed):
 *
 *     const router = await createRouter();
 *     const out = await router.generateObject({ task, input, requiresFeatures: ["structured_output"] });
 *
 * Pass `providers` to wire them yourself, or `catalog` to swap the dataset.
 */
export const createRouter = async (options: CreateRouterOptions = {}): Promise<ModelRouter> => {
  const providers =
    options.providers ?? (await autoProviders({ env: options.env, load: options.load }));
  return new ModelRouter({
    catalog: options.catalog ?? defaultCatalog(),
    providers,
    defaultPreference: options.defaultPreference ?? "balanced",
  });
};
