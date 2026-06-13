// Dynamic routing: an LLM judge classifies each prompt, then the policy routes
// by the verdict — cheap models for chat, top models for coding, search models
// for research. The classifier returns structured output (the category).
// Run from the repo root: bun packages/model-router/examples/11-llm-judge.ts
import {
  byBenchmark,
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  type ModelCapability,
  ModelRouter,
} from "@semafore/router";
import { llmJudgePolicy } from "@semafore/judge";
import { printPlan } from "./shared/print";

const model = (providerId: string, modelId: string, extra: Partial<ModelCapability>): ModelCapability => ({
  providerId, providerName: providerId, modelId, modelName: modelId,
  inputModalities: ["text"], outputModalities: ["text"], features: ["structured_output"],
  limits: { contextTokens: 200_000 }, pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 3 },
  latencyClass: "standard", ...extra,
});

const router = new ModelRouter({
  catalog: createStaticCapabilityCatalog([
    model("local", "tiny", { pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 } }),
    model("anthropic", "opus", { qualityScore: 10, benchmarks: { swe_bench: 0.78 } }),
    model("perplexity", "sonar", { features: ["structured_output", "web_search"] }),
  ]),
  providers: ["local", "anthropic", "perplexity"].map((p) => createCallbackProviderAdapter({ providerId: p })),
});

type Kind = "chat" | "coding" | "research";

// Stand-in for a structured-output LLM call. In production this is e.g.
// judge.generateObject({ schema: KindSchema, prompt }) routed through swoosh itself.
let judgeCalls = 0;
const classify = ({ prompt }: { prompt: string }): Kind => {
  judgeCalls++;
  if (/\b(code|bug|patch|function|test)\b/i.test(prompt)) return "coding";
  if (/\b(latest|today|news|current|who won)\b/i.test(prompt)) return "research";
  return "chat";
};

const smart = llmJudgePolicy<Kind>({
  classify,
  route: {
    chat: "cheapest",
    coding: byBenchmark("swe_bench"),
    research: ({ candidates }) => candidates.filter((c) => c.capability.features.includes("web_search")),
  },
});

for (const prompt of [
  "just say hi back to me",
  "patch this failing unit test",
  "who won the game last night?",
  "just say hi back to me", // repeat → served from the judge cache
]) {
  const plan = await router.plan({ task: "assist", input: prompt, inputModalities: ["text"], preference: smart });
  console.log(`"${prompt.slice(0, 28)}…" → ${plan.selected.capability.providerId}/${plan.selected.capability.modelId}`);
}
console.log(`\njudge invoked ${judgeCalls}× for 4 requests (1 was cached)`);
