import { healthAware, type HealthTracker } from "./balance";
import { namedPolicy, sticky, type StickyOptions } from "./policy";
import {
  ModelRouterError,
  type RoutePlan,
  type RouterAttempt,
  type RoutingPolicy,
  type RoutingPreference,
} from "./types";

// A Session is candidate-agnostic on purpose: it reads only RoutePlan + attempts
// (which every resolver instance produces — models, connectors, subagents), never
// a model-specific type. So it composes with any routing, the same way policies do.

export interface SessionOptions {
  /** Cooldown/health tracker — fed each result; routing then avoids cooling-down routes. */
  readonly health?: HealthTracker;
  /** Prefer the warm (last-served) candidate to preserve its prompt-prefix cache. */
  readonly sticky?: boolean | StickyOptions;
  /** Cap total cost across the session (uses each plan's cost estimate). */
  readonly budgetUsd?: number;
  /** Once the budget is spent: downgrade to `"cheapest"` (default) or `"throw"`. */
  readonly onBudgetExceeded?: "cheapest" | "throw";
}

/** A result to feed back — anything carrying a plan and (optionally) the run attempts. */
export interface SessionResult {
  readonly plan: RoutePlan;
  readonly attempts?: readonly RouterAttempt[];
}

export interface Session {
  /** Wrap a base preference with the session's stateful policies (health → sticky, or budget override). */
  preference(base: RoutingPreference | RoutingPolicy): RoutingPolicy;
  /** Feed a result back: updates health (attempts), spend (estimate), and the warm candidate. */
  record(result: SessionResult): void;
  readonly spent: number;
  readonly remaining: number;
  reset(): void;
}

const asPolicy = (base: RoutingPreference | RoutingPolicy): RoutingPolicy =>
  typeof base === "function" ? base : namedPolicy(base);

const idOf = (providerId: string, modelId: string) => `${providerId}/${modelId}`;

/**
 * A per-run / per-conversation state container over the (stateless) router — the
 * natural home for the stateful pieces (health, sticky, budget). It auto-wires
 * the feedback loop you'd otherwise thread by hand:
 *
 *     const session = createSession({ health: createHealthTracker(), budgetUsd: 5, sticky: true });
 *     const res = await router.run({ ...request, preference: session.preference("balanced") });
 *     session.record(res);   // updates health, spend, and the warm model
 *     session.remaining;     // budget left
 *
 * Opt into only what you need; with no options it's a no-op passthrough.
 */
export const createSession = (options: SessionOptions = {}): Session => {
  const stickyOptions: StickyOptions = typeof options.sticky === "object" ? options.sticky : {};
  const useSticky = options.sticky !== undefined && options.sticky !== false;
  let spent = 0;
  let warm: string | undefined;

  const overBudget = () => options.budgetUsd !== undefined && spent >= options.budgetUsd;

  return {
    preference(base) {
      if (overBudget()) {
        if (options.onBudgetExceeded === "throw") {
          return () => {
            throw new ModelRouterError(
              `Session budget of $${options.budgetUsd} is exhausted ($${spent.toFixed(4)} spent).`,
            );
          };
        }
        // budget override: cheapest, still health-aware, but NOT sticky (cost trumps cache warmth)
        return options.health ? healthAware("cheapest", options.health) : namedPolicy("cheapest");
      }
      let policy: RoutingPolicy = options.health
        ? healthAware(base, options.health)
        : asPolicy(base);
      if (useSticky) policy = sticky(warm, policy, stickyOptions);
      return policy;
    },
    record(result) {
      options.health?.record(result.attempts ?? []);
      spent += result.plan.estimate.costUsd ?? 0;
      // warm = the candidate that actually served (last ok attempt), else the planned selection
      const served = [...(result.attempts ?? [])].reverse().find((a) => a.ok);
      warm = served
        ? idOf(served.providerId, served.modelId)
        : idOf(result.plan.selected.capability.providerId, result.plan.selected.capability.modelId);
    },
    get spent() {
      return spent;
    },
    get remaining() {
      return options.budgetUsd === undefined ? Infinity : Math.max(0, options.budgetUsd - spent);
    },
    reset() {
      spent = 0;
      warm = undefined;
      options.health?.reset();
    },
  };
};
