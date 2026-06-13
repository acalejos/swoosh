// Generate a quiz about current events — which needs a model that can search
// the web. Requiring the "web_search" feature filters the catalog to models
// whose API does live search; the adapter turns it on per provider.
// Run from the repo root: bun packages/model-router/examples/08-web-search.ts
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  ModelRouter,
} from "swoosh-router";
import { exampleCatalog } from "./shared/catalog";
import { printPlan } from "./shared/print";

interface Quiz {
  questions: { prompt: string; answer: string }[];
}

// In the fixture, google/gemini-2.5-flash and openai/gpt-4o are tagged with
// "web_search"; the others are not. The adapter is where you actually enable
// the provider's search tool (e.g. OpenAI's web_search tool, Gemini grounding).
const providers = ["google", "anthropic", "openai", "mistral", "local"].map((providerId) =>
  createCallbackProviderAdapter({
    providerId,
    generateObject: () =>
      ({
        questions: [
          { prompt: "Which team won the most recent Formula 1 race?", answer: "(from live search)" },
        ],
      }) satisfies Quiz,
  }),
);

const router = new ModelRouter({
  catalog: createStaticCapabilityCatalog(exampleCatalog),
  providers,
});

const result = await router.run<string, Quiz>({
  task: "quiz.generate",
  input: "Write 5 quiz questions about this week's sports headlines.",
  prompt: "Write 5 quiz questions about this week's sports headlines, with answers.",
  inputModalities: ["text"],
  requiresFeatures: ["structured_output", "web_search"],
  preference: "cheapest",
});

// Only gemini-2.5-flash and gpt-4o survive the web_search requirement;
// claude, mistral, and llama are rejected for lacking it.
printPlan(result.plan);
console.log("output     ", JSON.stringify(result.output));
