import { test, expect } from "bun:test";
import {
  ModelRouter,
  byBenchmark,
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  pin,
  qualityCap,
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
