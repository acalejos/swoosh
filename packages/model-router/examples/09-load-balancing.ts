// LiteLLM-style rotation, two ways:
//   • loadBalance — spread requests across the N cheapest providers, not just #1.
//   • roundRobin  — rotate API keys within one provider to spread rate limits.
// Run from the repo root: bun packages/model-router/examples/09-load-balancing.ts
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  loadBalance,
  ModelRouter,
  roundRobin,
} from "@swoosh-dev/router";

// Three image-generation models; replicate and openai are the two cheapest.
const imageCatalog = createStaticCapabilityCatalog([
  {
    providerId: "replicate", providerName: "Replicate", modelId: "flux-schnell", modelName: "FLUX schnell",
    inputModalities: ["text"], outputModalities: ["image"], features: [],
    limits: {}, pricing: { outputPerMillionTokens: 3 }, latencyClass: "fast",
  },
  {
    providerId: "openai", providerName: "OpenAI", modelId: "gpt-image-1", modelName: "GPT Image 1",
    inputModalities: ["text"], outputModalities: ["image"], features: [],
    limits: {}, pricing: { outputPerMillionTokens: 4 }, latencyClass: "standard",
  },
  {
    providerId: "google", providerName: "Google", modelId: "imagen-4", modelName: "Imagen 4",
    inputModalities: ["text"], outputModalities: ["image"], features: [],
    limits: {}, pricing: { outputPerMillionTokens: 12 }, latencyClass: "standard",
  },
]);

// openai rotates between two keys; we log which one each call used.
const nextOpenAiKey = roundRobin(["openai-key-A", "openai-key-B"]);

const router = new ModelRouter({
  catalog: imageCatalog,
  providers: ["replicate", "openai", "google"].map((providerId) =>
    createCallbackProviderAdapter({
      providerId,
      generateObject: () => {
        const key = providerId === "openai" ? ` (key ${nextOpenAiKey()})` : "";
        return { url: `https://cdn.example/${providerId}.png`, via: providerId + key };
      },
    }),
  ),
});

// Cheapest image gen — but cycle through the two cheapest providers.
const balanced = loadBalance("cheapest", { across: 2 });

for (let i = 1; i <= 4; i++) {
  const result = await router.run<string, { url: string; via: string }>({
    task: "image.generate",
    input: "a watercolor fox",
    prompt: "a watercolor fox",
    inputModalities: ["text"],
    outputModalities: ["image"],
    preference: balanced,
  });
  console.log(`request ${i} → ${result.output.via}`);
}
// → replicate, openai (key A), replicate, openai (key B): providers alternate,
//   and openai's two keys rotate across the calls that land on it.
