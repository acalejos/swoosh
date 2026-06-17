import type { ProviderRerankRequest, RerankScore } from "./types";

export interface LlmRerankerOptions {
  /**
   * A structured-output call to an LLM: given a `prompt` and a JSON `schema`,
   * return the parsed object (AI-SDK-style `{ object }` wrappers are unwrapped).
   */
  readonly generateObject: (args: {
    prompt: string;
    schema: unknown;
  }) => Promise<unknown> | unknown;
  /** Override the prompt (e.g. to inject ranking criteria). */
  readonly prompt?: (query: string, documents: readonly string[]) => string;
  /** Ask for a one-line reason per result (default: true → declares "explanations"). */
  readonly explanations?: boolean;
}

const defaultPrompt = (
  query: string,
  documents: readonly string[],
  explanations: boolean,
): string =>
  [
    "Rank the documents by how well they answer the query, most relevant first.",
    "Only include documents that are actually relevant; omit the rest.",
    explanations ? "For each, give a one-sentence reason." : "",
    "",
    `Query: ${query}`,
    "",
    "Documents:",
    ...documents.map((doc, index) => `[${index}] ${doc}`),
  ]
    .filter(Boolean)
    .join("\n");

const rankingSchema = (explanations: boolean) => ({
  type: "object",
  properties: {
    ranking: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "number" }, reason: { type: "string" } },
        required: explanations ? ["index", "reason"] : ["index"],
        additionalProperties: false,
      },
    },
  },
  required: ["ranking"],
  additionalProperties: false,
});

interface RankEntry {
  readonly index: number;
  readonly reason?: string;
}

const extractRanking = (raw: unknown): RankEntry[] => {
  const obj = (
    raw && typeof raw === "object" && "object" in raw ? (raw as { object: unknown }).object : raw
  ) as { ranking?: unknown } | undefined;
  const ranking = obj?.ranking;
  if (!Array.isArray(ranking)) return [];
  return ranking
    .filter(
      (r): r is RankEntry =>
        !!r && typeof r === "object" && typeof (r as RankEntry).index === "number",
    )
    .map((r) => ({ index: r.index, reason: typeof r.reason === "string" ? r.reason : undefined }));
};

/**
 * Turn a structured-output (`generateObject`) call into a rerank callback: it
 * asks the model to order the documents — with optional per-result reasons — and
 * maps that ordering to descending scores (unranked documents score 0). Use it
 * as the `rerank` of a callback adapter so any LLM serves reranking; declare the
 * `"explanations"` feature on its catalog entry when reasons are on (the default)
 * so `requiresFeatures: ["explanations"]` routes to it.
 *
 *     createCallbackProviderAdapter({
 *       providerId: "openai",
 *       rerank: llmReranker({ generateObject: ({ prompt, schema }) => ai.generateObject({ model, prompt, schema }) }),
 *     })
 */
export const llmReranker =
  (options: LlmRerankerOptions) =>
  async (request: ProviderRerankRequest): Promise<readonly RerankScore[]> => {
    const explanations = options.explanations !== false;
    const prompt = options.prompt
      ? options.prompt(request.query, request.documents)
      : defaultPrompt(request.query, request.documents, explanations);
    const raw = await options.generateObject({ prompt, schema: rankingSchema(explanations) });
    const ranking = extractRanking(raw);
    const byIndex = new Map<number, RerankScore>();
    ranking.forEach((entry, position) => {
      if (
        entry.index >= 0 &&
        entry.index < request.documents.length &&
        !byIndex.has(entry.index)
      ) {
        byIndex.set(entry.index, {
          index: entry.index,
          score: ranking.length - position,
          reason: entry.reason,
        });
      }
    });
    return request.documents.map((_, index) => byIndex.get(index) ?? { index, score: 0 });
  };
