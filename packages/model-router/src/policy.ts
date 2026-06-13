import type {
  LatencyClass,
  ModelCapability,
  RoutingPolicy,
  RoutingPreference,
} from "./types";

export const latencyWeight: Record<LatencyClass, number> = {
  fast: 3,
  standard: 2,
  slow: 1,
};

export interface ByBenchmarkOptions {
  /** Drop candidates scoring below this (and any with no score). */
  readonly minimum?: number;
}

/**
 * Rank candidates by a benchmark — highest first. `scorer` is either a benchmark
 * key (read from `capability.benchmarks[key]`) or a function that computes a
 * score from the capability, so you can blend several benchmarks:
 *
 *     byBenchmark("swe_bench")
 *     byBenchmark((c) => 0.7 * (c.benchmarks?.swe_bench ?? 0) + 0.3 * (c.benchmarks?.gpqa ?? 0))
 *
 * Pass it as a request `preference`. Candidates with no score sort last (and are
 * dropped entirely when `minimum` is set).
 */
export const byBenchmark = (
  scorer: string | ((capability: ModelCapability) => number | undefined),
  options: ByBenchmarkOptions = {},
): RoutingPolicy => {
  const score =
    typeof scorer === "function"
      ? scorer
      : (capability: ModelCapability): number | undefined => capability.benchmarks?.[scorer];
  return ({ candidates }) => {
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
