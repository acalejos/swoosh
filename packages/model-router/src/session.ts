import { healthAware, type HealthTracker } from "./balance";
import { estimatedCostUsd, namedPolicy, sticky, type StickyOptions } from "./policy";
import {
  type ModelCapability,
  ModelRouterError,
  type RoutePlan,
  type RouterAttempt,
  type RoutingPolicy,
  type RoutingPreference,
  type TokenUsage,
} from "./types";

// The candidate that actually served a run: the winning attempt's model, else
// the planned selection (works for any resolver — reads only plan + attempts).
const servedCapability = (
  plan: RoutePlan,
  attempts?: readonly RouterAttempt[],
): ModelCapability => {
  const winner = [...(attempts ?? [])].reverse().find((a) => a.ok);
  if (!winner) return plan.selected.capability;
  return (
    [plan.selected, ...plan.fallbacks].find(
      (r) => r.capability.providerId === winner.providerId && r.capability.modelId === winner.modelId,
    )?.capability ?? plan.selected.capability
  );
};

// Actual cost when the adapter reported usage, else the plan's estimate.
const resultCost = (result: SessionResult): number => {
  if (result.usage) {
    const cap = servedCapability(result.plan, result.attempts);
    const cost = estimatedCostUsd(cap, result.usage.inputTokens ?? 0, result.usage.outputTokens ?? 0);
    if (cost !== undefined) return cost;
  }
  return result.plan.estimate.costUsd ?? 0;
};

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

/** A result to feed back — anything carrying a plan, the run attempts, and usage. */
export interface SessionResult {
  readonly plan: RoutePlan;
  readonly attempts?: readonly RouterAttempt[];
  readonly usage?: TokenUsage;
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
      spent += resultCost(result);
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

export interface UsageMeter {
  /** Accumulate a run/route result into the running totals. */
  record(result: SessionResult): void;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Total cost — actual (from reported usage) where available, else plan estimate. */
  readonly costUsd: number;
  /** Number of results recorded. */
  readonly calls: number;
  reset(): void;
}

/**
 * In-process cost/token accounting — the lean alternative to a spend database.
 * Feed it run results; read the running totals. No server, no persistence; if
 * you want durability, snapshot `{ inputTokens, outputTokens, costUsd, calls }`
 * yourself. Like {@link createSession}, it reads only the generic plan + usage.
 *
 *     const meter = createUsageMeter();
 *     const res = await router.run(request);
 *     meter.record(res);
 *     meter.costUsd; // running spend
 */
export const createUsageMeter = (): UsageMeter => {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let calls = 0;
  return {
    record(result) {
      inputTokens += result.usage?.inputTokens ?? 0;
      outputTokens += result.usage?.outputTokens ?? 0;
      costUsd += resultCost(result);
      calls += 1;
    },
    get inputTokens() {
      return inputTokens;
    },
    get outputTokens() {
      return outputTokens;
    },
    get costUsd() {
      return costUsd;
    },
    get calls() {
      return calls;
    },
    reset() {
      inputTokens = 0;
      outputTokens = 0;
      costUsd = 0;
      calls = 0;
    },
  };
};
