# @swoosh-dev/router

> Zero-dependency core: intent + policy routing, inspectable plans, automatic fallback.

`npm install @swoosh-dev/router` · [source](https://github.com/acalejos/swoosh/tree/main/packages/model-router)

# swoosh — just give me a model

```sh
npm install @swoosh-dev/router
```

Intent-driven, policy-driven model routing. Describe **what** a task needs — modalities, structured output, tools, token estimates — and **how** to choose — cheapest, fastest, best quality, or a custom policy — and the router plans the best model, explains every rejection, and executes with automatic fallback.

Zero runtime dependencies — plain Promises, no framework to adopt. Provider-agnostic: bring any provider via a small adapter, or plug in the [Vercel AI SDK](https://sdk.vercel.ai).

## Packages

The core router has zero runtime dependencies. Provider integrations that pull in third-party SDKs live in their own packages so the core stays light.

| Package | Install | Contents |
| --- | --- | --- |
| [`@swoosh-dev/sdk`](../sdk) | `npm i @swoosh-dev/sdk ai @ai-sdk/openai` | **Batteries-included drop-in** — `createRouter()` with the enriched catalog and providers auto-wired from your API keys. Re-exports everything. |
| [`@swoosh-dev/router`](.) | `npm i @swoosh-dev/router` | Router engine, capability catalogs, policies, callback adapter |
| [`@swoosh-dev/ai-sdk`](../ai-sdk) | `npm i @swoosh-dev/ai-sdk ai` | Vercel AI SDK provider adapter (`ai` is a peer dependency) |
| [`@swoosh-dev/capabilities`](../capabilities) | `npm i @swoosh-dev/capabilities` | Curated, enriched model dataset + `defaultCatalog()` (models.dev ∪ web_search / latency / quality / benchmarks) |
| [`@swoosh-dev/judge`](../judge) | `npm i @swoosh-dev/judge` | Dynamic policies — classify the prompt with an LLM judge, route by the verdict |

## Why

Hard-coding `model: "gpt-..."` couples your application to one provider's naming, pricing, and outages. This router inverts that:

- **Intent, not model IDs.** Requests declare requirements (`inputModalities: ["text", "image"]`, `requiresFeatures: ["structured_output"]`), and the router finds models that satisfy them.
- **Policy, not hope.** Constraints (`maxCostUsd`, `maxLatencyClass`, provider allow/deny lists) are enforced at planning time, with a per-model rejection reason you can log or display.
- **Plans are inspectable.** `plan()` returns the selected model, ranked fallbacks, every rejected candidate with its reason, and a cost estimate — before anything is executed.
- **Execution falls back automatically.** `run()` / `runText()` walk the ranked routes until one succeeds, recording each attempt.

## Quick start

```ts
import { ModelRouter, ModelsDevCapabilityCatalog } from "@swoosh-dev/router";
import { createAiSdkProviderAdapter } from "@swoosh-dev/ai-sdk";
import { google } from "@ai-sdk/google";
import { generateObject } from "ai";

const router = new ModelRouter({
  // Live capability/pricing metadata from models.dev (or use createStaticCapabilityCatalog).
  catalog: new ModelsDevCapabilityCatalog(),
  providers: [
    createAiSdkProviderAdapter({
      providerId: "google",
      models: { "gemini-2.5-flash": google("gemini-2.5-flash") },
      generateObject: (request) => generateObject(request as never),
    }),
  ],
  defaultPreference: "balanced",
});

const recipe = await router.generateObject({
  task: "recipe.extract",
  input: pageText,
  prompt: "Extract the recipe from this page.",
  inputModalities: ["text"],
  requiresFeatures: ["structured_output"],
  preference: "cheapest",
  constraints: { maxCostUsd: 0.01 },
});
```

## Planning without executing

```ts
const plan = await router.plan({
  task: "video.summarize",
  input: videoUrl,
  inputModalities: ["video"],
  estimatedInputTokens: 120_000,
  preference: "fastest",
  constraints: { deniedProviderIds: ["openai"], maxLatencyClass: "standard" },
});

plan.selected;  // { capability, score, reason, estimatedCostUsd }
plan.fallbacks; // ranked alternates, tried in order on failure
plan.rejected;  // [{ providerId, modelId, reason: "Estimated cost exceeds policy." }, ...]
plan.estimate;  // { inputTokens, outputTokens, costUsd }
```

## Custom routing policies

A policy is just a function from ranked candidates to ranked candidates — pass it as the `preference`:

```ts
import type { RoutingPolicy } from "@swoosh-dev/router";

const euOnlyThenCheapest: RoutingPolicy = ({ candidates }) =>
  candidates
    .filter((candidate) => EU_PROVIDERS.has(candidate.capability.providerId))
    .sort((a, b) => (a.estimatedCostUsd ?? Infinity) - (b.estimatedCostUsd ?? Infinity));
```

Policies can be **async**, which unlocks dynamic routing — e.g. classifying the prompt with an LLM judge before choosing (see [`@swoosh-dev/judge`](../judge)). And `byBenchmark` ranks on benchmark scores, by a single name or a composite scoring function:

```ts
import { byBenchmark } from "@swoosh-dev/router";

preference: byBenchmark("swe_bench", { minimum: 0.5 });
preference: byBenchmark((m) => 0.7 * (m.benchmarks?.swe_bench ?? 0) + 0.3 * (m.benchmarks?.gpqa ?? 0));
```

## Provider adapters

Adapters are tiny — implement `generateObject` and/or `generateText` against your client of choice:

```ts
import { createCallbackProviderAdapter } from "@swoosh-dev/router";

const anthropic = createCallbackProviderAdapter({
  providerId: "anthropic",
  isAvailable: () => Boolean(process.env.ANTHROPIC_API_KEY),
  generateText: async ({ model, prompt }) => callClaude(model.modelId, prompt),
});
```

## Capability catalogs

`ModelCapability` is the canonical schema the router reads — the "columns" your source populates. models.dev is just one built-in source; opt out entirely and bring your own via `createCapabilityCatalog`, which wraps any sync/async loader (a DB query, an internal API, a cached file):

```ts
import { createCapabilityCatalog, normalizeModelsDevCatalog } from "@swoosh-dev/router";

// Map your own rows onto the ModelCapability shape.
const catalog = createCapabilityCatalog(async () => {
  const rows = await db.select().from(models);
  return rows.map(toModelCapability);
});

// Or, if your rows are already in models.dev's JSON shape, reuse the normalizer:
const cached = createCapabilityCatalog(() => normalizeModelsDevCatalog(cachedJson));
```

`createStaticCapabilityCatalog` (fixed array) and `ModelsDevCapabilityCatalog` (live fetch) are the other two built-ins — all three satisfy the same `CapabilityCatalog` interface.

### Scoping to the models you can access

A catalog lists the *universe* of models; you rarely have access to all of them. Declare what you can actually use **once, at construction** — the config still comes from the catalog, you only name the ids. `filterCapabilityCatalog` wraps any catalog with an allowlist or a predicate:

```ts
import { ModelsDevCapabilityCatalog, filterCapabilityCatalog } from "@swoosh-dev/router";

// Allowlist exact models (a bare modelId matches across providers):
const catalog = filterCapabilityCatalog(new ModelsDevCapabilityCatalog(), [
  "openai/gpt-4o",
  "anthropic/claude-haiku-4-5",
]);

// Or a predicate, re-evaluated each plan — read live entitlements:
const scoped = filterCapabilityCatalog(new ModelsDevCapabilityCatalog(), (m) =>
  tenant.enabledModels.has(`${m.providerId}/${m.modelId}`),
);
```

You have five composable options — provider keys via adapter `isAvailable()` (use `hasApiKey("openai")`, which checks the conventional env vars like `OPENAI_API_KEY` / `GEMINI_API_KEY`), an allowlist, a predicate, a bring-your-own-DB catalog, or live discovery from a provider's list-models endpoint. See [Model access in the docs](site/docs.html) for all five.

## Examples

The [examples directory](examples/README.md) has eleven runnable scripts — quickstart, cost guardrails, multimodal routing, custom policy, outage fallback, bring-your-own-catalog, model access, web search, load balancing, benchmark routing, and an LLM judge. All of them run offline with simulated providers:

```sh
bun packages/model-router/examples/01-quickstart.ts
```

## Module map

| Module | Contents |
| --- | --- |
| `types` | Request/plan/capability types, `ModelRouterError` |
| `catalog` | `createCapabilityCatalog` (bring your own DB/API), `filterCapabilityCatalog` (scope to accessible models), `mergeCapabilities` (enrich with overrides), `createStaticCapabilityCatalog`, `ModelsDevCapabilityCatalog`, `normalizeModelsDevCatalog` |
| `policy` | Built-in preference policies, `byBenchmark` (rank by a benchmark or composite score), cost estimation, quality scoring |
| `balance` | `loadBalance` (rotate across the top-N providers), `roundRobin` (rotate keys within a provider) |
| `router` | `ModelRouter` — `plan`, `run`, `runText`, `generateObject`, `generateText` |
| `adapters` | `createCallbackProviderAdapter` |
| `env` | `hasApiKey`, `apiKeyEnvVars`, `apiKeyEnvVarsFor` — detect provider keys from the environment |

Everything is re-exported from the package root.

## Type definitions

Generated from source — the authoritative public API.

```ts
type ModelModality = "text" | "image" | "audio" | "video" | "pdf" | "file";
type RoutingPreference = "cheapest" | "fastest" | "best_quality" | "balanced";
type LatencyClass = "fast" | "standard" | "slow";
/**
 * A capability a model has beyond its input/output modalities. The well-known
 * values are typed for autocomplete, but the set is open — providers and
 * catalogs may surface their own (e.g. "prompt_caching", "json_mode").
 */
type ModelFeature = "structured_output" | "tools" | "reasoning" | "attachments" | "web_search" | (string & {});
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
}
interface TaskConstraints {
    readonly maxCostUsd?: number;
    readonly maxLatencyClass?: LatencyClass;
    readonly allowedProviderIds?: readonly string[];
    readonly deniedProviderIds?: readonly string[];
    readonly preferredProviderIds?: readonly string[];
    readonly allowFallbacks?: boolean;
}
interface TaskRequest<Input = unknown> {
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
interface ProviderAdapter {
    readonly providerId: string;
    readonly name?: string;
    isAvailable?(): boolean;
    generateObject?<Input, Output>(request: ProviderGenerateObjectRequest<Input>): Promise<Output>;
    generateText?<Input>(request: ProviderGenerateTextRequest<Input>): Promise<string>;
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
interface RoutingPolicyContext {
    readonly request: TaskRequest;
    readonly candidates: readonly RankedModel[];
}
type RoutingPolicy = (context: RoutingPolicyContext) => readonly RankedModel[] | Promise<readonly RankedModel[]>;
declare class ModelRouterError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
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
/**
 * Rank candidates by a benchmark — highest first. `scorer` is either a benchmark
 * key (read from `capability.benchmarks[key]`) or a function that computes a
 * score from the capability, so you can blend several benchmarks:
 *
 *     byBenchmark("swe_bench")
 *     byBenchmark((c) => 0.7 * (c.benchmarks?.swe_bench ?? 0) + 0.3 * (c.benchmarks?.gpqa ?? 0))
 *
 * Pass it as a request `preference`. Candidates with no score sort last (and are
 * dropped entirely when `minimum` is set).
 */
declare const byBenchmark: (scorer: string | ((capability: ModelCapability) => number | undefined), options?: ByBenchmarkOptions) => RoutingPolicy;
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
}
declare class ModelRouter {
    private readonly options;
    private readonly providers;
    constructor(options: ModelRouterOptions);
    plan<Input>(request: TaskRequest<Input>): Promise<RoutePlan>;
    run<Input, Output>(request: GenerateObjectRequest<Input>): Promise<RouterRunResult<Output>>;
    runText<Input>(request: GenerateTextRequest<Input>): Promise<RouterRunResult<string>>;
    generateObject<Input, Output>(request: GenerateObjectRequest<Input>): Promise<Output>;
    generateText<Input>(request: GenerateTextRequest<Input>): Promise<string>;
    private executePlan;
}

interface CallbackProviderOptions {
    readonly providerId: string;
    readonly name?: string;
    readonly isAvailable?: () => boolean;
    readonly generateObject?: (request: ProviderGenerateObjectRequest) => unknown;
    readonly generateText?: (request: ProviderGenerateTextRequest) => Promise<string> | string;
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

export { type ByBenchmarkOptions, type CallbackProviderOptions, type CapabilityCatalog, type CapabilityOverride, type GenerateObjectRequest, type GenerateTextRequest, type HasApiKeyOptions, type LatencyClass, type LoadBalanceOptions, type LoadBalanceStrategy, type ModelCapability, type ModelFeature, type ModelLimits, type ModelModality, type ModelPricing, ModelRouter, ModelRouterError, type ModelRouterOptions, ModelsDevCapabilityCatalog, type ProviderAdapter, type ProviderGenerateObjectRequest, type ProviderGenerateTextRequest, type RankedModel, type RejectedModel, type RoutePlan, type RouterAttempt, type RouterRunResult, type RoutingPolicy, type RoutingPolicyContext, type RoutingPreference, StaticCapabilityCatalog, type TaskConstraints, type TaskRequest, apiKeyEnvVars, apiKeyEnvVarsFor, byBenchmark, createCallbackProviderAdapter, createCapabilityCatalog, createStaticCapabilityCatalog, estimatedCostUsd, filterCapabilityCatalog, hasApiKey, loadBalance, mergeCapabilities, namedPolicy, normalizeModelsDevCatalog, qualityScore, roundRobin };
```
