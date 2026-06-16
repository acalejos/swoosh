import { estimatedCostUsd, explainCandidate, latencyWeight, namedPolicy, qualityScore } from "./policy";
import {
  type CapabilityCatalog,
  type GenerateObjectRequest,
  type GenerateRequest,
  type GenerateTextRequest,
  type ModelCapability,
  ModelRouterError,
  type ModelModality,
  type ProviderAdapter,
  type RankedModel,
  type RejectedModel,
  type RoutePlan,
  type RouterAttempt,
  type RouterRunResult,
  type RoutingPreference,
  type TaskRequest,
} from "./types";

const DEFAULT_INPUT_TOKENS = 8_000;
const DEFAULT_OUTPUT_TOKENS = 2_000;

const defaultOutputModalities: readonly ModelModality[] = ["text"];

const hasEvery = <T>(available: readonly T[], required: readonly T[]): boolean =>
  required.every((value) => available.includes(value));

const providerAvailable = (adapter: ProviderAdapter | undefined): boolean =>
  Boolean(adapter) && (adapter?.isAvailable ? adapter.isAvailable() : true);

const reject = (rejected: RejectedModel[], capability: ModelCapability, reason: string): void => {
  rejected.push({ providerId: capability.providerId, modelId: capability.modelId, reason });
};

export interface ModelRouterOptions {
  readonly catalog: CapabilityCatalog;
  readonly providers: readonly ProviderAdapter[];
  readonly defaultPreference?: RoutingPreference;
}

export class ModelRouter {
  private readonly providers: Map<string, ProviderAdapter>;

  constructor(private readonly options: ModelRouterOptions) {
    this.providers = new Map(options.providers.map((provider) => [provider.providerId, provider]));
  }

  async plan<Input>(request: TaskRequest<Input>): Promise<RoutePlan> {
    const capabilities = await this.options.catalog.listCapabilities();
    const rejected: RejectedModel[] = [];
    const inputTokens = request.estimatedInputTokens ?? DEFAULT_INPUT_TOKENS;
    const outputTokens = request.estimatedOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
    const outputModalities = request.outputModalities ?? defaultOutputModalities;
    const requiredFeatures = request.requiresFeatures ?? [];
    const denied = new Set(request.constraints?.deniedProviderIds ?? []);
    const allowed = request.constraints?.allowedProviderIds
      ? new Set(request.constraints.allowedProviderIds)
      : undefined;
    const maxLatencyClass = request.constraints?.maxLatencyClass;

    const candidates: RankedModel[] = [];
    for (const capability of capabilities) {
      const adapter = this.providers.get(capability.providerId);
      if (!providerAvailable(adapter)) {
        reject(rejected, capability, "No available provider adapter.");
        continue;
      }
      if (allowed && !allowed.has(capability.providerId)) {
        reject(rejected, capability, "Provider is not allowed by policy.");
        continue;
      }
      if (denied.has(capability.providerId)) {
        reject(rejected, capability, "Provider is denied by policy.");
        continue;
      }
      if (!hasEvery(capability.inputModalities, request.inputModalities)) {
        reject(rejected, capability, "Model does not support the required input modalities.");
        continue;
      }
      if (!hasEvery(capability.outputModalities, outputModalities)) {
        reject(rejected, capability, "Model does not support the required output modalities.");
        continue;
      }
      const missingFeature = requiredFeatures.find(
        (feature) => !capability.features.includes(feature),
      );
      if (missingFeature) {
        reject(rejected, capability, `Missing required feature: ${missingFeature}.`);
        continue;
      }
      if (capability.limits.contextTokens && capability.limits.contextTokens < inputTokens) {
        reject(rejected, capability, "Estimated input exceeds context window.");
        continue;
      }
      if (capability.limits.outputTokens && capability.limits.outputTokens < outputTokens) {
        reject(rejected, capability, "Estimated output exceeds output limit.");
        continue;
      }
      if (
        maxLatencyClass &&
        latencyWeight[capability.latencyClass ?? "standard"] < latencyWeight[maxLatencyClass]
      ) {
        reject(rejected, capability, "Model is slower than the latency policy allows.");
        continue;
      }
      const cost = estimatedCostUsd(capability, inputTokens, outputTokens);
      if (cost !== undefined && request.constraints?.maxCostUsd !== undefined) {
        if (cost > request.constraints.maxCostUsd) {
          reject(rejected, capability, "Estimated cost exceeds policy.");
          continue;
        }
      }
      const latency = latencyWeight[capability.latencyClass ?? "standard"];
      const score = qualityScore(capability) + latency - (cost ?? 0) * 20;
      candidates.push({
        capability,
        score,
        estimatedCostUsd: cost,
        reason: explainCandidate(
          capability,
          typeof request.preference === "string"
            ? request.preference
            : (this.options.defaultPreference ?? "balanced"),
        ),
      });
    }

    if (candidates.length === 0) {
      throw new ModelRouterError(
        `No model supports task "${request.task}" with the requested constraints.`,
      );
    }

    const preference =
      typeof request.preference === "function"
        ? "custom"
        : (request.preference ?? this.options.defaultPreference ?? "balanced");
    const namedPreference: RoutingPreference =
      typeof request.preference === "string"
        ? request.preference
        : (this.options.defaultPreference ?? "balanced");
    const policy =
      typeof request.preference === "function"
        ? request.preference
        : namedPolicy(namedPreference, request.constraints?.preferredProviderIds);
    const ranked = await policy({ request, candidates });
    const [selected, ...fallbacks] = ranked;
    if (!selected) {
      throw new ModelRouterError("Routing policy returned no candidates.");
    }
    return {
      task: request.task,
      preference,
      selected,
      fallbacks: request.constraints?.allowFallbacks === false ? [] : fallbacks,
      rejected,
      estimate: {
        inputTokens,
        outputTokens,
        costUsd: selected.estimatedCostUsd,
      },
    };
  }

