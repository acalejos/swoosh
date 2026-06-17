# @swoosh-dev/testing

> Test utilities: fake catalogs, recording mock providers, and a fluent plan-assertion chain.

`npm install @swoosh-dev/testing` · [source](https://github.com/acalejos/swoosh/tree/main/packages/testing)

# @swoosh-dev/testing

Test utilities for [`@swoosh-dev/router`](../model-router) — exercise your catalog, policies, and routing config **without hitting real providers**. Framework-agnostic: assertions just throw, so it works in `bun:test`, Vitest, Jest, or `node:test`.

```sh
npm i -D @swoosh-dev/testing
```

## Fixtures + mocks

```ts
import { model, mockProvider, routerForTest, failAlways } from "@swoosh-dev/testing";

const router = routerForTest({
  models: [
    model("openai/gpt-5", { features: ["tools"], pricing: { input: 5, output: 15 }, qualityScore: 0.9 }),
    model("google/gemini-2.5-flash", { inputModalities: ["text", "image"], pricing: { input: 0.1 } }),
  ],
  providers: [
    mockProvider("openai", { generateObject: () => ({ category: "billing" }) }),
    mockProvider("google", { generateText: () => "hi" }),
  ],
});
```

- **`model("provider/id", opts)`** — a fake `ModelCapability`; everything unspecified gets a sensible default.
- **`fakeCatalog(models)`** — a static catalog over those models.
- **`mockProvider(id, handlers)`** — a programmable provider adapter that **records every call** (`provider.calls`, `provider.callCount()`). Handlers are a value or a function of the request.
- **`failAlways()`** (provider is down → drives fallback), **`failOnce(value)`** (transient), **`echo`** (returns the prompt).
- **`routerForTest({ models, providers })`** — a wired `ModelRouter`; its `.plan()` result also carries `.expects()`.

## Asserting on plans

A fluent, throwing chain — no matcher registration, works in any runner:

```ts
const plan = await router.plan({
  task: "support.triage",
  input: ticket,
  inputModalities: ["text"],
  requiresFeatures: ["structured_output"],
  preference: "cheapest",
  constraints: { maxCostUsd: 0.01 },
});

plan.expects()                               // or: expects(plan)
  .selects("google/gemini-2.5-flash")        // bare "gemini-2.5-flash" also matches
  .rejects("openai/gpt-5", /over budget/)    // in plan.rejected, with a matching reason
  .ranksBefore("google/gemini-2.5-flash", "openai/gpt-5")
  .costsUnder(0.01)
  .not.selects("openai/gpt-5");
```

Matchers: `selects` · `rejects(id, reason?)` · `ranksBefore(a, b)` · `fallsBackTo(id)` · `costsUnder(usd)`, each negatable via `.not`. Ids are `"provider/model"` (exact) or a bare `"model"` (matches across providers). Failures throw a `SwooshExpectError` whose message includes a `formatPlan(plan)` dump (also exported for snapshot tests).

## Testing fallback

```ts
import { routerForTest, model, mockProvider, failAlways } from "@swoosh-dev/testing";

const router = routerForTest({
  models: [model("openai/gpt-5", { qualityScore: 0.9 }), model("anthropic/claude-haiku-4-5", { qualityScore: 0.7 })],
  providers: [
    mockProvider("openai", { generateText: failAlways("503") }), // selected, but down
    mockProvider("anthropic", { generateText: () => "recovered" }),
  ],
});

const { output, attempts } = await router.runText({
  task: "t", input: "x", prompt: "hi", inputModalities: ["text"], preference: "best_quality",
});
// output === "recovered"; attempts records the failed openai try then the anthropic success
```

## License

[Apache-2.0](LICENSE) © Andres Alejos

## Type definitions

Generated from source — the authoritative public API.

```ts
import { ModelModality, ModelFeature, LatencyClass, RoutePlan, ProviderAdapter, ProviderGenerateObjectRequest, ProviderGenerateTextRequest, ProviderRerankRequest, RerankScore, ModelRouter, TaskRequest, ModelCapability, RoutingPreference, CapabilityCatalog } from '@swoosh-dev/router';

/** Friendly, defaulted options for {@link model} — specify only what the test cares about. */
interface FakeModelOptions {
    readonly providerName?: string;
    readonly modelName?: string;
    readonly inputModalities?: readonly ModelModality[];
    readonly outputModalities?: readonly ModelModality[];
    readonly features?: readonly ModelFeature[];
    /** Per-MILLION-token prices (matches ModelPricing, just terser). */
    readonly pricing?: {
        readonly input?: number;
        readonly output?: number;
    };
    readonly contextTokens?: number;
    readonly outputTokens?: number;
    readonly latencyClass?: LatencyClass;
    readonly qualityScore?: number;
    readonly benchmarks?: Readonly<Record<string, number>>;
    readonly releaseDate?: string;
}
/**
 * Build a fake {@link ModelCapability} from a `"provider/model"` id and a few
 * overrides. Everything unspecified gets a sensible default (text in/out, no
 * features, empty limits/pricing).
 *
 *     model("openai/gpt-5", { features: ["tools"], pricing: { input: 5, output: 15 }, qualityScore: 0.9 })
 */
declare function model(id: string, opts?: FakeModelOptions): ModelCapability;
/** A static {@link CapabilityCatalog} over the given fake models. */
declare function fakeCatalog(models: readonly ModelCapability[]): CapabilityCatalog;
interface RecordedCall {
    readonly method: "generateObject" | "generateText" | "rerank";
    readonly providerId: string;
    readonly modelId: string;
    readonly request: ProviderGenerateObjectRequest | ProviderGenerateTextRequest | ProviderRerankRequest;
}
type Handler<Req, Res> = Res | ((request: Req) => Res | Promise<Res>);
interface MockProviderOptions {
    readonly name?: string;
    readonly isAvailable?: boolean | (() => boolean);
    readonly generateObject?: Handler<ProviderGenerateObjectRequest, unknown>;
    readonly generateText?: Handler<ProviderGenerateTextRequest, string>;
    readonly rerank?: Handler<ProviderRerankRequest, readonly RerankScore[]>;
}
interface MockProvider extends ProviderAdapter {
    /** Every call the router made to this provider, in order. */
    readonly calls: readonly RecordedCall[];
    /** Number of calls (optionally for one method). */
    callCount(method?: RecordedCall["method"]): number;
    /** Clear the recorded calls. */
    reset(): void;
}
/**
 * A programmable, call-recording {@link ProviderAdapter}. Handlers can be a
 * literal value or a function of the request.
 *
 *     const openai = mockProvider("openai", { generateObject: () => ({ ok: true }) });
 *     const down   = mockProvider("anthropic", { generateText: failAlways() });
 *     // ... after a run: expect(openai.calls).toHaveLength(1)
 */
declare function mockProvider(providerId: string, opts?: MockProviderOptions): MockProvider;
/** Handler that always throws — model a provider that's down (drives fallback). */
declare const failAlways: (error?: Error | string) => () => never;
/** Handler that throws on its first call, then returns `value` — model a transient failure. */
declare function failOnce<T>(value: T, error?: Error | string): () => T;
/** generateText handler that returns the prompt back. */
declare const echo: (request: ProviderGenerateTextRequest) => string;
declare class SwooshExpectError extends Error {
    constructor(message: string);
}
/** Negated matchers returned by {@link PlanExpect.not}; each returns the positive chain. */
interface PlanMatchers {
    selects(id: string): PlanExpect;
    rejects(id: string, reason?: string | RegExp): PlanExpect;
    ranksBefore(a: string, b: string): PlanExpect;
    fallsBackTo(id: string): PlanExpect;
    costsUnder(usd: number): PlanExpect;
}
/** A fluent, chainable assertion over a {@link RoutePlan}. Throws on failure. */
declare class PlanExpect implements PlanMatchers {
    readonly plan: RoutePlan;
    constructor(plan: RoutePlan);
    private assert;
    private doSelects;
    private doRejects;
    private doRanksBefore;
    private doFallsBackTo;
    private doCostsUnder;
    selects(id: string): this;
    rejects(id: string, reason?: string | RegExp): this;
    ranksBefore(a: string, b: string): this;
    fallsBackTo(id: string): this;
    costsUnder(usd: number): this;
    /** Negate the next matcher: `expects(plan).not.selects("x")`. */
    get not(): PlanMatchers;
}
/** Start an assertion chain over a plan: `expects(plan).selects("openai/gpt-5")`. */
declare function expects(plan: RoutePlan): PlanExpect;
/** Stable, human-readable plan dump — handy for snapshot tests and failure messages. */
declare function formatPlan(plan: RoutePlan): string;
type InspectablePlan = RoutePlan & {
    expects(): PlanExpect;
};
interface TestRouterOptions {
    readonly models: readonly ModelCapability[];
    readonly providers: readonly ProviderAdapter[];
    readonly defaultPreference?: RoutingPreference;
    readonly validateStructuredOutput?: boolean;
}
interface TestRouter {
    /** The underlying router, if you need the full surface. */
    readonly router: ModelRouter;
    /** Like `router.plan`, but the returned plan also has `.expects()`. */
    plan<Input>(request: TaskRequest<Input>): Promise<InspectablePlan>;
    run: ModelRouter["run"];
    runText: ModelRouter["runText"];
    generate: ModelRouter["generate"];
    generateObject: ModelRouter["generateObject"];
    generateText: ModelRouter["generateText"];
}
/** Wire a {@link ModelRouter} over fake models + (mock) providers in one call. */
declare function routerForTest(opts: TestRouterOptions): TestRouter;

export { type FakeModelOptions, type InspectablePlan, type MockProvider, type MockProviderOptions, PlanExpect, type PlanMatchers, type RecordedCall, SwooshExpectError, type TestRouter, type TestRouterOptions, echo, expects, failAlways, failOnce, fakeCatalog, formatPlan, mockProvider, model, routerForTest };
```
