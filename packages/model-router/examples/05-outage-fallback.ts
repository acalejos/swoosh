// When the selected provider fails, execution moves down the ranked route
// list automatically. The result includes the full attempt history.
// Run from the repo root: bun packages/model-router/examples/05-outage-fallback.ts
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  ModelRouter,
} from "@swoosh-dev/router";
import { exampleCatalog } from "./shared/catalog";
import { printAttempts, printPlan } from "./shared/print";

const router = new ModelRouter({
  catalog: createStaticCapabilityCatalog(exampleCatalog),
  providers: [
    createCallbackProviderAdapter({
      providerId: "google",
      generateObject: () => {
        throw new Error("503 service unavailable");
      },
    }),
    createCallbackProviderAdapter({
      providerId: "anthropic",
      generateObject: () => {
        throw new Error("429 rate limited");
      },
    }),
    createCallbackProviderAdapter({
      providerId: "openai",
      generateObject: () => ({ summary: "Q3 revenue grew 14% quarter over quarter." }),
    }),
  ],
});

const result = await router.run<string, { summary: string }>({
  task: "earnings.summarize",
  input: "(earnings call transcript)",
  prompt: "Summarize the key results in one sentence.",
  inputModalities: ["text"],
  requiresFeatures: ["structured_output"],
  preference: "cheapest",
});

printPlan(result.plan);
printAttempts(result.attempts);
console.log("output     ", result.output);
