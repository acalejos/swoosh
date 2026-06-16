export type ModelModality = "text" | "image" | "audio" | "video" | "pdf" | "file";
export type RoutingPreference = "cheapest" | "fastest" | "best_quality" | "balanced";
export type LatencyClass = "fast" | "standard" | "slow";

/**
 * A capability a model has beyond its input/output modalities. The well-known
 * values are typed for autocomplete, but the set is open — providers and
 * catalogs may surface their own (e.g. "prompt_caching", "json_mode").
 */
export type ModelFeature =
  | "structured_output"
  | "tools"
  | "reasoning"
  | "attachments"
  | "web_search"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

export interface ModelPricing {
  readonly inputPerMillionTokens?: number;
  readonly outputPerMillionTokens?: number;
}

export interface ModelLimits {
  readonly contextTokens?: number;
  readonly outputTokens?: number;
}

export interface ModelCapability {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly inputModalities: readonly ModelModality[];
  readonly outputModalities: readonly ModelModality[];
  readonly features: readonly ModelFeature[];
  readonly limits: ModelLimits;
  readonly pricing: ModelPricing;
  readonly releaseDate?: string;
  readonly lastUpdated?: string;
  readonly latencyClass?: LatencyClass;
  readonly qualityScore?: number;
  /**
   * Per-domain benchmark scores, an open map (e.g. `{ swe_bench: 0.65, gpqa: 0.88,
   * lmarena_elo: 1320 }`). Values are interpreted per key by whoever reads them —
   * see the `byBenchmark` policy. models.dev does not provide these; enrich via
   * `@swoosh-dev/capabilities` or your own overrides.
   */
  readonly benchmarks?: Readonly<Record<string, number>>;
}

export interface TaskConstraints {
  readonly maxCostUsd?: number;
  readonly maxLatencyClass?: LatencyClass;
  readonly allowedProviderIds?: readonly string[];
  readonly deniedProviderIds?: readonly string[];
  readonly preferredProviderIds?: readonly string[];
  readonly allowFallbacks?: boolean;
}

export interface TaskRequest<Input = unknown> {
  readonly task: string;
  readonly input: Input;
  readonly inputModalities: readonly ModelModality[];
  readonly outputModalities?: readonly ModelModality[];
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly requiresFeatures?: readonly ModelFeature[];
  readonly preference?: RoutingPreference | RoutingPolicy;
  readonly constraints?: TaskConstraints;
}

export interface GenerateObjectRequest<Input = unknown> extends TaskRequest<Input> {
  readonly schema?: unknown;
  readonly prompt?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProviderGenerateObjectRequest<
  Input = unknown,
> extends GenerateObjectRequest<Input> {
  readonly model: ModelCapability;
}

export interface GenerateTextRequest<Input = unknown> extends TaskRequest<Input> {
  readonly prompt: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProviderGenerateTextRequest<Input = unknown> extends GenerateTextRequest<Input> {
  readonly model: ModelCapability;
}

/** A generated image, returned by an adapter's `generateImage`. */
export interface GeneratedImage {
  readonly base64: string;
  readonly mediaType: string;
}

export interface GenerateImageRequest<Input = unknown> extends TaskRequest<Input> {
  readonly prompt?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ProviderGenerateImageRequest<Input = unknown>
  extends GenerateImageRequest<Input> {
  readonly model: ModelCapability;
}

/**
 * The unified generation request used by {@link ModelRouter.generate}. The kind
 * of output is inferred from the request itself, not from a method name:
 *
 *   • `outputModalities` includes `"image"` → an image (`GeneratedImage`)
 *   • a `schema` is present                 → a schema-validated object
 *   • otherwise                             → free text
 *
 * Structured output is **not** a modality — it is still text output, just
 * constrained by a `schema` (and routable via the `structured_output` feature).
 * Modalities describe the medium (text, image, audio, …).
 */
export interface GenerateRequest<Input = unknown> extends TaskRequest<Input> {
  readonly prompt?: string;
  readonly schema?: unknown;
  readonly metadata?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly name?: string;
  isAvailable?(): boolean;
  generateObject?<Input, Output>(
    request: ProviderGenerateObjectRequest<Input>,
  ): Promise<Output>;
  generateText?<Input>(request: ProviderGenerateTextRequest<Input>): Promise<string>;
  generateImage?<Input>(
    request: ProviderGenerateImageRequest<Input>,
  ): Promise<GeneratedImage>;
}

export interface CapabilityCatalog {
  listCapabilities(): Promise<readonly ModelCapability[]>;
}

export interface RejectedModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly reason: string;
}

export interface RankedModel {
  readonly capability: ModelCapability;
  readonly score: number;
  readonly reason: string;
  readonly estimatedCostUsd?: number;
}

export interface RoutePlan {
  readonly task: string;
  readonly preference: RoutingPreference | "custom";
  readonly selected: RankedModel;
  readonly fallbacks: readonly RankedModel[];
  readonly rejected: readonly RejectedModel[];
  readonly estimate: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd?: number;
  };
}

export interface RouterAttempt {
  readonly providerId: string;
  readonly modelId: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface RouterRunResult<Output> {
  readonly output: Output;
  readonly plan: RoutePlan;
  readonly attempts: readonly RouterAttempt[];
}

export interface RoutingPolicyContext {
  readonly request: TaskRequest;
  readonly candidates: readonly RankedModel[];
}

export type RoutingPolicy = (
  context: RoutingPolicyContext,
) => readonly RankedModel[] | Promise<readonly RankedModel[]>;

export class ModelRouterError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ModelRouterError";
  }
}