  /**
   * Generate from the best-routed model. The kind of output is inferred from
   * the request, not the method name:
   *
   *   • `outputModalities` includes `"image"` → an image (set `Output` to
   *     `GeneratedImage`); routes to the adapter's `generateImage`
   *   • a `schema` is present → a schema-validated object; routes to
   *     `generateObject`
   *   • otherwise → free text (set `Output` to `string`); routes to
   *     `generateText`
   *
   * A model is only eligible if its catalog entry supports the requested
   * modalities/features AND its adapter implements the matching method; if not,
   * the router falls through to the next route.
   */
  async generate<Input, Output>(
    request: GenerateRequest<Input>,
  ): Promise<RouterRunResult<Output>> {
    const plan = await this.plan(request);
    const wantsImage = (request.outputModalities ?? defaultOutputModalities).includes(
      "image",
    );

    if (wantsImage) {
      return this.executePlan<Output>(
        plan,
        request.task,
        (adapter, capability) =>
          adapter.generateImage
            ? (adapter.generateImage<Input>({
                ...request,
                model: capability,
              }) as Promise<Output>)
            : undefined,
        "Provider adapter cannot generate images.",
      );
    }

    if (request.schema !== undefined) {
      return this.executePlan<Output>(
        plan,
        request.task,
        (adapter, capability) =>
          adapter.generateObject
            ? adapter.generateObject<Input, Output>({ ...request, model: capability })
            : undefined,
        "Provider adapter cannot generate objects.",
      );
    }

    return this.executePlan<Output>(
      plan,
      request.task,
      (adapter, capability) =>
        adapter.generateText
          ? (adapter.generateText<Input>({
              ...request,
              prompt: request.prompt ?? "",
              model: capability,
            }) as Promise<Output>)
          : undefined,
      "Provider adapter cannot generate text.",
    );
  }

  /** @deprecated Use {@link generate} — it infers structured output from a
   *  `schema` in the request. `run` remains as a thin alias. */
  async run<Input, Output>(
    request: GenerateObjectRequest<Input>,
  ): Promise<RouterRunResult<Output>> {
    const plan = await this.plan(request);
    return this.executePlan<Output>(
      plan,
      request.task,
      (adapter, capability) =>
        adapter.generateObject
          ? adapter.generateObject<Input, Output>({ ...request, model: capability })
          : undefined,
      "Provider adapter cannot generate objects.",
    );
  }

  /** @deprecated Use {@link generate} — text is the default when no `schema`
   *  or image modality is requested. */
  async runText<Input>(request: GenerateTextRequest<Input>): Promise<RouterRunResult<string>> {
    const plan = await this.plan(request);
    return this.executePlan<string>(
      plan,
      request.task,
      (adapter, capability) =>
        adapter.generateText
          ? adapter.generateText<Input>({ ...request, model: capability })
          : undefined,
      "Provider adapter cannot generate text.",
    );
  }

  /** @deprecated Use `(await generate(req)).output`. */
  async generateObject<Input, Output>(request: GenerateObjectRequest<Input>): Promise<Output> {
    return (await this.run<Input, Output>(request)).output;
  }

  /** @deprecated Use `(await generate(req)).output`. */
  async generateText<Input>(request: GenerateTextRequest<Input>): Promise<string> {
    return (await this.runText<Input>(request)).output;
  }

  private async executePlan<Output>(
    plan: RoutePlan,
    task: string,
    invoke: (
      adapter: ProviderAdapter,
      capability: ModelCapability,
    ) => Promise<Output> | undefined,
    unsupportedReason: string,
  ): Promise<RouterRunResult<Output>> {
    const routes = [plan.selected, ...plan.fallbacks];
    const attempts: RouterAttempt[] = [];

    for (const route of routes) {
      const adapter = this.providers.get(route.capability.providerId);
      const pending = adapter ? invoke(adapter, route.capability) : undefined;
      if (!pending) {
        attempts.push({
          providerId: route.capability.providerId,
          modelId: route.capability.modelId,
          ok: false,
          error: unsupportedReason,
        });
        continue;
      }
      try {
        const output = await pending;
        attempts.push({
          providerId: route.capability.providerId,
          modelId: route.capability.modelId,
          ok: true,
        });
        return { output, plan, attempts };
      } catch (cause) {
        attempts.push({
          providerId: route.capability.providerId,
          modelId: route.capability.modelId,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }

    throw new ModelRouterError(`All model routes failed for task "${task}".`);
  }
}
