// Route a support ticket to the best available model and get structured output.
// Run from the repo root: bun packages/model-router/examples/01-quickstart.ts
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  ModelRouter,
} from "@swoosh-dev/router";
import { exampleCatalog } from "./shared/catalog";
import { printAttempts, printPlan } from "./shared/print";

interface Triage {
  category: "billing" | "bug" | "how-to";
  urgency: "low" | "high";
}

// Simulated providers. Swap these for createAiSdkProviderAdapter in a real app.
const providers = [
  createCallbackProviderAdapter({
    providerId: "google",
    generateObject: () => ({ category: "billing", urgency: "high" }) satisfies Triage,
  }),
  createCallbackProviderAdapter({
    providerId: "anthropic",
    generateObject: () => ({ category: "billing", urgency: "high" }) satisfies Triage,
  }),
];

const router = new ModelRouter({
  catalog: createStaticCapabilityCatalog(exampleCatalog),
  providers,
  defaultPreference: "balanced",
});

const ticket = "I was charged twice for my subscription this month. Please fix this today.";

const result = await router.run<string, Triage>({
  task: "support.triage",
  input: ticket,
  prompt: `Classify this support ticket: ${ticket}`,
  inputModalities: ["text"],
  requiresFeatures: ["structured_output"],
});

printPlan(result.plan);
printAttempts(result.attempts);
console.log("output     ", result.output);
