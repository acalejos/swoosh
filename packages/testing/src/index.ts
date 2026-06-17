// @swoosh-dev/testing — fixtures, mocks, and a fluent plan-assertion chain for
// testing swoosh routing without hitting real providers. Framework-agnostic:
// assertions just throw, so they work in bun:test, vitest, jest, node:test, etc.

import {
  ModelRouter,
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  type CapabilityCatalog,
  type LatencyClass,
  type ModelCapability,
  type ModelFeature,
  type ModelModality,
  type ProviderAdapter,
  type ProviderGenerateObjectRequest,
  type ProviderGenerateTextRequest,
  type ProviderRerankRequest,
  type RerankScore,
  type RoutePlan,
  type RoutingPreference,
  type TaskRequest,
} from "@swoosh-dev/router";

// ─────────────────────────────────────────────────────────── fixtures ──

/** Friendly, defaulted options for {@link model} — specify only what the test cares about. */
export interface FakeModelOptions {
  readonly providerName?: string;
  readonly modelName?: string;
  readonly inputModalities?: readonly ModelModality[];
  readonly outputModalities?: readonly ModelModality[];
  readonly features?: readonly ModelFeature[];
  /** Per-MILLION-token prices (matches ModelPricing, just terser). */
  readonly pricing?: { readonly input?: number; readonly output?: number };
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
export function model(id: string, opts: FakeModelOptions = {}): ModelCapability {
  const slash = id.indexOf("/");
  const providerId = slash === -1 ? id : id.slice(0, slash);
  const modelId = slash === -1 ? id : id.slice(slash + 1);
  return {
    providerId,
    providerName: opts.providerName ?? providerId,
    modelId,
    modelName: opts.modelName ?? modelId,
    inputModalities: opts.inputModalities ?? ["text"],
    outputModalities: opts.outputModalities ?? ["text"],
    features: opts.features ?? [],
    limits: { contextTokens: opts.contextTokens, outputTokens: opts.outputTokens },
    pricing: {
      inputPerMillionTokens: opts.pricing?.input,
      outputPerMillionTokens: opts.pricing?.output,
    },
    latencyClass: opts.latencyClass,
    qualityScore: opts.qualityScore,
    benchmarks: opts.benchmarks,
    releaseDate: opts.releaseDate,
  };
}

/** A static {@link CapabilityCatalog} over the given fake models. */
export function fakeCatalog(models: readonly ModelCapability[]): CapabilityCatalog {
  return createStaticCapabilityCatalog(models);
}

// ─────────────────────────────────────────────────────── mock providers ──

export interface RecordedCall {
  readonly method: "generateObject" | "generateText" | "rerank";
  readonly providerId: string;
  readonly modelId: string;
  readonly request:
    | ProviderGenerateObjectRequest
    | ProviderGenerateTextRequest
    | ProviderRerankRequest;
}

type Handler<Req, Res> = Res | ((request: Req) => Res | Promise<Res>);

export interface MockProviderOptions {
  readonly name?: string;
  readonly isAvailable?: boolean | (() => boolean);
  readonly generateObject?: Handler<ProviderGenerateObjectRequest, unknown>;
  readonly generateText?: Handler<ProviderGenerateTextRequest, string>;
  readonly rerank?: Handler<ProviderRerankRequest, readonly RerankScore[]>;
}

export interface MockProvider extends ProviderAdapter {
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
export function mockProvider(providerId: string, opts: MockProviderOptions = {}): MockProvider {
  const calls: RecordedCall[] = [];
  const record =
    <
      Req extends
        | ProviderGenerateObjectRequest
        | ProviderGenerateTextRequest
        | ProviderRerankRequest,
      Res,
    >(
      method: RecordedCall["method"],
      handler: Handler<Req, Res> | undefined,
    ) =>
      handler === undefined
        ? undefined
        : (request: Req) => {
            calls.push({ method, providerId: request.model.providerId, modelId: request.model.modelId, request });
            return typeof handler === "function"
              ? (handler as (r: Req) => Res | Promise<Res>)(request)
              : handler;
          };

  const base = createCallbackProviderAdapter({
    providerId,
    name: opts.name,
    isAvailable:
      opts.isAvailable === undefined
        ? undefined
        : typeof opts.isAvailable === "function"
          ? opts.isAvailable
          : () => opts.isAvailable as boolean,
    generateObject: record("generateObject", opts.generateObject),
    generateText: record("generateText", opts.generateText),
    rerank: record("rerank", opts.rerank),
  });

  return Object.assign(base, {
    calls,
    callCount: (method?: RecordedCall["method"]) =>
      method ? calls.filter((c) => c.method === method).length : calls.length,
    reset: () => {
      calls.length = 0;
    },
  });
}

/** Handler that always throws — model a provider that's down (drives fallback). */
export const failAlways =
  (error: Error | string = "mock provider failure") =>
  (): never => {
    throw typeof error === "string" ? new Error(error) : error;
  };

/** Handler that throws on its first call, then returns `value` — model a transient failure. */
export function failOnce<T>(value: T, error: Error | string = "transient mock failure"): () => T {
  let failed = false;
  return () => {
    if (!failed) {
      failed = true;
      throw typeof error === "string" ? new Error(error) : error;
    }
    return value;
  };
}

/** generateText handler that returns the prompt back. */
export const echo = (request: ProviderGenerateTextRequest): string => request.prompt;

// ──────────────────────────────────────────────────── plan assertions ──

export class SwooshExpectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwooshExpectError";
  }
}

