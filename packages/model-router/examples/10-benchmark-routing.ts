// Route by benchmark performance, not just price. byBenchmark ranks on a named
// benchmark — or a function that blends several, so you decide what "best" means.
// Run from the repo root: bun packages/model-router/examples/10-benchmark-routing.ts
import {
  byBenchmark,
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  type ModelCapability,
  ModelRouter,
} from "swoosh-router";
import { printPlan } from "./shared/print";

const model = (
  providerId: string,
  modelId: string,
  benchmarks: Record<string, number>,
): ModelCapability => ({
  providerId, providerName: providerId, modelId, modelName: modelId,
  inputModalities: ["text"], outputModalities: ["text"],
  features: ["structured_output"], limits: { contextTokens: 200_000 },
  pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 3 }, latencyClass: "standard",
  benchmarks,
});

const catalog = createStaticCapabilityCatalog([
  model("openai", "gpt-5", { swe_bench: 0.72, gpqa: 0.85 }),
  model("anthropic", "claude-opus", { swe_bench: 0.78, gpqa: 0.84 }),
  model("google", "gemini-pro", { swe_bench: 0.64, gpqa: 0.84 }),
]);

const router = new ModelRouter({
  catalog,
  providers: ["openai", "anthropic", "google"].map((p) => createCallbackProviderAdapter({ providerId: p })),
});

const base = {
  task: "code.fix",
  input: "patch this failing test",
  inputModalities: ["text"] as const,
  requiresFeatures: ["structured_output"] as const,
};

// 1) Single benchmark: best at SWE-bench → claude-opus.
const sweBest = await router.plan({ ...base, preference: byBenchmark("swe_bench") });
console.log("best @ swe_bench:");
printPlan(sweBest);

// 2) Composite: weight coding 70% / reasoning 30% → your own definition of "best".
const blended = byBenchmark((c) => 0.7 * (c.benchmarks?.swe_bench ?? 0) + 0.3 * (c.benchmarks?.gpqa ?? 0));
const blendedPlan = await router.plan({ ...base, preference: blended });
console.log("\nbest @ 0.7·swe_bench + 0.3·gpqa:");
printPlan(blendedPlan);
