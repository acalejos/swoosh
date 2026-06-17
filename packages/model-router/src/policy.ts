import type {
  LatencyClass,
  ModelCapability,
  RankedModel,
  RoutingPolicy,
  RoutingPolicyContext,
  RoutingPreference,
} from "./types";

const matchesId = (capability: ModelCapability, id: string): boolean =>
  id.includes("/")
    ? `${capability.providerId}/${capability.modelId}` === id
    : capability.modelId === id;

export const latencyWeight: Record<LatencyClass, number> = {
  fast: 3,
  standard: 2,
  slow: 1,
};

export interface ByBenchmarkOptions {
  /** Drop candidates scoring below this (and any with no score). */
  readonly minimum?: number;
}

/** A score map keyed by `"providerId/modelId"` or bare `modelId`. */
export type BenchmarkScores = Readonly<Record<string, number>>;

/**
 * Where benchmark scores come from:
 *   - a string  — key into `capability.benchmarks[key]`
 *   - a function — compute/blend a score from the capability (can read live state)
 *   - `{ resolve }` — a refreshable/async source, resolved once per plan, then
 *     looked up by `"providerId/modelId"` (or bare `modelId`). Use this for live
 *     leaderboards (e.g. an Elo feed) that aren't baked into the catalog.
 */
export type BenchmarkSource =
  | string
  | ((capability: ModelCapability) => number | undefined)
  | { readonly resolve: () => BenchmarkScores | Promise<BenchmarkScores> };

/**
 * Rank candidates by a benchmark — highest first.
 *
 *     byBenchmark("swe_bench")
 *     byBenchmark((c) => 0.7 * (c.benchmarks?.swe_bench ?? 0) + 0.3 * (c.benchmarks?.gpqa ?? 0))
 *     byBenchmark({ resolve: () => fetchLiveElo() })   // refreshable, not in the catalog
 *
 * Pass it as a request `preference`. Candidates with no score sort last (and are
 * dropped entirely when `minimum` is set).
 */
export const byBenchmark = (
  source: BenchmarkSource,
  options: ByBenchmarkOptions = {},
): RoutingPolicy => {
  return async ({ candidates }) => {
    let score: (capability: ModelCapability) => number | undefined;
    if (typeof source === "string") {
      score = (capability) => capability.benchmarks?.[source];
    } else if (typeof source === "function") {
      score = source;
    } else {
      const map = await source.resolve();
      score = (capability) =>
        map[`${capability.providerId}/${capability.modelId}`] ?? map[capability.modelId];
    }
    const scored = candidates.map((candidate) => ({ candidate, value: score(candidate.capability) }));
    const kept =
      options.minimum !== undefined
        ? scored.filter((s) => s.value !== undefined && s.value >= options.minimum!)
        : scored;
    return [...kept]
      .sort((a, b) => (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY))
      .map((s) => s.candidate);
  };
};

/**
 * Pin one or more models to the front of the ranking, in the given order — the
 * fallback-band pattern. Any candidates not in `ids` follow, ranked by `base`
 * (or left in catalog order). Ids are `"providerId/modelId"` or bare `modelId`.
 *
 *     preference: pin("openai/gpt-5")                       // prefer one, else fall through
 *     preference: pin(["openai/gpt-5", "xai/grok-4.3"])     // primary, then a fallback band
 */
export const pin = (ids: string | readonly string[], base?: RoutingPolicy): RoutingPolicy => {
  const wanted = typeof ids === "string" ? [ids] : ids;
  return async (context: RoutingPolicyContext) => {
    const pinned: RankedModel[] = [];
    for (const id of wanted) {
      const found = context.candidates.find(
        (c) => matchesId(c.capability, id) && !pinned.includes(c),
      );
      if (found) pinned.push(found);
    }
    const rest = context.candidates.filter((c) => !pinned.includes(c));
    const tail = base ? await base({ ...context, candidates: rest }) : rest;
    return [...pinned, ...tail];
  };
};

/**
 * Cap selection at a quality ceiling — the "good enough, don't overpay" pattern.
 * Keeps only candidates with `qualityScore <= max` (or all, if none qualify),
 * then ranks them by `base` (default: highest quality under the cap).
 */
export const qualityCap = (max: number, base?: RoutingPolicy): RoutingPolicy => {
  return async (context: RoutingPolicyContext) => {
    const under = context.candidates.filter((c) => qualityScore(c.capability) <= max);
    const pool = under.length > 0 ? under : context.candidates;
    if (base) return base({ ...context, candidates: pool });
    return [...pool].sort((a, b) => qualityScore(b.capability) - qualityScore(a.capability));
  };
};

export interface ByCoverageOptions {
  /** Minimum number of matching tags to qualify (default 1). */
  readonly minimum?: number;
}

/**
 * Soft tag matching — rank candidates by how many of `tags` their `features`
 * cover, most overlap first; drop those below `minimum` (default 1). Unlike
 * `requiresFeatures` (hard AND), this is "match any, rank by relevance" — the
 * right shape for routing over coverage/domain tags (e.g. knowledge connectors).
 *
 *     preference: byCoverage(["medical", "current"])   // ranks medical+current first, keeps medical-only
 */