const capId = (c: ModelCapability) => `${c.providerId}/${c.modelId}`;
// "provider/model" matches exactly; a bare "model" matches across providers.
const idMatches = (id: string, providerId: string, modelId: string) =>
  id.includes("/") ? id === `${providerId}/${modelId}` : id === modelId;
const reasonMatches = (actual: string, expected: string | RegExp) =>
  typeof expected === "string" ? actual.includes(expected) : expected.test(actual);

/** Negated matchers returned by {@link PlanExpect.not}; each returns the positive chain. */
export interface PlanMatchers {
  selects(id: string): PlanExpect;
  rejects(id: string, reason?: string | RegExp): PlanExpect;
  ranksBefore(a: string, b: string): PlanExpect;
  fallsBackTo(id: string): PlanExpect;
  costsUnder(usd: number): PlanExpect;
}

/** A fluent, chainable assertion over a {@link RoutePlan}. Throws on failure. */
export class PlanExpect implements PlanMatchers {
  constructor(readonly plan: RoutePlan) {}

  private assert(ok: boolean, negate: boolean, what: string): void {
    if (negate ? ok : !ok) {
      throw new SwooshExpectError(
        `${negate ? "Did not expect" : "Expected"} ${what}.\n\n${formatPlan(this.plan)}`,
      );
    }
  }

  private doSelects(id: string, negate: boolean): void {
    const s = this.plan.selected.capability;
    this.assert(idMatches(id, s.providerId, s.modelId), negate, `plan to select "${id}" (selected "${capId(s)}")`);
  }
  private doRejects(id: string, reason: string | RegExp | undefined, negate: boolean): void {
    const r = this.plan.rejected.find((x) => idMatches(id, x.providerId, x.modelId));
    const ok = !!r && (reason == null || reasonMatches(r.reason, reason));
    this.assert(ok, negate, reason == null ? `plan to reject "${id}"` : `plan to reject "${id}" with reason matching ${reason}`);
  }
  private doRanksBefore(a: string, b: string, negate: boolean): void {
    const order = [this.plan.selected, ...this.plan.fallbacks].map((r) => r.capability);
    const ia = order.findIndex((c) => idMatches(a, c.providerId, c.modelId));
    const ib = order.findIndex((c) => idMatches(b, c.providerId, c.modelId));
    this.assert(ia >= 0 && ib >= 0 && ia < ib, negate, `"${a}" to rank before "${b}"`);
  }
  private doFallsBackTo(id: string, negate: boolean): void {
    this.assert(
      this.plan.fallbacks.some((r) => idMatches(id, r.capability.providerId, r.capability.modelId)),
      negate,
      `plan to fall back to "${id}"`,
    );
  }
  private doCostsUnder(usd: number, negate: boolean): void {
    const cost = this.plan.estimate.costUsd ?? this.plan.selected.estimatedCostUsd;
    this.assert(cost != null && cost < usd, negate, `estimated cost under $${usd} (was ${cost == null ? "unknown" : "$" + cost})`);
  }

