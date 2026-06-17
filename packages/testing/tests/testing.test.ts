import { test, expect } from "bun:test";
import {
  model,
  fakeCatalog,
  mockProvider,
  routerForTest,
  expects,
  failAlways,
  formatPlan,
} from "../src/index.ts";

const models = [
  model("openai/gpt-5", { features: ["tools"], pricing: { input: 5, output: 15 }, qualityScore: 0.9 }),
  model("google/gemini-2.5-flash", {
    inputModalities: ["text", "image"],
    pricing: { input: 0.1, output: 0.4 },
    qualityScore: 0.6,
  }),
];

const req = (overrides = {}) => ({
  task: "t",
  input: "x",
  prompt: "hi",
  inputModalities: ["text"] as const,
  estimatedInputTokens: 1000,
  estimatedOutputTokens: 500,
  ...overrides,
});

test("model() fills sensible defaults", () => {
  const m = model("openai/gpt-5");
  expect(m.providerId).toBe("openai");
  expect(m.modelId).toBe("gpt-5");
  expect(m.inputModalities).toEqual(["text"]);
  expect(m.features).toEqual([]);
});

test("fakeCatalog lists the models", async () => {
  const caps = await fakeCatalog(models).listCapabilities();
  expect(caps).toHaveLength(2);
});

test("cheapest selects the cheaper model; chain + .not", async () => {
  const router = routerForTest({
    models,
    providers: [mockProvider("openai", { generateText: () => "a" }), mockProvider("google", { generateText: () => "b" })],
  });
  const plan = await router.plan(req({ preference: "cheapest" }));
  plan
    .expects()
    .selects("google/gemini-2.5-flash")
    .ranksBefore("google/gemini-2.5-flash", "openai/gpt-5")
    .not.selects("openai/gpt-5");
  // free-function form works too
  expects(plan).selects("gemini-2.5-flash"); // bare id matches across providers
});

test("requiresFeatures rejects models missing the feature", async () => {
  const router = routerForTest({
    models,
    providers: [mockProvider("openai", { generateObject: () => ({}) })],
  });
  const plan = await router.plan(req({ requiresFeatures: ["tools"], preference: "cheapest" }));
  plan.expects().selects("openai/gpt-5").rejects("google/gemini-2.5-flash");
});

test("mock providers record calls; generateText runs", async () => {
  const openai = mockProvider("openai", { generateText: (r) => `echo:${r.prompt}` });
  const router = routerForTest({ models: [model("openai/gpt-5")], providers: [openai] });
  const out = await router.generateText(req({ prompt: "hi", preference: "best_quality" }));
  expect(out).toBe("echo:hi");
  expect(openai.calls).toHaveLength(1);
  expect(openai.callCount("generateText")).toBe(1);
  expect(openai.calls[0]!.modelId).toBe("gpt-5");
});

test("falls back to the next provider when the selected one fails", async () => {
  const router = routerForTest({
    models: [model("openai/gpt-5", { qualityScore: 0.9 }), model("anthropic/claude-haiku-4-5", { qualityScore: 0.7 })],
    providers: [
      mockProvider("openai", { generateText: failAlways("503") }),
      mockProvider("anthropic", { generateText: () => "recovered" }),
    ],
  });
  const { output, attempts } = await router.runText(req({ prompt: "hi", preference: "best_quality" }));
  expect(output).toBe("recovered");
  expect(attempts.length).toBe(2);
  expect(attempts[0]!.ok).toBe(false);
  expect(attempts[1]!.ok).toBe(true);
});

test("a failed assertion throws SwooshExpectError with a plan dump", async () => {
  const router = routerForTest({ models, providers: [mockProvider("google", { generateText: () => "b" })] });
  const plan = await router.plan(req({ preference: "cheapest" }));
  expect(() => plan.expects().selects("openai/gpt-5")).toThrow(/Expected plan to select/);
  expect(formatPlan(plan)).toContain("selected:");
});
