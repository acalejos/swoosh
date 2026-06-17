import { test, expect } from "bun:test";
import {
  ModelRouter,
  byBenchmark,
  byCoverage,
  createCallbackProviderAdapter,
  createHealthTracker,
  createStaticCapabilityCatalog,
  healthAware,
  pin,
  qualityCap,
  sticky,
  type ModelCapability,
} from "../src/index.ts";

const cap = (modelId: string, extra: Partial<ModelCapability>): ModelCapability => ({
  providerId: "p",
  providerName: "p",
  modelId,
  modelName: modelId,
  inputModalities: ["text"],
  outputModalities: ["text"],
  features: [],
  limits: {},
  pricing: extra.pricing ?? {},
  qualityScore: extra.qualityScore,
  benchmarks: extra.benchmarks,
});

const catalog = createStaticCapabilityCatalog([
  cap("a", { qualityScore: 0.9, pricing: { inputPerMillionTokens: 10 }, benchmarks: { swe_bench: 0.4 } }),
  cap("b", { qualityScore: 0.6, pricing: { inputPerMillionTokens: 1 }, benchmarks: { swe_bench: 0.9 } }),
  cap("c", { qualityScore: 0.3, pricing: { inputPerMillionTokens: 0.1 }, benchmarks: { swe_bench: 0.7 } }),
]);

const router = new ModelRouter({
  catalog,
  providers: [createCallbackProviderAdapter({ providerId: "p", generateText: () => "ok" })],
});

const req = (preference: unknown) => ({
  task: "t",
  input: "x",
  inputModalities: ["text"] as const,
  preference: preference as never,
});

test("byBenchmark(string) ranks by the catalog benchmark", async () => {
  const plan = await router.plan(req(byBenchmark("swe_bench")));
  expect(plan.selected.capability.modelId).toBe("b"); // 0.9
  expect(plan.fallbacks[0]!.capability.modelId).toBe("c"); // 0.7
});

test("byBenchmark({resolve}) uses a live/async score map", async () => {
  const plan = await router.plan(req(byBenchmark({ resolve: async () => ({ "p/c": 100, "p/a": 50, "p/b": 1 }) })));
  expect(plan.selected.capability.modelId).toBe("c"); // live winner, beats catalog quality
});

test("pin() forces a model to the front, then a fallback band", async () => {
  const plan = await router.plan(req(pin(["p/c", "p/b"])));
  expect(plan.selected.capability.modelId).toBe("c");
  expect(plan.fallbacks[0]!.capability.modelId).toBe("b");
});

test("qualityCap() picks the best model under the ceiling", async () => {
  const plan = await router.plan(req(qualityCap(0.7)));
  expect(plan.selected.capability.modelId).toBe("b"); // 0.6 is the best <= 0.7 (a=0.9 excluded)
});

test("byCoverage() soft-matches tags and ranks by overlap (vs hard-AND requiresFeatures)", async () => {
  const catalog2 = createStaticCapabilityCatalog([
    cap("openfda", { qualityScore: 0.7 }),       // medical + current
    cap("pubmed", { qualityScore: 0.8 }),        // medical only
    cap("arxiv", { qualityScore: 0.9 }),         // academic only
  ]);
  // attach coverage tags via features
  const tagged = [
    { ...(await catalog2.listCapabilities())[0]!, features: ["medical", "current"] },
    { ...(await catalog2.listCapabilities())[1]!, features: ["medical"] },
    { ...(await catalog2.listCapabilities())[2]!, features: ["academic"] },
  ];
  const r = new ModelRouter({
    catalog: createStaticCapabilityCatalog(tagged),
    providers: [createCallbackProviderAdapter({ providerId: "p" })],
  });
  const plan = await r.plan(req(byCoverage(["medical", "current"])));
  const ids = [plan.selected, ...plan.fallbacks].map((r) => r.capability.modelId);
  expect(ids).toEqual(["openfda", "pubmed"]); // 2 tags, then 1 tag
  expect(ids).not.toContain("arxiv"); // 0 tags — policy-dropped (not in selected/fallbacks)
});

test("requiresAnyFeatures is an OR filter that composes with requiresFeatures (AND)", async () => {
  const feat = (id: string, features: string[]) => ({ ...cap(id, {}), features });
  const r = new ModelRouter({
    catalog: createStaticCapabilityCatalog([
      feat("a", ["structured_output", "web_search"]),
      feat("b", ["structured_output", "tools"]),
      feat("c", ["structured_output"]),
      feat("d", ["web_search"]),
    ]),
    providers: [createCallbackProviderAdapter({ providerId: "p", generateText: () => "ok" })],
  });
  // must have structured_output AND (web_search OR tools): a, b qualify; c (neither), d (no structured) rejected
  const plan = await r.plan({
    task: "t", input: "x", inputModalities: ["text"],
    requiresFeatures: ["structured_output"], requiresAnyFeatures: ["web_search", "tools"],
  });
  const ids = [plan.selected, ...plan.fallbacks].map((m) => m.capability.modelId).sort();
  expect(ids).toEqual(["a", "b"]);
  expect(plan.rejected.find((x) => x.modelId === "c")?.reason).toContain("Has none of the features");
  expect(plan.rejected.find((x) => x.modelId === "d")?.reason).toContain("Missing required feature");
});

test("healthAware() benches a failed route until a success clears it", async () => {
  const tracker = createHealthTracker({ cooldownMs: 60_000 });
  const policy = healthAware("cheapest", tracker); // c (0.1) < b (1) < a (10)
  expect((await router.plan(req(policy))).selected.capability.modelId).toBe("c");
  tracker.record([{ providerId: "p", modelId: "c", ok: false, error: "429" }]);
  expect((await router.plan(req(policy))).selected.capability.modelId).toBe("b"); // c benched
  tracker.record([{ providerId: "p", modelId: "c", ok: true }]);
  expect((await router.plan(req(policy))).selected.capability.modelId).toBe("c"); // back in rotation
});

test("sticky() keeps the warm model unless a challenger beats it by margin", async () => {
  // base = best_quality: a(0.9) > b(0.6) > c(0.3). Current = c.
  const stay = await router.plan(req(sticky("p/c", byBenchmark("swe_bench"), { margin: 1 })));
  expect(stay.selected.capability.modelId).toBe("c"); // huge margin → stay warm despite worse score
  const switchAway = await router.plan(req(sticky("p/c", byBenchmark("swe_bench"), { margin: 0 })));
  expect(switchAway.selected.capability.modelId).toBe("b"); // margin 0 → take the better one (swe_bench: b=0.9)
});