  selects(id: string): this {
    this.doSelects(id, false);
    return this;
  }
  rejects(id: string, reason?: string | RegExp): this {
    this.doRejects(id, reason, false);
    return this;
  }
  ranksBefore(a: string, b: string): this {
    this.doRanksBefore(a, b, false);
    return this;
  }
  fallsBackTo(id: string): this {
    this.doFallsBackTo(id, false);
    return this;
  }
  costsUnder(usd: number): this {
    this.doCostsUnder(usd, false);
    return this;
  }

  /** Negate the next matcher: `expects(plan).not.selects("x")`. */
  get not(): PlanMatchers {
    return {
      selects: (id) => (this.doSelects(id, true), this),
      rejects: (id, reason) => (this.doRejects(id, reason, true), this),
      ranksBefore: (a, b) => (this.doRanksBefore(a, b, true), this),
      fallsBackTo: (id) => (this.doFallsBackTo(id, true), this),
      costsUnder: (usd) => (this.doCostsUnder(usd, true), this),
    };
  }
}

/** Start an assertion chain over a plan: `expects(plan).selects("openai/gpt-5")`. */
export function expects(plan: RoutePlan): PlanExpect {
  return new PlanExpect(plan);
}

/** Stable, human-readable plan dump — handy for snapshot tests and failure messages. */
export function formatPlan(plan: RoutePlan): string {
  const lines = [
    `task: ${plan.task}   preference: ${plan.preference}`,
    `selected:  ${capId(plan.selected.capability)}  (score ${plan.selected.score}) — ${plan.selected.reason}`,
    `fallbacks: ${plan.fallbacks.map((f) => capId(f.capability)).join(", ") || "(none)"}`,
    `rejected:${plan.rejected.length ? "" : " (none)"}`,
    ...plan.rejected.map((r) => `  - ${r.providerId}/${r.modelId}: ${r.reason}`),
    `estimate:  ${plan.estimate.inputTokens}+${plan.estimate.outputTokens} tok${plan.estimate.costUsd != null ? `, ~$${plan.estimate.costUsd}` : ""}`,
  ];
  return lines.join("\n");
}

// ───────────────────────────────────────────────────────── test router ──

export type InspectablePlan = RoutePlan & { expects(): PlanExpect };

export interface TestRouterOptions {
  readonly models: readonly ModelCapability[];
  readonly providers: readonly ProviderAdapter[];
  readonly defaultPreference?: RoutingPreference;
  readonly validateStructuredOutput?: boolean;
}

export interface TestRouter {
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
export function routerForTest(opts: TestRouterOptions): TestRouter {
  const router = new ModelRouter({
    catalog: fakeCatalog(opts.models),
    providers: opts.providers,
    defaultPreference: opts.defaultPreference,
    validateStructuredOutput: opts.validateStructuredOutput,
  });
  return {
    router,
    plan: async (request) => {
      const plan = await router.plan(request);
      return Object.assign(plan, { expects: () => new PlanExpect(plan) });
    },
    run: router.run.bind(router),
    runText: router.runText.bind(router),
    generate: router.generate.bind(router),
    generateObject: router.generateObject.bind(router),
    generateText: router.generateText.bind(router),
  };
}
