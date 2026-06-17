import { test, expect } from "bun:test";
import {
  ModelRouter,
  createCallbackProviderAdapter,
  createHealthTracker,
  createSession,
  createStaticCapabilityCatalog,
  type ModelCapability,
} from "../src/index.ts";

const cap = (modelId: string, pricing: number, quality: number): ModelCapability => ({
  providerId: "p",
  providerName: "p",
  modelId,
  modelName: modelId,
  inputModalities: ["text"],
  outputModalities: ["text"],
  features: [],
  limits: {},
  pricing: { inputPerMillionTokens: pricing },
  qualityScore: quality,
});

const catalog = createStaticCapabilityCatalog([
  cap("a", 10, 0.9), // pricey, best quality
  cap("b", 1, 0.6),
  cap("c", 0.1, 0.3), // cheapest
]);
const router = new ModelRouter({
  catalog,
  providers: [createCallbackProviderAdapter({ providerId: "p", generateText: () => "ok" })],
});
const req = (preference: unknown) => ({
  task: "t", input: "x", inputModalities: ["text"] as const, preference: preference as never,
});

test("Session tracks spend and downgrades to cheapest once over budget", async () => {
  const s = createSession({ budgetUsd: 0.05, onBudgetExceeded: "cheapest" });
  const p1 = await router.plan(req(s.preference("best_quality")));
  expect(p1.selected.capability.modelId).toBe("a");
  s.record({ plan: p1 });
  expect(s.spent).toBeGreaterThan(0.05);
  expect(s.remaining).toBe(0);
  const p2 = await router.plan(req(s.preference("best_quality")));
  expect(p2.selected.capability.modelId).toBe("c"); // over budget → cheapest
});

test("Session 'throw' mode rejects once the budget is spent", async () => {
  const s = createSession({ budgetUsd: 0.01, onBudgetExceeded: "throw" });
  s.record({ plan: await router.plan(req("best_quality")) }); // spends ~0.08
  await expect(router.plan(req(s.preference("best_quality")))).rejects.toThrow(/budget/);
});

test("Session feeds attempts to its health tracker (benches failures)", async () => {
  const s = createSession({ health: createHealthTracker({ cooldownMs: 60_000 }) });
  const p1 = await router.plan(req(s.preference("cheapest")));
  expect(p1.selected.capability.modelId).toBe("c");
  s.record({ plan: p1, attempts: [{ providerId: "p", modelId: "c", ok: false, error: "429" }] });
  const p2 = await router.plan(req(s.preference("cheapest")));
  expect(p2.selected.capability.modelId).not.toBe("c"); // c benched
});

test("Session sticky keeps the warm candidate", async () => {
  const s = createSession({ sticky: { margin: 100 } });
  const warm = await router.plan(req("cheapest")); // c
  s.record({ plan: warm, attempts: [{ providerId: "p", modelId: "c", ok: true }] });
  const p = await router.plan(req(s.preference("best_quality"))); // would pick a, but c is warm
  expect(p.selected.capability.modelId).toBe("c");
});
