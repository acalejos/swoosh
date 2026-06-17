import { namedPolicy } from "./policy";
import type {
  RankedModel,
  RouterAttempt,
  RoutingPolicy,
  RoutingPolicyContext,
  RoutingPreference,
} from "./types";

export type LoadBalanceStrategy = "round-robin" | "random";

export interface LoadBalanceOptions {
  /** Rotate selection among the top N candidates. Defaults to all of them. */
  readonly across?: number;
  /** How to pick within the top N each call. Defaults to `"round-robin"`. */
  readonly strategy?: LoadBalanceStrategy;
}

const resolveBase = async (
  base: RoutingPreference | RoutingPolicy,
  context: RoutingPolicyContext,
): Promise<readonly RankedModel[]> =>
  typeof base === "function"
    ? base(context)
    : namedPolicy(base, context.request.constraints?.preferredProviderIds)(context);

/**
 * Spread requests across the top-N candidates instead of always selecting #1 —
 * e.g. "cheapest, but cycle through the two cheapest providers." Wraps a base
 * preference or policy: it ranks first, then this rotates which of the top
 * `across` is selected on each call. The remaining candidates stay as ordered
 * fallbacks, so failover still works.
 *
 * Stateful by design — the returned policy holds a round-robin cursor, so reuse
 * one instance across requests rather than creating it per call.
 *
 *     const router = new ModelRouter({ catalog, providers });
 *     const balanced = loadBalance("cheapest", { across: 2 });
 *     await router.run({ ...request, preference: balanced }); // 1st of the two cheapest
 *     await router.run({ ...request, preference: balanced }); // 2nd of the two cheapest
 */
export const loadBalance = (
  base: RoutingPreference | RoutingPolicy,
  options: LoadBalanceOptions = {},
): RoutingPolicy => {
  const { across = Number.POSITIVE_INFINITY, strategy = "round-robin" } = options;
  let cursor = 0;
  return async (context) => {
    const ranked = [...(await resolveBase(base, context))];
    const n = Math.min(across, ranked.length);
    if (n <= 1) return ranked;
    const offset = strategy === "random" ? Math.floor(Math.random() * n) : cursor % n;
    if (strategy !== "random") cursor = (cursor + 1) % n;
    const group = ranked.slice(0, n);
    return [...group.slice(offset), ...group.slice(0, offset), ...ranked.slice(n)];
  };
};

/**
 * A round-robin iterator over a fixed list — returns the next item each call,
 * wrapping around. Handy for rotating API keys (or endpoints, accounts) within
 * a single provider adapter to spread rate limits:
 *
 *     const nextKey = roundRobin([process.env.OPENAI_KEY_A!, process.env.OPENAI_KEY_B!]);
 *     createCallbackProviderAdapter({
 *       providerId: "openai",
 *       generateObject: ({ prompt, model }) => callOpenAI(prompt, model.modelId, nextKey()),
 *     });
 */
export const roundRobin = <T>(items: readonly T[]): (() => T) => {
  if (items.length === 0) throw new Error("roundRobin requires at least one item.");
  let index = 0;
  return () => {
    const item = items[index] as T;
    index = (index + 1) % items.length;
    return item;
  };
};

export interface HealthTrackerOptions {
  /** How long a route stays cooled-down after tripping (ms). Default 30s. */
  readonly cooldownMs?: number;
  /** Consecutive failures before a route cools down. Default 1. */
  readonly failuresBeforeCooldown?: number;
}

export interface HealthTracker {
  /** Feed the attempts from a run result; failures trip cooldowns, a success clears them. */
  record(attempts: readonly RouterAttempt[]): void;
  isCoolingDown(providerId: string, modelId: string): boolean;
  reset(): void;
}

/**
 * Tracks per-route (`providerId/modelId`) failures and cooldowns from run
 * attempts — the lean, in-process half of LiteLLM-style health routing (no
 * server, no DB). Pair with {@link healthAware}; feed it `result.attempts` after
 * each run (the router already returns them):
 *
 *     const health = createHealthTracker({ cooldownMs: 60_000 });
 *     const policy = healthAware("cheapest", health);
 *     const res = await router.run({ ...request, preference: policy });
 *     health.record(res.attempts); // 429/5xx → that route is benched for 60s
 */
export const createHealthTracker = (options: HealthTrackerOptions = {}): HealthTracker => {
  const cooldownMs = options.cooldownMs ?? 30_000;
  const threshold = options.failuresBeforeCooldown ?? 1;
  const state = new Map<string, { failures: number; until: number }>();
  return {
    record(attempts) {
      const now = Date.now();
      for (const a of attempts) {
        const key = `${a.providerId}/${a.modelId}`;
        if (a.ok) {
          state.set(key, { failures: 0, until: 0 });
        } else {
          const prev = state.get(key) ?? { failures: 0, until: 0 };
          const failures = prev.failures + 1;
          state.set(key, { failures, until: failures >= threshold ? now + cooldownMs : prev.until });
        }
      }
    },
    isCoolingDown(providerId, modelId) {
      const s = state.get(`${providerId}/${modelId}`);
      return s !== undefined && s.until > Date.now();
    },
    reset() {
      state.clear();
    },
  };
};

/**
 * Wrap a base preference/policy to route around cooling-down deployments: ranks
 * with the base, then moves any route currently in cooldown to the back (kept as
 * last-resort fallbacks, never dropped — so an all-cooling-down catalog still
 * resolves). Stateful via the shared {@link HealthTracker}.
 */
export const healthAware = (
  base: RoutingPreference | RoutingPolicy,
  tracker: HealthTracker,
): RoutingPolicy => {
  return async (context) => {
    const ranked = await resolveBase(base, context);
    const healthy: RankedModel[] = [];
    const cooling: RankedModel[] = [];
    for (const r of ranked) {
      (tracker.isCoolingDown(r.capability.providerId, r.capability.modelId) ? cooling : healthy).push(r);
    }
    return [...healthy, ...cooling];
  };
};
