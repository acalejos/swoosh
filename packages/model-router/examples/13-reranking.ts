// Rerank search candidates by relevance to a query. Reranking is a task, not a
// modality: route on "rerank" and the adapter decides whether a dedicated
// cross-encoder (Cohere/Voyage — cheap, scores only) or an LLM reranker (pricier,
// returns per-result rationales) does the work. "explanations" is an intent:
// require it to route to a reason-capable reranker. Unlike embeddings, rerankers
// are stateless, so cross-model fallback is safe.
// Run from the repo root: bun packages/model-router/examples/13-reranking.ts
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  ModelRouter,
  type ModelCapability,
} from "@swoosh-dev/router";
import { printAttempts, printPlan } from "./shared/print";

const reranker = (
  id: string,
  extra: Pick<ModelCapability, "rerank" | "features" | "pricing" | "qualityScore">,
): ModelCapability => {
  const [providerId, modelId] = id.split("/") as [string, string];
  return {
    providerId,
    providerName: providerId,
    modelId,
    modelName: modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    features: extra.features ?? [],
    limits: {},
    pricing: extra.pricing,
    qualityScore: extra.qualityScore,
    rerank: extra.rerank,
  };
};

const catalog = createStaticCapabilityCatalog([
  reranker("cohere/rerank-3.5", { rerank: { maxDocuments: 1000 }, features: [], pricing: { inputPerMillionTokens: 0.1 }, qualityScore: 0.62 }),
  reranker("voyage/rerank-2", { rerank: { maxDocuments: 1000 }, features: [], pricing: { inputPerMillionTokens: 0.05 }, qualityScore: 0.6 }),
  reranker("openai/gpt-5", { rerank: { maxDocuments: 100 }, features: ["explanations"], pricing: { inputPerMillionTokens: 2.5 }, qualityScore: 0.9 }),
]);

// Offline "relevance": query-term overlap (a real cross-encoder is far better).
const relevance = (query: string, doc: string) => {
  const terms = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  const words = doc.toLowerCase().split(/\W+/);
  return words.filter((w) => terms.has(w)).length;
};

// Dedicated cross-encoders: scores only, no rationale.
const crossEncoder = (providerId: string) =>
  createCallbackProviderAdapter({
    providerId,
    rerank: ({ query, documents }) =>
      documents.map((doc, index) => ({ index, score: relevance(query, doc) })),
  });

// LLM reranker: scores AND a natural-language reason per result.
const llmReranker = createCallbackProviderAdapter({
  providerId: "openai",
  rerank: ({ query, documents }) =>
    documents.map((doc, index) => {
      const score = relevance(query, doc);
      return { index, score, reason: score ? `mentions ${score} of the query terms` : "off-topic" };
    }),
});

const router = new ModelRouter({
  catalog,
  providers: [crossEncoder("cohere"), crossEncoder("voyage"), llmReranker],
});

const query = "quick chocolate dessert";
const documents = [
  "No-bake chocolate fridge cake, ready fast",
  "Slow-braised beef short ribs, three hours",
  "Five-minute chocolate mug cake, quick dessert",
  "Grilled salmon with lemon",
  "Dark chocolate truffles, quick and easy",
];

const show = (label: string, results: readonly { index: number; score: number; document: string; reason?: string }[]) => {
  console.log(`\n${label}`);
  for (const r of results) {
    console.log(`  [${r.score}] ${r.document}${r.reason ? `  — ${r.reason}` : ""}`);
  }
};

// 1. Cheapest: routes to a dedicated cross-encoder (Voyage, cheapest). No reasons.
const plain = await router.rerank({ task: "search.rerank", query, documents, topK: 3, preference: "cheapest" });
printPlan(plain.plan);
show(`cheapest -> ${plain.model.providerId}/${plain.model.modelId} (top 3)`, plain.results);

// 2. Need rationales: require "explanations" -> routes to the LLM reranker.
const explained = await router.rerank({
  task: "search.rerank",
  query,
  documents,
  topK: 3,
  requiresFeatures: ["explanations"],
});
show(`requiresFeatures: ["explanations"] -> ${explained.model.providerId}/${explained.model.modelId}`, explained.results);

// 3. Fallback is safe (stateless): if the chosen reranker is down, another takes over.
const flaky = new ModelRouter({
  catalog,
  providers: [
    createCallbackProviderAdapter({ providerId: "voyage", rerank: () => { throw new Error("voyage 503"); } }),
    crossEncoder("cohere"),
    llmReranker,
  ],
});
const recovered = await flaky.rerank({ task: "search.rerank", query, documents, topK: 3, preference: "cheapest" });
console.log(`\nfallback: served by ${recovered.model.providerId}/${recovered.model.modelId}`);
printAttempts(recovered.attempts);
