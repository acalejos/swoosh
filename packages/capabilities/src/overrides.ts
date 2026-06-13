import type { CapabilityOverride } from "swoosh-router";

/**
 * Curated enrichment layered over the models.dev base — the capabilities
 * models.dev does not carry. Keep entries small and reviewed; each is matched
 * to a base model by `providerId/modelId`. Sources should be cited in the PR
 * that adds them (provider docs, pricing pages), not scraped automatically.
 *
 * Four kinds of enrichment live here:
 *   • `features` models.dev omits — notably `"web_search"`.
 *   • `latencyClass` — models.dev has no latency signal; swoosh's "fastest" needs it.
 *   • `qualityScore` — a 0–10 hand rank; swoosh's "best_quality" falls back to a
 *     heuristic without it.
 *   • `benchmarks` — per-domain scores for the `byBenchmark` policy. Values below
 *     are representative seeds; CI should refresh them from a cited source
 *     (Artificial Analysis, LMArena Elo, model-card GPQA/SWE-bench), never scraped.
 */
export const defaultOverrides: readonly CapabilityOverride[] = [
  // ── OpenAI ──────────────────────────────────────────────────────────────
  { providerId: "openai", modelId: "gpt-4o", features: ["web_search"], latencyClass: "standard", qualityScore: 8, benchmarks: { gpqa: 0.53, swe_bench: 0.33, lmarena_elo: 1285 } },
  { providerId: "openai", modelId: "gpt-5", features: ["web_search"], latencyClass: "standard", qualityScore: 9.2, benchmarks: { gpqa: 0.85, swe_bench: 0.72, lmarena_elo: 1410 } },
  { providerId: "openai", modelId: "o3", latencyClass: "slow", qualityScore: 9, benchmarks: { gpqa: 0.83, swe_bench: 0.69, lmarena_elo: 1390 } },
  { providerId: "openai", modelId: "o4-mini", latencyClass: "fast", qualityScore: 8, benchmarks: { gpqa: 0.78, swe_bench: 0.68, lmarena_elo: 1350 } },

  // ── Anthropic ───────────────────────────────────────────────────────────
  { providerId: "anthropic", modelId: "claude-opus-4-8", features: ["web_search"], latencyClass: "slow", qualityScore: 10, benchmarks: { gpqa: 0.84, swe_bench: 0.78, lmarena_elo: 1420 } },
  { providerId: "anthropic", modelId: "claude-sonnet-4-5", features: ["web_search"], latencyClass: "standard", qualityScore: 8.5, benchmarks: { gpqa: 0.79, swe_bench: 0.74, lmarena_elo: 1370 } },
  { providerId: "anthropic", modelId: "claude-haiku-4-5-20251001", features: ["web_search"], latencyClass: "fast", qualityScore: 7.5, benchmarks: { gpqa: 0.69, swe_bench: 0.58, lmarena_elo: 1320 } },

  // ── Google ──────────────────────────────────────────────────────────────
  { providerId: "google", modelId: "gemini-2.5-pro", features: ["web_search"], latencyClass: "standard", qualityScore: 9, benchmarks: { gpqa: 0.84, swe_bench: 0.64, lmarena_elo: 1400 } },
  { providerId: "google", modelId: "gemini-2.5-flash", features: ["web_search"], latencyClass: "fast", qualityScore: 7.5, benchmarks: { gpqa: 0.68, swe_bench: 0.54, lmarena_elo: 1330 } },
  { providerId: "google", modelId: "gemini-2.5-flash-lite", features: ["web_search"], latencyClass: "fast", qualityScore: 6.5, benchmarks: { gpqa: 0.57, swe_bench: 0.41, lmarena_elo: 1270 } },

  // ── xAI ─────────────────────────────────────────────────────────────────
  { providerId: "xai", modelId: "grok-4.3", features: ["web_search"], latencyClass: "standard", qualityScore: 8.5, benchmarks: { gpqa: 0.81, swe_bench: 0.67, lmarena_elo: 1385 } },

  // ── Perplexity (search-native) ────────────────────────────────────────────
  { providerId: "perplexity", modelId: "sonar", features: ["web_search"], latencyClass: "fast", qualityScore: 6.5 },
  { providerId: "perplexity", modelId: "sonar-pro", features: ["web_search"], latencyClass: "standard", qualityScore: 7.5 },
  { providerId: "perplexity", modelId: "sonar-reasoning-pro", features: ["web_search", "reasoning"], latencyClass: "slow", qualityScore: 8 },
];
