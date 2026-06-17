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
  // a reranker can return a natural-language rationale per result (LLM rerankers
  // can; dedicated cross-encoders cannot). Required via requiresFeatures to route
  // to a reason-capable reranker — see ModelCapability.rerank.
  | "explanations"
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
  /**
   * Present iff this model is a reranker (orders documents by relevance to a
   * query). Its adapter must implement {@link ProviderAdapter.rerank}. Dedicated
   * cross-encoders (Cohere/Voyage/Jina) return scores only; an LLM-backed
   * reranker can also return per-result rationales — declare the `"explanations"`
   * feature for those so requests can route to them.
   */
  readonly rerank?: {
    readonly maxDocuments?: number;
    readonly maxTokensPerDoc?: number;
    readonly maxQueryTokens?: number;
    /**
     * Flat price per rerank call (some providers bill per search, e.g. Cohere ~
     * $2/1k searches → 0.002). When set, it's used as the cost for cost-based
     * routing; otherwise per-token `pricing` is used (Voyage/Jina bill per token).
     */
    readonly pricePerSearchUsd?: number;
  };
}

export interface TaskConstraints {
  readonly maxCostUsd?: number;
  readonly maxLatencyClass?: LatencyClass;
  readonly allowedProviderIds?: readonly string[];
  readonly deniedProviderIds?: readonly string[];
  readonly preferredProviderIds?: readonly string[];
  readonly allowFallbacks?: boolean;
}

/** An image attached to a multimodal request. */
export interface ImageInput {
  /** Base64 data, a `data:` URL, or a remote URL. */
  readonly data: string;
  /** e.g. `"image/png"` — recommended for base64/data URLs. */
  readonly mediaType?: string;
}

/** A string (URL or `data:` URL) or a structured {@link ImageInput}. */
export type ImagePart = string | ImageInput;

export interface TaskRequest<Input = unknown> {
  readonly task: string;
  readonly input: Input;
  readonly inputModalities: readonly ModelModality[];
  /**
   * Image inputs for multimodal requests. A first-class slot so adapters read
   * `request.images` instead of smuggling them through `metadata`. Declare
   * `inputModalities: ["text", "image"]` so routing filters to vision models.
   */
  readonly images?: readonly ImagePart[];
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
  /**
   * Score the documents in `request` by relevance to `request.query`. Return a
   * score per document (by original index); include `reason` only if the model
   * produces rationales (and declares the `"explanations"` feature). The router
   * attaches the document text, sorts by score, and applies `topK`.
   */
  rerank?<Input>(
    request: ProviderRerankRequest<Input>,
  ): Promise<readonly RerankScore[]>;
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

/**
 * Reorder `documents` by relevance to `query`. Mirrors the generation requests:
 * declare intent (`requiresFeatures`, e.g. `["explanations"]`) and policy
 * (`preference`, `constraints`); the router filters to reranker models, ranks
 * them, and falls back automatically. Unlike embeddings, rerankers are
 * stateless, so cross-model fallback is safe.
 */
export interface RerankRequest<Input = unknown> {
  readonly task: string;
  readonly query: string;
  readonly documents: readonly string[];
  /** Return only the top N results (default: all). */
  readonly topK?: number;
  readonly requiresFeatures?: readonly ModelFeature[];
  readonly preference?: RoutingPreference | RoutingPolicy;
  readonly constraints?: TaskConstraints;
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly metadata?: Record<string, unknown>;
  /** Optional extra context for custom policies / adapters. */
  readonly input?: Input;
}

export interface ProviderRerankRequest<Input = unknown> extends RerankRequest<Input> {
  readonly model: ModelCapability;
}

/** A relevance score for one input document, by its original index. */
export interface RerankScore {
  readonly index: number;
  readonly score: number;
  /** Natural-language rationale — only from reason-capable (`"explanations"`) rerankers. */
  readonly reason?: string;
}

export interface RerankedDocument extends RerankScore {
  /** The document text at `index`, attached by the router for convenience. */
  readonly document: string;
}

export interface RerankResult {
  /** Documents sorted by descending relevance, capped at `topK`. */
  readonly results: readonly RerankedDocument[];
  readonly model: ModelCapability;
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

/**
 * Thrown when a model's structured output does not conform to the requested
 * JSON Schema. The router treats this like any other failed attempt, so it
 * falls through to the next routed model rather than returning a bad object.
 */
export class SchemaValidationError extends ModelRouterError {
  constructor(
    readonly modelId: string,
    readonly issues: readonly string[],
  ) {
    super(
      `Structured output from "${modelId}" failed schema validation: ${issues.join("; ")}`,
    );
    this.name = "SchemaValidationError";
  }
}
