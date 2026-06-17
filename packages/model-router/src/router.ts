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
  type RerankedDocument,
  type RerankRequest,
  type RerankResult,
  type RoutePlan,
  type RouterAttempt,
  type RouterRunResult,
  type RoutingPreference,
  SchemaValidationError,
  type TaskRequest,
} from "./types";
import { looksLikeJsonSchema, validateAgainstJsonSchema } from "./schema";

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
  /**
   * Validate structured output against the request's JSON Schema and fall
   * through to the next routed model when it doesn't conform. On by default —
   * set `false` to restore the old pass-through behavior. Only JSON-Schema
   * shaped schemas are enforced; other representations are left to the adapter.
   */
  readonly validateStructuredOutput?: boolean;
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
      const anyFeatures = request.requiresAnyFeatures ?? [];
      if (anyFeatures.length > 0 && !anyFeatures.some((f) => capability.features.includes(f))) {
        reject(rejected, capability, `Has none of the features: ${anyFeatures.join(", ")}.`);
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

    return this.finalizePlan(request, candidates, rejected, inputTokens, outputTokens);
  }

  /** Shared tail of {@link plan} / {@link planRerank}: rank the surviving
   *  candidates by preference (or a custom policy) and assemble the RoutePlan. */
  private async finalizePlan(
    request: TaskRequest,
    candidates: RankedModel[],
    rejected: RejectedModel[],
    inputTokens: number,
    outputTokens: number,
  ): Promise<RoutePlan> {
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
   * Plan a rerank: filter the catalog to reranker models (a `rerank` capability
   * + an adapter that implements `rerank`) satisfying `requiresFeatures` (e.g.
   * `["explanations"]`) and constraints, then rank by preference. Inspectable
   * like {@link plan} — every rejected model carries a reason.
   */
  async planRerank<Input>(request: RerankRequest<Input>): Promise<RoutePlan> {
    const capabilities = await this.options.catalog.listCapabilities();
    const rejected: RejectedModel[] = [];
    const inputTokens = request.estimatedInputTokens ?? DEFAULT_INPUT_TOKENS;
    const outputTokens = request.estimatedOutputTokens ?? 0;
    const requiredFeatures = request.requiresFeatures ?? [];
    const denied = new Set(request.constraints?.deniedProviderIds ?? []);
    const allowed = request.constraints?.allowedProviderIds
      ? new Set(request.constraints.allowedProviderIds)
      : undefined;
    const named: RoutingPreference =
      typeof request.preference === "string"
        ? request.preference
        : (this.options.defaultPreference ?? "balanced");

    const candidates: RankedModel[] = [];
    for (const capability of capabilities) {
      const adapter = this.providers.get(capability.providerId);
      if (!providerAvailable(adapter)) {
        reject(rejected, capability, "No available provider adapter.");
        continue;
      }
      if (!capability.rerank) {
        reject(rejected, capability, "Model is not a reranker.");
        continue;
      }
      if (!adapter?.rerank) {
        reject(rejected, capability, "Provider adapter cannot rerank.");
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
      const missingFeature = requiredFeatures.find(
        (feature) => !capability.features.includes(feature),
      );
      if (missingFeature) {
        reject(rejected, capability, `Missing required feature: ${missingFeature}.`);
        continue;
      }
      const anyFeatures = request.requiresAnyFeatures ?? [];
      if (anyFeatures.length > 0 && !anyFeatures.some((f) => capability.features.includes(f))) {
        reject(rejected, capability, `Has none of the features: ${anyFeatures.join(", ")}.`);
        continue;
      }
      const maxDocuments = capability.rerank.maxDocuments;
      if (maxDocuments !== undefined && request.documents.length > maxDocuments) {
        reject(
          rejected,
          capability,
          `Too many documents (${request.documents.length} > ${maxDocuments}).`,
        );
        continue;
      }
      // Per-search billers (Cohere) use a flat price; per-token billers
      // (Voyage/Jina) fall back to token pricing.
      const cost =
        capability.rerank.pricePerSearchUsd ??
        estimatedCostUsd(capability, inputTokens, outputTokens);
      if (
        cost !== undefined &&
        request.constraints?.maxCostUsd !== undefined &&
        cost > request.constraints.maxCostUsd
      ) {
        reject(rejected, capability, "Estimated cost exceeds policy.");
        continue;
      }
      const latency = latencyWeight[capability.latencyClass ?? "standard"];
      const score = qualityScore(capability) + latency - (cost ?? 0) * 20;
      candidates.push({
        capability,
        score,
        estimatedCostUsd: cost,
        reason: explainCandidate(capability, named),
      });
    }

    // A TaskRequest view so custom policies see a uniform shape (input = query).
    const policyRequest: TaskRequest<Input> = {
      task: request.task,
      input: request.input ?? (request.query as Input),
      inputModalities: ["text"],
      requiresFeatures: request.requiresFeatures,
      preference: request.preference,
      constraints: request.constraints,
      estimatedInputTokens: request.estimatedInputTokens,
      estimatedOutputTokens: request.estimatedOutputTokens,
    };
    return this.finalizePlan(policyRequest, candidates, rejected, inputTokens, outputTokens);
  }

  /**
   * Rerank `request.documents` by relevance to `request.query`, routing to the
   * best reranker and falling back automatically. The result's documents are
   * sorted by descending score and capped at `topK`; `reason` is populated only
   * when the chosen reranker supports `"explanations"`.
   */
  async rerank<Input>(request: RerankRequest<Input>): Promise<RerankResult> {
    const plan = await this.planRerank(request);
    const topK = request.topK ?? request.documents.length;
    const run = await this.executePlan<readonly RerankedDocument[]>(
      plan,
      request.task,
      (adapter, capability) =>
        adapter.rerank
          ? adapter
              .rerank<Input>({ ...request, model: capability })
              .then((scored) =>
                [...scored]
                  .filter((s) => s.index >= 0 && s.index < request.documents.length)
                  .map(
                    (s): RerankedDocument => ({
                      index: s.index,
                      document: request.documents[s.index]!,
                      score: s.score,
                      reason: s.reason,
                    }),
                  )
                  .sort((a, b) => b.score - a.score)
                  .slice(0, topK),
              )
          : undefined,
      "Provider adapter cannot rerank.",
    );
    // the winning route is the last attempt (executePlan returns on first success)
    const winner = run.attempts[run.attempts.length - 1];
    const model =
      [plan.selected, ...plan.fallbacks].find(
        (route) =>
          route.capability.providerId === winner?.providerId &&
          route.capability.modelId === winner?.modelId,
      )?.capability ?? plan.selected.capability;
    return {
      results: run.output,
      model,
      plan: run.plan,
      attempts: run.attempts,
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
            ? this.generateValidatedObject<Input, Output>(adapter, capability, request)
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

  /**
   * Call an adapter's `generateObject` and, unless disabled, validate the
   * result against the request's JSON Schema. A non-conforming object throws a
   * {@link SchemaValidationError}, which `executePlan` records as a failed
   * attempt — so the router falls through to the next routed model.
   */
  private async generateValidatedObject<Input, Output>(
    adapter: ProviderAdapter,
    capability: ModelCapability,
    request: GenerateObjectRequest<Input> | GenerateRequest<Input>,
  ): Promise<Output> {
    const output = await adapter.generateObject!<Input, Output>({
      ...request,
      model: capability,
    });
    if (
      this.options.validateStructuredOutput !== false &&
      looksLikeJsonSchema(request.schema)
    ) {
      const issues = validateAgainstJsonSchema(output, request.schema);
      if (issues.length > 0) {
        throw new SchemaValidationError(capability.modelId, issues);
      }
    }
    return output;
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
          ? this.generateValidatedObject<Input, Output>(adapter, capability, request)
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
