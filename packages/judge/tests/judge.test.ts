import { describe, expect, test } from "bun:test";
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  ModelRouter,
  type ModelCapability,
} from "swoosh-router";
import { llmJudgePolicy } from "swoosh-judge";

const model = (providerId: string, modelId: string, pricing: number): ModelCapability => ({
  providerId, providerName: providerId, modelId, modelName: modelId,
  inputModalities: ["text"], outputModalities: ["text"], features: ["structured_output"],
  limits: { contextTokens: 100_000 },
  pricing: { inputPerMillionTokens: pricing, outputPerMillionTokens: pricing },
  latencyClass: "standard", qualityScore: pricing === 0 ? 1 : 9,
});

const router = (preference: ReturnType<typeof llmJudgePolicy>) =>
  new ModelRouter({
    catalog: createStaticCapabilityCatalog([model("cheap", "c", 0), model("smart", "s", 10)]),
    providers: ["cheap", "smart"].map((p) => createCallbackProviderAdapter({ providerId: p })),
  });

describe("llmJudgePolicy", () => {
  test("routes by the classifier's verdict", async () => {
    const policy = llmJudgePolicy<"chat" | "hard">({
      classify: ({ prompt }) => (prompt.includes("prove") ? "hard" : "chat"),
      route: { chat: "cheapest", hard: "best_quality" },
    });
    const r = router(policy);
    const chat = await r.plan({ task: "t", input: "hi", inputModalities: ["text"], preference: policy });
    const hard = await r.plan({ task: "t", input: "prove it", inputModalities: ["text"], preference: policy });
    expect(chat.selected.capability.providerId).toBe("cheap");
    expect(hard.selected.capability.providerId).toBe("smart");
  });

  test("caches verdicts so identical prompts aren't re-judged", async () => {
    let calls = 0;
    const policy = llmJudgePolicy<"chat">({
      classify: () => { calls++; return "chat" as const; },
      route: { chat: "cheapest" },
    });
    const r = router(policy);
    for (let i = 0; i < 3; i++) {
      await r.plan({ task: "t", input: "same", inputModalities: ["text"], preference: policy });
    }
    expect(calls).toBe(1);
  });

  test("falls back when classify throws", async () => {
    const policy = llmJudgePolicy<"x">({
      classify: () => { throw new Error("judge down"); },
      route: { x: "best_quality" },
      fallback: "cheapest",
    });
    const r = router(policy);
    const plan = await r.plan({ task: "t", input: "hi", inputModalities: ["text"], preference: policy });
    expect(plan.selected.capability.providerId).toBe("cheap");
  });

  test("supports an async classifier", async () => {
    const policy = llmJudgePolicy<"hard">({
      classify: async () => { await Promise.resolve(); return "hard" as const; },
      route: { hard: "best_quality" },
    });
    const r = router(policy);
    const plan = await r.plan({ task: "t", input: "x", inputModalities: ["text"], preference: policy });
    expect(plan.selected.capability.providerId).toBe("smart");
  });
});
