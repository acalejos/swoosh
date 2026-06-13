// Summarize a long document with a hard budget. Models whose estimated cost
// exceeds maxCostUsd are rejected at planning time, before any tokens are spent.
// Run from the repo root: bun packages/model-router/examples/02-cost-guardrails.ts
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  ModelRouter,
} from "swoosh-router";
import { exampleCatalog } from "./shared/catalog";
import { printPlan } from "./shared/print";

const router = new ModelRouter({
  catalog: createStaticCapabilityCatalog(exampleCatalog),
  providers: ["google", "anthropic", "openai", "mistral", "local"].map((providerId) =>
    createCallbackProviderAdapter({ providerId }),
  ),
});

const plan = await router.plan({
  task: "report.summarize",
  input: "(a 400-page incident report)",
  inputModalities: ["text"],
  requiresFeatures: ["structured_output"],
  estimatedInputTokens: 150_000,
  estimatedOutputTokens: 4_000,
  preference: "cheapest",
  constraints: { maxCostUsd: 0.1 },
});

// claude-opus-4-8 is rejected: 150k input tokens at $15/M already costs $2.25.
// gpt-4o and mistral-large are rejected on context window, not cost.
printPlan(plan);
