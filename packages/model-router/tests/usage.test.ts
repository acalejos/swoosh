import { test, expect } from "bun:test";
import {
  ModelRouter,
  createCallbackProviderAdapter,
  createSession,
  createStaticCapabilityCatalog,
  createUsageMeter,
  type ModelCapability,
} from "../src/index.ts";

const cap = (modelId: string, price: number): ModelCapability => ({
  providerId: "p",
  providerName: "p",
  modelId,
  modelName: modelId,
  inputModalities: ["text"],
  outputModalities: ["text"],
  features: [],
  limits: {},
  pricing: { inputPerMillionTokens: price, outputPerMillionTokens: price },
});

const router = new ModelRouter({
  catalog: createStaticCapabilityCatalog([cap("a", 10)]),
  providers: [
    createCallbackProviderAdapter({
      providerId: "p",
      generateText: (req) => {
        req.reportUsage?.({ inputTokens: 1000, outputTokens: 500 });
        return "ok";
      },
    }),
  ],
});
const req = { task: "t", input: "x", prompt: "hi", inputModalities: ["text"] as const, preference: "cheapest" as const };

test("adapter reportUsage flows to result.usage and the attempt", async () => {
  const res = await router.runText(req);
  expect(res.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
  expect(res.attempts[0]!.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
});

test("usage meter accumulates tokens and actual cost", async () => {
  const meter = createUsageMeter();
  meter.record(await router.runText(req));
  meter.record(await router.runText(req));
  expect(meter.inputTokens).toBe(2000);
  expect(meter.outputTokens).toBe(1000);
  expect(meter.calls).toBe(2);
  // each call: (10/M * 1000) + (10/M * 500) = 0.015 → 0.03 total
  expect(meter.costUsd).toBeCloseTo(0.03, 6);
});

test("Session budget spends actual reported usage, not the estimate", async () => {
  const s = createSession({ budgetUsd: 0.02 });
  s.record(await router.runText({ ...req, preference: s.preference("cheapest") }));
  expect(s.spent).toBeCloseTo(0.015, 6); // actual: 0.015, not the 8k-token default estimate
  expect(s.remaining).toBeCloseTo(0.005, 6);
});
