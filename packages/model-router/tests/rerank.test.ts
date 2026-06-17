import { test, expect } from "bun:test";
import {
  ModelRouter,
  ModelRouterError,
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  llmReranker,
  type ModelCapability,
  type ProviderAdapter,
} from "../src/index.ts";

const cap = (
  id: string,
  extra: Partial<ModelCapability> & Pick<ModelCapability, "rerank">,
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
    limits: extra.limits ?? {},
    pricing: extra.pricing ?? {},
    qualityScore: extra.qualityScore,
    rerank: extra.rerank,
  };
};

// deterministic "relevance": how many times the query word appears in the doc
const score = (query: string, doc: string) =>
  doc.toLowerCase().split(/\W+/).filter((w) => w === query.toLowerCase()).length;

const DOCS = ["chocolate chocolate cake", "salmon dinner", "chocolate cookie"];

const catalog = createStaticCapabilityCatalog([
  cap("cohere/rerank-3.5", { rerank: { maxDocuments: 1000 }, pricing: { inputPerMillionTokens: 0.1 }, qualityScore: 0.6 }),
  cap("openai/gpt-5", { rerank: { maxDocuments: 100 }, features: ["explanations"], pricing: { inputPerMillionTokens: 5 }, qualityScore: 0.9 }),
  cap("google/gemini-2.5-flash", { rerank: undefined, features: ["tools"], pricing: { inputPerMillionTokens: 0.1 } }),
]);

const cohere = (fail = false): ProviderAdapter =>
  createCallbackProviderAdapter({
    providerId: "cohere",
    rerank: ({ query, documents }) => {
      if (fail) throw new Error("cohere 503");
      return documents.map((d, index) => ({ index, score: score(query, d) }));
    },
  });

const openai: ProviderAdapter = createCallbackProviderAdapter({
  providerId: "openai",
  rerank: ({ query, documents }) =>
    documents.map((d, index) => ({ index, score: score(query, d), reason: `mentions "${query}" ${score(query, d)}x` })),
});

const gemini: ProviderAdapter = createCallbackProviderAdapter({
  providerId: "google",
  generateText: () => "not a reranker",
});

const router = (cohereFails = false) =>
  new ModelRouter({ catalog, providers: [cohere(cohereFails), openai, gemini] });

const base = { task: "search.rerank", query: "chocolate", documents: DOCS };

test("cheapest selects the dedicated reranker; non-rerankers are rejected with a reason", async () => {
  const plan = await router().planRerank({ ...base, preference: "cheapest" });
  expect(`${plan.selected.capability.providerId}/${plan.selected.capability.modelId}`).toBe("cohere/rerank-3.5");
  const gem = plan.rejected.find((r) => r.providerId === "google");
  expect(gem?.reason).toBe("Model is not a reranker.");
});

test("results are sorted by score, document attached, no reasons from a dedicated reranker", async () => {
  const { results } = await router().rerank({ ...base, preference: "cheapest" });
  expect(results.map((r) => r.index)).toEqual([0, 2, 1]); // 2x, 1x, 0x
  expect(results[0]!.document).toBe("chocolate chocolate cake");
  expect(results[0]!.reason).toBeUndefined();
});

test('requiresFeatures: ["explanations"] routes to the reason-capable reranker', async () => {
  const { results, model } = await router().rerank({ ...base, requiresFeatures: ["explanations"], preference: "cheapest" });
  expect(model.modelId).toBe("gpt-5");
  expect(results[0]!.reason).toContain("chocolate");
});

test("cross-model fallback when the selected reranker fails", async () => {
  const { results, attempts, model } = await router(true).rerank({ ...base, preference: "cheapest" });
  expect(attempts.length).toBe(2);
  expect(attempts[0]!.ok).toBe(false);
  expect(model.providerId).toBe("openai"); // fell back from cohere
  expect(results[0]!.index).toBe(0);
});

test("topK caps the results", async () => {
  const { results } = await router().rerank({ ...base, topK: 1, preference: "cheapest" });
  expect(results).toHaveLength(1);
});

test("llmReranker() turns structured output into scores + reasons", async () => {
  // a fake structured LLM: return a ranking object directly
  const adapter = createCallbackProviderAdapter({
    providerId: "openai",
    rerank: llmReranker({
      generateObject: () => ({
        ranking: [
          { index: 2, reason: "most on-topic" },
          { index: 0, reason: "somewhat related" },
        ],
      }),
    }),
  });
  const r = new ModelRouter({
    catalog: createStaticCapabilityCatalog([
      cap("openai/gpt-5", { rerank: { maxDocuments: 100 }, features: ["explanations"], qualityScore: 0.9 }),
    ]),
    providers: [adapter],
  });
  const { results } = await r.rerank({ ...base, requiresFeatures: ["explanations"] });
  expect(results.map((x) => x.index)).toEqual([2, 0, 1]); // ranked first, then unranked (score 0)
  expect(results[0]!.reason).toBe("most on-topic");
  expect(results[2]!.score).toBe(0); // doc 1 was omitted by the model
});

test("no eligible reranker -> ModelRouterError", async () => {
  // explanations required, but cohere lacks it and openai is capped below the doc count
  const tight = createStaticCapabilityCatalog([
    cap("cohere/rerank-3.5", { rerank: { maxDocuments: 1000 }, qualityScore: 0.6 }),
    cap("openai/gpt-5", { rerank: { maxDocuments: 2 }, features: ["explanations"], qualityScore: 0.9 }),
  ]);
  const r = new ModelRouter({ catalog: tight, providers: [cohere(), openai] });
  await expect(r.rerank({ ...base, requiresFeatures: ["explanations"] })).rejects.toBeInstanceOf(ModelRouterError);
});
