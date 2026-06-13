import {
  type CapabilityCatalog,
  type ModelCapability,
  type ModelFeature,
  type ModelModality,
  ModelRouterError,
} from "./types";

const normalizeModality = (value: string): ModelModality =>
  value === "document" ? "pdf" : value === "attachment" ? "file" : (value as ModelModality);

export class StaticCapabilityCatalog implements CapabilityCatalog {
  constructor(private readonly capabilities: readonly ModelCapability[]) {}

  async listCapabilities(): Promise<readonly ModelCapability[]> {
    return this.capabilities;
  }
}

export const createStaticCapabilityCatalog = (
  capabilities: readonly ModelCapability[],
): CapabilityCatalog => new StaticCapabilityCatalog(capabilities);

/**
 * Build a catalog from any loader — a database query, an internal API, a cached
 * file. This is the bring-your-own-source seam: opt out of models.dev entirely
 * while still producing the canonical `ModelCapability` shape the router expects.
 * The loader may be sync or async; failures become a `ModelRouterError`.
 *
 * If your rows are already in models.dev's JSON shape, run them through
 * `normalizeModelsDevCatalog` inside the loader to map them to `ModelCapability`.
 */
export const createCapabilityCatalog = (
  load: () => Promise<readonly ModelCapability[]> | readonly ModelCapability[],
): CapabilityCatalog => ({
  listCapabilities: async () => {
    try {
      return await load();
    } catch (cause) {
      throw new ModelRouterError("Unable to load model capability catalog.", cause);
    }
  },
});

/**
 * Scope any catalog down to the models you can actually use, declared once at
 * construction rather than per request. Pull full configs from a broad catalog
 * (e.g. models.dev) and intersect it with what you have access to.
 *
 * `filter` is either a predicate, or an allowlist of `"providerId/modelId"`
 * keys (a bare `"modelId"` matches across providers). The filter runs on every
 * `listCapabilities()` call, so a predicate that reads live state stays current.
 */
export const filterCapabilityCatalog = (
  catalog: CapabilityCatalog,
  filter: ((capability: ModelCapability) => boolean) | readonly string[],
): CapabilityCatalog => {
  const predicate =
    typeof filter === "function"
      ? filter
      : (() => {
          const allow = new Set(filter);
          return (capability: ModelCapability): boolean =>
            allow.has(`${capability.providerId}/${capability.modelId}`) ||
            allow.has(capability.modelId);
        })();
  return {
    listCapabilities: async () => (await catalog.listCapabilities()).filter(predicate),
  };
};

/**
 * A partial enrichment for one model, keyed by `providerId` + `modelId`. Use it
 * to add capabilities a base catalog omits — e.g. tagging `web_search`, or
 * supplying `latencyClass` / `qualityScore`, which models.dev does not carry.
 */
export type CapabilityOverride = Partial<Omit<ModelCapability, "providerId" | "modelId">> &
  Pick<ModelCapability, "providerId" | "modelId">;

/**
 * Enrich a base capability list with overrides matched on `providerId/modelId`.
 * `features` are unioned; `limits` and `pricing` are shallow-merged; other
 * fields replace. Overrides with no matching base model are ignored (to add a
 * net-new model, concatenate it into the base array instead).
 */
export const mergeCapabilities = (
  base: readonly ModelCapability[],
  overrides: readonly CapabilityOverride[],
): readonly ModelCapability[] => {
  const byKey = new Map(overrides.map((o) => [`${o.providerId}/${o.modelId}`, o]));
  return base.map((capability) => {
    const override = byKey.get(`${capability.providerId}/${capability.modelId}`);
    if (!override) return capability;
    return {
      ...capability,
      ...override,
      features: override.features
        ? [...new Set([...capability.features, ...override.features])]
        : capability.features,
      limits: override.limits ? { ...capability.limits, ...override.limits } : capability.limits,
      pricing: override.pricing
        ? { ...capability.pricing, ...override.pricing }
        : capability.pricing,
      benchmarks: override.benchmarks
        ? { ...capability.benchmarks, ...override.benchmarks }
        : capability.benchmarks,
    };
  });
};

export class ModelsDevCapabilityCatalog implements CapabilityCatalog {
  constructor(
    private readonly url = "https://models.dev/api.json",
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async listCapabilities(): Promise<readonly ModelCapability[]> {
    try {
      const response = await this.fetcher(this.url);
      if (!response.ok) {
        throw new Error(`models.dev responded with ${response.status}`);
      }
      return normalizeModelsDevCatalog(await response.json());
    } catch (cause) {
      throw new ModelRouterError("Unable to load model capability catalog.", cause);
    }
  }
}

export const normalizeModelsDevCatalog = (catalog: unknown): readonly ModelCapability[] => {
  if (!catalog || typeof catalog !== "object") return [];
  const capabilities: ModelCapability[] = [];
  for (const [providerKey, providerValue] of Object.entries(catalog)) {
    if (!providerValue || typeof providerValue !== "object") continue;
    const provider = providerValue as {
      id?: string;
      name?: string;
      models?: Record<string, unknown>;
    };
    for (const [modelKey, modelValue] of Object.entries(provider.models ?? {})) {
      if (!modelValue || typeof modelValue !== "object") continue;
      const model = modelValue as {
        id?: string;
        name?: string;
        attachment?: boolean;
        reasoning?: boolean;
        tool_call?: boolean;
        structured_output?: boolean;
        release_date?: string;
        last_updated?: string;
        modalities?: { input?: string[]; output?: string[] };
        limit?: { context?: number; output?: number };
        cost?: { input?: number; output?: number };
      };
      const features: ModelFeature[] = [];
      if (model.structured_output) features.push("structured_output");
      if (model.tool_call) features.push("tools");
      if (model.reasoning) features.push("reasoning");
      if (model.attachment) features.push("attachments");
      capabilities.push({
        providerId: provider.id ?? providerKey,
        providerName: provider.name ?? provider.id ?? providerKey,
        modelId: model.id ?? modelKey,
        modelName: model.name ?? model.id ?? modelKey,
        inputModalities: (model.modalities?.input ?? ["text"]).map(normalizeModality),
        outputModalities: (model.modalities?.output ?? ["text"]).map(normalizeModality),
        features,
        limits: {
          contextTokens: model.limit?.context,
          outputTokens: model.limit?.output,
        },
        pricing: {
          inputPerMillionTokens: model.cost?.input,
          outputPerMillionTokens: model.cost?.output,
        },
        releaseDate: model.release_date,
        lastUpdated: model.last_updated,
      });
    }
  }
  return capabilities;
};
