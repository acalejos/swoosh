type ModelModality = "text" | "image" | "audio" | "video" | "pdf" | "file";
type RoutingPreference = "cheapest" | "fastest" | "best_quality" | "balanced";
type LatencyClass = "fast" | "standard" | "slow";
/**
 * A capability a model has beyond its input/output modalities. The well-known
 * values are typed for autocomplete, but the set is open — providers and
 * catalogs may surface their own (e.g. "prompt_caching", "json_mode").
 */
type ModelFeature = "structured_output" | "tools" | "reasoning" | "attachments" | "web_search" | "explanations" | (string & {});
interface ModelPricing {
    readonly inputPerMillionTokens?: number;
    readonly outputPerMillionTokens?: number;
}
interface ModelLimits {
    readonly contextTokens?: number;
    readonly outputTokens?: number;
}
interface ModelCapability {
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
interface TaskConstraints {
    readonly maxCostUsd?: number;
    readonly maxLatencyClass?: LatencyClass;
    readonly allowedProviderIds?: readonly string[];
    readonly deniedProviderIds?: readonly string[];
    readonly preferredProviderIds?: readonly string[];
    readonly allowFallbacks?: boolean;
}
/** An image attached to a multimodal request. */
interface ImageInput {
    /** Base64 data, a `data:` URL, or a remote URL. */
    readonly data: string;
    /** e.g. `"image/png"` — recommended for base64/data URLs. */
    readonly mediaType?: string;
}
/** A string (URL or `data:` URL) or a structured {@link ImageInput}. */
type ImagePart = string | ImageInput;
interface TaskRequest<Input = unknown> {
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
interface GenerateObjectRequest<Input = unknown> extends TaskRequest<Input> {
    readonly schema?: unknown;
    readonly prompt?: string;
    readonly metadata?: Record<string, unknown>;
}
interface ProviderGenerateObjectRequest<Input = unknown> extends GenerateObjectRequest<Input> {
    readonly model: ModelCapability;
}
interface GenerateTextRequest<Input = unknown> extends TaskRequest<Input> {
    readonly prompt: string;
    readonly metadata?: Record<string, unknown>;
}
interface ProviderGenerateTextRequest<Input = unknown> extends GenerateTextRequest<Input> {
    readonly model: ModelCapability;
}
/** A generated image, returned by an adapter's `generateImage`. */
interface GeneratedImage {
    readonly base64: string;
    readonly mediaType: string;
}
interface GenerateImageRequest<Input = unknown> extends TaskRequest<Input> {
    readonly prompt?: string;
    readonly metadata?: Record<string, unknown>;
}
interface ProviderGenerateImageRequest<Input = unknown> extends GenerateImageRequest<Input> {
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
interface GenerateRequest<Input = unknown> extends TaskRequest<Input> {
    readonly prompt?: string;
    readonly schema?: unknown;
    readonly metadata?: Record<string, unknown>;
}
interface ProviderAdapter {
    readonly providerId: string;
    readonly name?: string;
    isAvailable?(): boolean;
    generateObject?<Input, Output>(request: ProviderGenerateObjectRequest<Input>): Promise<Output>;
    generateText?<Input>(request: ProviderGenerateTextRequest<Input>): Promise<string>;
    generateImage?<Input>(request: ProviderGenerateImageRequest<Input>): Promise<GeneratedImage>;
    /**
     * Score the documents in `request` by relevance to `request.query`. Return a
     * score per document (by original index); include `reason` only if the model
     * produces rationales (and declares the `"explanations"` feature). The router
     * attaches the document text, sorts by score, and applies `topK`.
     */
    rerank?<Input>(request: ProviderRerankRequest<Input>): Promise<readonly RerankScore[]>;
}
interface CapabilityCatalog {
    listCapabilities(): Promise<readonly ModelCapability[]>;
}
interface RejectedModel {
    readonly providerId: string;
    readonly modelId: string;
    readonly reason: string;
}
interface RankedModel {
    readonly capability: ModelCapability;
    readonly score: number;
    readonly reason: string;
    readonly estimatedCostUsd?: number;
}
interface RoutePlan {
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
interface RouterAttempt {
    readonly providerId: string;
    readonly modelId: string;
    readonly ok: boolean;
    readonly error?: string;
}
interface RouterRunResult<Output> {
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
interface RerankRequest<Input = unknown> {
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
interface ProviderRerankRequest<Input = unknown> extends RerankRequest<Input> {
    readonly model: ModelCapability;
}
/** A relevance score for one input document, by its original index. */
interface RerankScore {
    readonly index: number;
    readonly score: number;
    /** Natural-language rationale — only from reason-capable (`"explanations"`) rerankers. */
    readonly reason?: string;
}
interface RerankedDocument extends RerankScore {
    /** The document text at `index`, attached by the router for convenience. */
    readonly document: string;
}
interface RerankResult {
    /** Documents sorted by descending relevance, capped at `topK`. */
    readonly results: readonly RerankedDocument[];
    readonly model: ModelCapability;
    readonly plan: RoutePlan;
    readonly attempts: readonly RouterAttempt[];
}
interface RoutingPolicyContext {
    readonly request: TaskRequest;
    readonly candidates: readonly RankedModel[];
}
type RoutingPolicy = (context: RoutingPolicyContext) => readonly RankedModel[] | Promise<readonly RankedModel[]>;
declare class ModelRouterError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
/**
 * Thrown when a model's structured output does not conform to the requested
 * JSON Schema. The router treats this like any other failed attempt, so it
 * falls through to the next routed model rather than returning a bad object.
 */
declare class SchemaValidationError extends ModelRouterError {
    readonly modelId: string;
    readonly issues: readonly string[];
    constructor(modelId: string, issues: readonly string[]);
}

declare class StaticCapabilityCatalog implements CapabilityCatalog {
    private readonly capabilities;
    constructor(capabilities: readonly ModelCapability[]);
    listCapabilities(): Promise<readonly ModelCapability[]>;
}
declare const createStaticCapabilityCatalog: (capabilities: readonly ModelCapability[]) => CapabilityCatalog;
/**
 * Build a catalog from any loader — a database query, an internal API, a cached
 * file. This is the bring-your-own-source seam: opt out of models.dev entirely
 * while still producing the canonical `ModelCapability` shape the router expects.
 * The loader may be sync or async; failures become a `ModelRouterError`.
 *
 * If your rows are already in models.dev's JSON shape, run them through
 * `normalizeModelsDevCatalog` inside the loader to map them to `ModelCapability`.
 */
declare const createCapabilityCatalog: (load: () => Promise<readonly ModelCapability[]> | readonly ModelCapability[]) => CapabilityCatalog;
/**
 * Scope any catalog down to the models you can actually use, declared once at
 * construction rather than per request. Pull full configs from a broad catalog
 * (e.g. models.dev) and intersect it with what you have access to.
 *
 * `filter` is either a predicate, or an allowlist of `"providerId/modelId"`
 * keys (a bare `"modelId"` matches across providers). The filter runs on every
 * `listCapabilities()` call, so a predicate that reads live state stays current.
 */
declare const filterCapabilityCatalog: (catalog: CapabilityCatalog, filter: ((capability: ModelCapability) => boolean) | readonly string[]) => CapabilityCatalog;
/**
 * A partial enrichment for one model, keyed by `providerId` + `modelId`. Use it
 * to add capabilities a base catalog omits — e.g. tagging `web_search`, or
 * supplying `latencyClass` / `qualityScore`, which models.dev does not carry.
 */
type CapabilityOverride = Partial<Omit<ModelCapability, "providerId" | "modelId">> & Pick<ModelCapability, "providerId" | "modelId">;
/**
 * Enrich a base capability list with overrides matched on `providerId/modelId`.
 * `features` are unioned; `limits` and `pricing` are shallow-merged; other
 * fields replace. Overrides with no matching base model are ignored (to add a
 * net-new model, concatenate it into the base array instead).
 */
declare const mergeCapabilities: (base: readonly ModelCapability[], overrides: readonly CapabilityOverride[]) => readonly ModelCapability[];
declare class ModelsDevCapabilityCatalog implements CapabilityCatalog {
    private readonly url;
    private readonly fetcher;
    constructor(url?: string, fetcher?: typeof fetch);
    listCapabilities(): Promise<readonly ModelCapability[]>;
}
declare const normalizeModelsDevCatalog: (catalog: unknown) => readonly ModelCapability[];

interface ByBenchmarkOptions {
    /** Drop candidates scoring below this (and any with no score). */
    readonly minimum?: number;
}
/** A score map keyed by `"providerId/modelId"` or bare `modelId`. */
type BenchmarkScores = Readonly<Record<string, number>>;
/**
 * Where benchmark scores come from:
 *   - a string  — key into `capability.benchmarks[key]`
 *   - a function — compute/blend a score from the capability (can read live state)
 *   - `{ resolve }` — a refreshable/async source, resolved once per plan, then
 *     looked up by `"providerId/modelId"` (or bare `modelId`). Use this for live
 *     leaderboards (e.g. an Elo feed) that aren't baked into the catalog.
 */
type BenchmarkSource = string | ((capability: ModelCapability) => number | undefined) | {
    readonly resolve: () => BenchmarkScores | Promise<BenchmarkScores>;
};
/**
 * Rank candidates by a benchmark — highest first.
 *
 *     byBenchmark("swe_bench")
 *     byBenchmark((c) => 0.7 * (c.benchmarks?.swe_bench ?? 0) + 0.3 * (c.benchmarks?.gpqa ?? 0))
 *     byBenchmark({ resolve: () => fetchLiveElo() })   // refreshable, not in the catalog
 *
 * Pass it as a request `preference`. Candidates with no score sort last (and are
 * dropped entirely when `minimum` is set).
 */
declare const byBenchmark: (source: BenchmarkSource, options?: ByBenchmarkOptions) => RoutingPolicy;
/**
 * Pin one or more models to the front of the ranking, in the given order — the
 * fallback-band pattern. Any candidates not in `ids` follow, ranked by `base`
 * (or left in catalog order). Ids are `"providerId/modelId"` or bare `modelId`.
 *
 *     preference: pin("openai/gpt-5")                       // prefer one, else fall through
 *     preference: pin(["openai/gpt-5", "xai/grok-4.3"])     // primary, then a fallback band
 */
declare const pin: (ids: string | readonly string[], base?: RoutingPolicy) => RoutingPolicy;
/**
 * Cap selection at a quality ceiling — the "good enough, don't overpay" pattern.
 * Keeps only candidates with `qualityScore <= max` (or all, if none qualify),
 * then ranks them by `base` (default: highest quality under the cap).
 */
declare const qualityCap: (max: number, base?: RoutingPolicy) => RoutingPolicy;
declare const estimatedCostUsd: (capability: ModelCapability, inputTokens: number, outputTokens: number) => number | undefined;
declare const qualityScore: (capability: ModelCapability) => number;
declare const namedPolicy: (preference: RoutingPreference, preferredProviderIds?: readonly string[]) => RoutingPolicy;

type LoadBalanceStrategy = "round-robin" | "random";
interface LoadBalanceOptions {
    /** Rotate selection among the top N candidates. Defaults to all of them. */
    readonly across?: number;
    /** How to pick within the top N each call. Defaults to `"round-robin"`. */
    readonly strategy?: LoadBalanceStrategy;
}
/**
 * Spread requests across the top-N candidates instead of always selecting #1 —
 * e.g. "cheapest, but cycle through the two cheapest providers." Wraps a base
 * preference or policy: it ranks first, then this rotates which of the top
 * `across` is selected on each call. The remaining candidates stay as ordered
 * fallbacks, so failover still works.
 *
 * Stateful by design — the returned policy holds a round-robin cursor, so reuse
 * one instance across requests rather than creating it per call.
 *
 *     const router = new ModelRouter({ catalog, providers });
 *     const balanced = loadBalance("cheapest", { across: 2 });
 *     await router.run({ ...request, preference: balanced }); // 1st of the two cheapest
 *     await router.run({ ...request, preference: balanced }); // 2nd of the two cheapest
 */
declare const loadBalance: (base: RoutingPreference | RoutingPolicy, options?: LoadBalanceOptions) => RoutingPolicy;
/**
 * A round-robin iterator over a fixed list — returns the next item each call,
 * wrapping around. Handy for rotating API keys (or endpoints, accounts) within
 * a single provider adapter to spread rate limits:
 *
 *     const nextKey = roundRobin([process.env.OPENAI_KEY_A!, process.env.OPENAI_KEY_B!]);
 *     createCallbackProviderAdapter({
 *       providerId: "openai",
 *       generateObject: ({ prompt, model }) => callOpenAI(prompt, model.modelId, nextKey()),
 *     });
 */
declare const roundRobin: <T>(items: readonly T[]) => (() => T);

interface ModelRouterOptions {
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
declare class ModelRouter {
    private readonly options;
    private readonly providers;
    constructor(options: ModelRouterOptions);
    plan<Input>(request: TaskRequest<Input>): Promise<RoutePlan>;
    /** Shared tail of {@link plan} / {@link planRerank}: rank the surviving
     *  candidates by preference (or a custom policy) and assemble the RoutePlan. */
    private finalizePlan;
    /**
     * Plan a rerank: filter the catalog to reranker models (a `rerank` capability
     * + an adapter that implements `rerank`) satisfying `requiresFeatures` (e.g.
     * `["explanations"]`) and constraints, then rank by preference. Inspectable
     * like {@link plan} — every rejected model carries a reason.
     */
    planRerank<Input>(request: RerankRequest<Input>): Promise<RoutePlan>;
    /**
     * Rerank `request.documents` by relevance to `request.query`, routing to the
     * best reranker and falling back automatically. The result's documents are
     * sorted by descending score and capped at `topK`; `reason` is populated only
     * when the chosen reranker supports `"explanations"`.
     */
    rerank<Input>(request: RerankRequest<Input>): Promise<RerankResult>;
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
    generate<Input, Output>(request: GenerateRequest<Input>): Promise<RouterRunResult<Output>>;
    /**
     * Call an adapter's `generateObject` and, unless disabled, validate the
     * result against the request's JSON Schema. A non-conforming object throws a
     * {@link SchemaValidationError}, which `executePlan` records as a failed
     * attempt — so the router falls through to the next routed model.
     */
    private generateValidatedObject;
    /** @deprecated Use {@link generate} — it infers structured output from a
     *  `schema` in the request. `run` remains as a thin alias. */
    run<Input, Output>(request: GenerateObjectRequest<Input>): Promise<RouterRunResult<Output>>;
    /** @deprecated Use {@link generate} — text is the default when no `schema`
     *  or image modality is requested. */
    runText<Input>(request: GenerateTextRequest<Input>): Promise<RouterRunResult<string>>;
    /** @deprecated Use `(await generate(req)).output`. */
    generateObject<Input, Output>(request: GenerateObjectRequest<Input>): Promise<Output>;
    /** @deprecated Use `(await generate(req)).output`. */
    generateText<Input>(request: GenerateTextRequest<Input>): Promise<string>;
    private executePlan;
}

interface LlmRerankerOptions {
    /**
     * A structured-output call to an LLM: given a `prompt` and a JSON `schema`,
     * return the parsed object (AI-SDK-style `{ object }` wrappers are unwrapped).
     */
    readonly generateObject: (args: {
        prompt: string;
        schema: unknown;
    }) => Promise<unknown> | unknown;
    /** Override the prompt (e.g. to inject ranking criteria). */
    readonly prompt?: (query: string, documents: readonly string[]) => string;
    /** Ask for a one-line reason per result (default: true → declares "explanations"). */
    readonly explanations?: boolean;
}
/**
 * Turn a structured-output (`generateObject`) call into a rerank callback: it
 * asks the model to order the documents — with optional per-result reasons — and
 * maps that ordering to descending scores (unranked documents score 0). Use it
 * as the `rerank` of a callback adapter so any LLM serves reranking; declare the
 * `"explanations"` feature on its catalog entry when reasons are on (the default)
 * so `requiresFeatures: ["explanations"]` routes to it.
 *
 *     createCallbackProviderAdapter({
 *       providerId: "openai",
 *       rerank: llmReranker({ generateObject: ({ prompt, schema }) => ai.generateObject({ model, prompt, schema }) }),
 *     })
 */
declare const llmReranker: (options: LlmRerankerOptions) => (request: ProviderRerankRequest) => Promise<readonly RerankScore[]>;

/**
 * A tiny, dependency-free validator for the common subset of JSON Schema that
 * structured-output requests use. It is intentionally NOT a full JSON Schema
 * implementation — it covers what models are actually constrained to produce
 * (types, properties, required, enums, items, composition) so the router can
 * honor its "schema-validated object" contract without pulling in a heavy
 * dependency or coupling to any one schema library.
 *
 * Anything it doesn't recognize is treated permissively (no false negatives):
 * unknown keywords, boolean sub-schemas, and non-JSON-Schema values (e.g. a Zod
 * schema, which the adapter validates itself) simply pass.
 */
/**
 * Does `schema` look like a JSON Schema we can validate against? Used so the
 * router only enforces validation when given an actual JSON Schema, leaving
 * other schema representations (Zod, etc.) to the adapter.
 */
declare const looksLikeJsonSchema: (schema: unknown) => schema is Record<string, unknown>;
/**
 * Validate `value` against a JSON Schema. Returns a list of human-readable
 * issues (with dotted paths); an empty array means the value conforms.
 */
declare const validateAgainstJsonSchema: (value: unknown, schema: unknown) => string[];

interface CallbackProviderOptions {
    readonly providerId: string;
    readonly name?: string;
    readonly isAvailable?: () => boolean;
    readonly generateObject?: (request: ProviderGenerateObjectRequest) => unknown;
    readonly generateText?: (request: ProviderGenerateTextRequest) => Promise<string> | string;
    readonly generateImage?: (request: ProviderGenerateImageRequest) => Promise<GeneratedImage> | GeneratedImage;
    readonly rerank?: (request: ProviderRerankRequest) => Promise<readonly RerankScore[]> | readonly RerankScore[];
}
declare const createCallbackProviderAdapter: (options: CallbackProviderOptions) => ProviderAdapter;

/**
 * Conventional environment-variable names that hold each provider's API key,
 * keyed by the provider id used in capability catalogs (matching models.dev).
 * Several providers accept more than one conventional name; the first present
 * one counts. Extend or override this map for providers not listed here.
 */
declare const apiKeyEnvVars: Record<string, readonly string[]>;
interface HasApiKeyOptions {
    /** Environment source. Defaults to `process.env` (or `{}` where unavailable). */
    readonly env?: Record<string, string | undefined>;
    /** Override the env-var name(s) to check for this provider. */
    readonly vars?: readonly string[];
}
/**
 * The env-var name(s) checked for a provider. Falls back to a derived
 * `<PROVIDER>_API_KEY` name for providers not in {@link apiKeyEnvVars}
 * (e.g. `"gemini"` → `"GEMINI_API_KEY"`).
 */
declare const apiKeyEnvVarsFor: (providerId: string) => readonly string[];
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
declare const hasApiKey: (providerId: string, options?: HasApiKeyOptions) => boolean;

export { type BenchmarkScores, type BenchmarkSource, type ByBenchmarkOptions, type CallbackProviderOptions, type CapabilityCatalog, type CapabilityOverride, type GenerateImageRequest, type GenerateObjectRequest, type GenerateRequest, type GenerateTextRequest, type GeneratedImage, type HasApiKeyOptions, type ImageInput, type ImagePart, type LatencyClass, type LlmRerankerOptions, type LoadBalanceOptions, type LoadBalanceStrategy, type ModelCapability, type ModelFeature, type ModelLimits, type ModelModality, type ModelPricing, ModelRouter, ModelRouterError, type ModelRouterOptions, ModelsDevCapabilityCatalog, type ProviderAdapter, type ProviderGenerateImageRequest, type ProviderGenerateObjectRequest, type ProviderGenerateTextRequest, type ProviderRerankRequest, type RankedModel, type RejectedModel, type RerankRequest, type RerankResult, type RerankScore, type RerankedDocument, type RoutePlan, type RouterAttempt, type RouterRunResult, type RoutingPolicy, type RoutingPolicyContext, type RoutingPreference, SchemaValidationError, StaticCapabilityCatalog, type TaskConstraints, type TaskRequest, apiKeyEnvVars, apiKeyEnvVarsFor, byBenchmark, createCallbackProviderAdapter, createCapabilityCatalog, createStaticCapabilityCatalog, estimatedCostUsd, filterCapabilityCatalog, hasApiKey, llmReranker, loadBalance, looksLikeJsonSchema, mergeCapabilities, namedPolicy, normalizeModelsDevCatalog, pin, qualityCap, qualityScore, roundRobin, validateAgainstJsonSchema };