export const byCoverage = (
  tags: readonly string[],
  options: ByCoverageOptions = {},
): RoutingPolicy => {
  const want = new Set(tags);
  const minimum = options.minimum ?? 1;
  return ({ candidates }) =>
    candidates
      .map((candidate) => ({
        candidate,
        overlap: candidate.capability.features.filter((f) => want.has(f)).length,
      }))
      .filter((s) => s.overlap >= minimum)
      .sort((a, b) => b.overlap - a.overlap || b.candidate.score - a.candidate.score)
      .map((s) => s.candidate);
};

export interface StickyOptions {
  /**
   * How much higher a challenger's score must be to justify switching off the
   * warm model (and eating a prefix-cache miss). Default 0 = switch on any
   * improvement; raise it to bias toward cache reuse.
   */
  readonly margin?: number;
}

/**
 * Prefix-cache–aware stickiness: keep the currently-active model on top (its
 * prompt prefix is already cached) unless another candidate beats it by more
 * than `margin`. The harness passes the model it used last step; switching
 * models cold-starts the cache, so this trades a small quality delta for cost/
 * latency. `currentModelId` is `"providerId/modelId"` or a bare `modelId`.
 *
 *     preference: sticky(lastUsedModelId, byBenchmark("swe_bench"), { margin: 0.05 })
 */
export const sticky = (
  currentModelId: string | undefined,
  base?: RoutingPolicy,
  options: StickyOptions = {},
): RoutingPolicy => {
  const margin = options.margin ?? 0;
  return async (context: RoutingPolicyContext) => {
    const ranked = base
      ? await base(context)
      : [...context.candidates].sort((a, b) => b.score - a.score);
    if (!currentModelId || ranked.length === 0) return ranked;
    const current = ranked.find((r) => matchesId(r.capability, currentModelId));
    if (!current) return ranked; // current model isn't a candidate this step
    const top = ranked[0]!;
    // Worth switching only if the best beats the warm model by more than margin.
    if (top !== current && top.score - current.score > margin) return ranked;
    return [current, ...ranked.filter((r) => r !== current)];
  };
};

export const estimatedCostUsd = (
  capability: ModelCapability,
  inputTokens: number,
  outputTokens: number,
): number | undefined => {
  const input = capability.pricing.inputPerMillionTokens;
  const output = capability.pricing.outputPerMillionTokens;
  if (input === undefined && output === undefined) return undefined;
  return ((input ?? 0) * inputTokens + (output ?? 0) * outputTokens) / 1_000_000;
};

export const qualityScore = (capability: ModelCapability): number =>
  capability.qualityScore ??
  [
    capability.features.includes("structured_output") ? 2 : 0,
    capability.features.includes("reasoning") ? 1 : 0,
    capability.features.includes("tools") ? 0.5 : 0,
    capability.features.includes("attachments") ? 0.5 : 0,
    Math.min((capability.limits.contextTokens ?? 0) / 250_000, 2),
  ].reduce((sum, value) => sum + value, 0);

export const namedPolicy =
  (preference: RoutingPreference, preferredProviderIds: readonly string[] = []): RoutingPolicy =>
  ({ candidates }) => {
    const preferred = new Set(preferredProviderIds);
    return [...candidates].sort((left, right) => {
      const leftPreferred = preferred.has(left.capability.providerId) ? 1 : 0;
      const rightPreferred = preferred.has(right.capability.providerId) ? 1 : 0;
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;

      if (preference === "cheapest") {
        return (
          (left.estimatedCostUsd ?? Number.POSITIVE_INFINITY) -
          (right.estimatedCostUsd ?? Number.POSITIVE_INFINITY)
        );
      }
      if (preference === "fastest") {
        return (
          latencyWeight[right.capability.latencyClass ?? "standard"] -
            latencyWeight[left.capability.latencyClass ?? "standard"] ||
          (left.estimatedCostUsd ?? Number.POSITIVE_INFINITY) -
            (right.estimatedCostUsd ?? Number.POSITIVE_INFINITY)
        );
      }
      if (preference === "best_quality") {
        return qualityScore(right.capability) - qualityScore(left.capability);
      }
      return (
        right.score - left.score ||
        (left.estimatedCostUsd ?? Number.POSITIVE_INFINITY) -
          (right.estimatedCostUsd ?? Number.POSITIVE_INFINITY)
      );
    });
  };

export const explainCandidate = (
  capability: ModelCapability,
  preference: RoutingPreference,
): string => {
  const modalities = capability.inputModalities.join("+");
  if (preference === "cheapest") return `Lowest estimated cost among ${modalities} candidates.`;
  if (preference === "fastest") return `Fastest available ${modalities} candidate.`;
  if (preference === "best_quality") return `Highest quality ${modalities} candidate.`;
  return `Balanced cost, capability, and availability for ${modalities}.`;
};
