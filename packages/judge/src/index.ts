import {
  namedPolicy,
  type RankedModel,
  type RoutingPolicy,
  type RoutingPolicyContext,
  type RoutingPreference,
  type TaskRequest,
} from "swoosh-router";

/** What the classifier sees: the request, plus a best-effort prompt string. */
export interface JudgeInput {
  readonly prompt: string;
  readonly request: TaskRequest;
}

export interface LlmJudgePolicyOptions<Verdict extends string> {
  /**
   * Classify the request into one of your categories. This is your LLM call,
   * returning structured output (the category). Sync or async. You can route
   * the judge itself through a cheap swoosh model.
   */
  readonly classify: (input: JudgeInput) => Promise<Verdict> | Verdict;
  /** Map each category to a base preference or policy. */
  readonly route: Record<Verdict, RoutingPreference | RoutingPolicy>;
  /** Used when classify throws or returns an unmapped verdict. Defaults to `"balanced"`. */
  readonly fallback?: RoutingPreference | RoutingPolicy;
  /**
   * Cache verdicts so identical prompts aren't re-judged (the judge call costs
   * latency + tokens). On by default; pass `false` to disable, or an object to
   * customize the cache key / max size.
   */
  readonly cache?: boolean | { readonly key?: (prompt: string) => string; readonly max?: number };
}

const stringifyInput = (input: unknown): string =>
  typeof input === "string" ? input : (() => {
    try {
      return JSON.stringify(input) ?? "";
    } catch {
      return String(input);
    }
  })();

const resolve = async (
  base: RoutingPreference | RoutingPolicy,
  context: RoutingPolicyContext,
): Promise<readonly RankedModel[]> =>
  typeof base === "function"
    ? base(context)
    : namedPolicy(base, context.request.constraints?.preferredProviderIds)(context);

/**
 * A dynamic routing policy that classifies each request's prompt with an LLM
 * judge and routes by the verdict. The verdict comes from your structured-output
 * classifier; the policy result is still an ordinary ranked candidate list, so
 * failover and the rest of the router work unchanged.
 *
 *     const smart = llmJudgePolicy({
 *       classify: ({ prompt }) => judge.generateObject({ schema: Kind, prompt }),
 *       route: { coding: "best_quality", chat: "cheapest" },
 *     });
 *     await router.run({ ...request, preference: smart });
 */
export const llmJudgePolicy = <Verdict extends string>(
  options: LlmJudgePolicyOptions<Verdict>,
): RoutingPolicy => {
  const useCache = options.cache !== false;
  const keyOf =
    typeof options.cache === "object" && options.cache.key ? options.cache.key : (p: string) => p;
  const max = typeof options.cache === "object" ? options.cache.max : undefined;
  const cache = new Map<string, Verdict>();

  return async (context) => {
    const { request } = context;
    const prompt = (request as { prompt?: string }).prompt ?? stringifyInput(request.input);
    const cacheKey = keyOf(prompt);

    let verdict: Verdict | undefined;
    if (useCache && cache.has(cacheKey)) {
      verdict = cache.get(cacheKey);
    } else {
      try {
        verdict = await options.classify({ prompt, request });
      } catch {
        verdict = undefined;
      }
      if (useCache && verdict !== undefined) {
        cache.set(cacheKey, verdict);
        if (max !== undefined && cache.size > max) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
    }

    const base =
      (verdict !== undefined ? options.route[verdict] : undefined) ?? options.fallback ?? "balanced";
    return resolve(base, context);
  };
};
