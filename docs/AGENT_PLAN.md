# swoosh — Agent harness & ecosystem plan (handoff)

> Handoff for an agent/dev picking up the next phase of swoosh. Read
> [`RESOLVER.md`](./RESOLVER.md) first — it's the thesis this plan builds on.

## 0. The decision (TL;DR)

Build swoosh's **own agent harness** as a package (`@swoosh-dev/agent`): an
**"unbundled" agent framework** that competes with Mastra / LangGraph / CrewAI,
but where **every primitive (routing, policies, Session, rerank, subagent
routing, usage) stays usable standalone** — unlike the bundled competitors.

- **Why a harness and not "swoosh-as-a-model adapter into other frameworks":**
  the model boundary is a universal seam (every framework takes a `model`), but
  the deeper agent primitives — *subagent selection especially* — have **no seam**
  in bundled frameworks (they own "which subagent" internally). You can't opt in
  at that abstraction level. So: be the open framework instead of trying to inject.
- **Differentiators (must be structurally true, not marketing):** open/a-la-carte
  (take any piece out), **inspectable routing** (a tree of `RoutePlan`s explaining
  every model/subagent/tool choice + rejections), and a lean/zero-dep core.

## 1. Repo, conventions, act-cold context

- **Repo:** `~/Projects/swoosh`, GitHub `acalejos/swoosh`, Apache-2.0. Bun monorepo.
- **Packages** (`@swoosh-dev/*`, version `0.3.0`; npm `latest` is `0.2.0`, so 0.3.0 is unreleased):
  `router` (core, in `packages/model-router/`), `sdk`, `ai-sdk`, `capabilities`,
  `judge`, `testing`.
- **Verify any change:** `bun run check:tsc`; `bun test packages` (currently **97 tests**);
  `bun run build` (tsup → ESM + d.ts). **Docs:** `bun run docs` = build + `scripts/gen-llms.ts`
  → regenerates `llms.txt` / `llms-full.txt` / `api/*.md` / `examples.html` in
  `packages/model-router/site/`. Human docs are hand-written `site/{index.html,docs.html}`
  (Kinetic theme). Pages + npm CI in `.github/workflows/{pages,release}.yml`.
- **Gotchas:**
  - `release.yml` rewrites `workspace:*` → `^version` before `npm publish` (npm
    doesn't rewrite the workspace protocol; bun/pnpm do). Keep that step.
  - `packages/model-router/dist/` is committed in-repo (gitignore exception) so
    consumers can use it as a git/`file:` dependency. **Rebuild after editing src.**
  - Consumers link to the live checkout, so they pick up rebuilds without reinstall:
    **Glowup** (`~/Documents/Glowup`, heavy user — 9-stage pipeline, custom policies,
    `UsageCollector`), **Forked** (`~/forked`, LLM rerank via `generate`), **Quizzical**
    (`~/Documents/cortex/quizcraft`, model routing + connector routing). These are the
    dogfood apps and demand sources.
  - Preview server ports collide with other local apps (Glowup etc.) — verify served
    output with `curl`, not just the preview iframe.
- **npm publishing:** org `swoosh-dev` requires 2FA; a bypass token is in the
  `NPM_TOKEN` repo secret; `v*` tags trigger `release.yml`.

## 2. The thesis (full detail in RESOLVER.md)

swoosh is a **resolver**: declare *intent* + *policy* → resolve to a concrete choice
over a **catalog of candidates**, with **explained rejections** and **fallback**.
Models are instance #1. Proven across models, rerankers, connectors, subagents, and
**Blip** (external Go sandbox-resolver — independent convergence).

**Five domain-supplied dimensions:** (1) fallback-safety `free|pinned|floor`,
(2) cardinality `single+fallback|top-K`, (3) requirement-hardness
`AND|OR|soft-rank`, (4) cost-model `per-token|per-search|cache-discounted`,
(5) policy-state/live-signals `rotation|sticky|cooldown|usage`.

**Conclusion: the router IS the kernel, used polymorphically.** Do NOT extract a
generic `resolve<C>` package or couple the kernel to models. **Extraction trigger
(not yet met):** model-specific field noise (`pricing`/`modalities` empty on
connectors/subagents) becoming intolerable across 3+ domain adapters.

## 3. What already exists (routing/resilience surface — essentially complete)

All in `@swoosh-dev/router` unless noted. Each is a-la-carte / composable.

- **Selection policies:** `namedPolicy` (cheapest/fastest/best_quality/balanced),
  `pin(ids)`, `qualityCap(max)`, `byCoverage(tags)` (soft tag match), `byBenchmark(src)`
  (name | blend fn | `{resolve}` async/live source), `sticky(currentId, base, {margin})`
  (prefix-cache stickiness), `loadBalance` / `roundRobin`.
- **Requirement filters:** `requiresFeatures` (hard AND), `requiresAnyFeatures` (hard OR);
  both produce explained rejections. `byCoverage` is the soft-rank alternative (drops
  silently — see open items).
- **Reranking:** `router.rerank()` / `planRerank()`; `rerank` capability descriptor +
  `ProviderAdapter.rerank`; `"explanations"` feature (route to reason-capable rerankers);
  `llmReranker({generateObject})` (LLM → rerank callback); 6 dedicated rerankers in
  `@swoosh-dev/capabilities` (Cohere/Voyage/Jina/mixedbread); `rerank.pricePerSearchUsd`
  for per-search billing.
- **Multimodal input:** first-class `TaskRequest.images` (`ImageInput` / `ImagePart`);
  `@swoosh-dev/ai-sdk` threads it through. (No more `metadata.images` smuggling.)
- **Resilience:** automatic fallback (always); `retry` (same-route exponential backoff +
  `retryOn`) and `timeout` (per-attempt) as request fields; `createHealthTracker` +
  `healthAware(base, tracker)` (cooldown — feed it `result.attempts`).
- **Session** (`createSession`) — **candidate-agnostic** stateful glue: holds
  health/sticky/budget, auto-wires the feedback loop (`preference()` to apply,
  `record(result)` to update). Budget downgrades to `"cheapest"` or `"throw"`. Reads
  only `RoutePlan` + `attempts` — never model-specific types (this is the rule that
  keeps the kernel generic).
- **Usage/cost:** adapters report tokens via a router-injected `reportUsage`; surfaces on
  `RouterAttempt.usage` + `RouterRunResult.usage`; `@swoosh-dev/ai-sdk` auto-reports for
  `generateObject`. `createUsageMeter()` = in-process token + actual-cost tally (no DB).
  Session budgets spend actual usage when present.
- **Testing** (`@swoosh-dev/testing`): `model`/`fakeCatalog`/`mockProvider`/`routerForTest`
  + fluent `expects(plan).selects()/rejects()/...` chain (framework-agnostic).
- **Connector routing — LIVE in Quizzical** (`~/Documents/cortex/quizcraft`,
  opt-in `autoConnectors`): `src/lib/server/connectors/{coverage.ts,connectorRouting.ts}`
  + `grounding.ts` wiring. Auto-selects knowledge connectors by topic via `byCoverage`.
  **Left uncommitted in that repo** (it has concurrent work) — review before committing.

## 4. The harness design — `@swoosh-dev/agent`

One package, **two tiers**, mirroring how `@swoosh-dev/sdk` exposes granular re-exports
plus `createRouter`:

```
primitives:  subagent · createAgentRouter · delegate · routeTools · trace   (usable alone)
harness:     createAgent(...)   ← pure composition over the primitives
```

**Three invariants (the "unbundled" promise made structural):**
1. Every piece is exported and usable outside the harness.
2. `createAgent` is composition over the public API — forkable, **no privileged
   internals**. If you can't rebuild it from the exports, it's too magic.
3. Eject at any layer: whole harness → subagent routing → just the router.

**Primitive sketches:**
```ts
interface SubagentDef {
  id: string;
  description?: string;            // fuels LLM-judge routing
  skills: string[];                // intent tags → byCoverage
  requiresFeatures?: ModelFeature[];
  inputModalities?: ModelModality[];
  run: (task: AgentTask, ctx: AgentContext) => Promise<AgentResult>;   // the payload
}
const subagent = (def: SubagentDef) => def;

// subagent routing = a resolver instance (catalog + side registry + tag policy)
createAgentRouter({ subagents, match?: "coverage" | RoutingPolicy }) => {
  plan(task): Promise<RoutePlan>,                      // WHICH subagent — inspectable
  route(task): Promise<{ chosen: SubagentDef; plan }>, // pick, don't run
  delegate(task, ctx?): Promise<AgentResult>,          // pick → run → fallback → record  (the "step")
};

routeTools(task, tools, opts?) => ToolDef[];           // tool SELECTION (not execution), via byCoverage/rerank
```

**Harness sketch:**
```ts
createAgent({
  router,                       // swoosh ModelRouter (required — the routing brain)
  instructions,
  subagents?: SubagentDef[],    // delegation → subagent routing
  tools?: ToolDef[],            // selection via routeTools
  toolExecutor?: ToolExecutor,  // SEAM — default impl provided; swap for MCP/sandbox
  memory?: Memory,              // SEAM — default in-memory; rerank-ranked context
  session?: Session,            // budget/health/usage/sticky across the run
  maxSteps?, stopWhen?,
}) => { run(input): Promise<{ output; trace: AgentStep[]; usage }> };
```

`run.trace` is a **tree of `RoutePlan`s** (route-to-subagent → subagent's model route →
…), each with selected + ranked fallbacks + rejected-with-reasons. This is the headline
differentiator — nobody else explains routing for free.

**Subsystem → built-on / seam:**

| Subsystem | Built on (public) | Standalone? |
|---|---|---|
| Loop (plan-act-observe) | `delegate` + `Session` | the only harness-specific code; forkable |
| Subagent delegation | `createAgentRouter` (resolver instance) | ✅ |
| Tool selection | `routeTools` | ✅ |
| Tool execution | `ToolExecutor` interface + default | ✅ swap/lift out |
| Memory | `Memory` interface + default; context via `rerank()` | ✅ |
| Resilience | `Session` + router (fallback/retry/cooldown/usage) | ✅ |
| Trace / cost | tree of `RoutePlan` + `createUsageMeter` | ✅ |

**Out of scope for the kernel; defaults-with-seams in the harness:** tool execution,
memory storage. **Never build into `@swoosh-dev/router`** — it stays the resolver kernel.

## 5. Phased build plan

Each phase ships an independently-usable piece; verify with tsc + tests + a focused
example; regenerate docs; commit + push.

- **Phase 1 — primitives.** `subagent`, `createAgentRouter`, `delegate`, `trace`, on the
  existing router + Session. ~80 lines. *Acceptance:* route a task to the best subagent
  with an inspectable plan; `delegate` runs it with fallback and records into a Session;
  usable with no loop. Add `examples/` + tests; wire the new package into tsconfig paths,
  root build, `release.yml` publish loop, and `gen-llms.ts` PACKAGES (see how `testing`
  was added).
- **Phase 2 — the loop.** `createAgent` over the primitives: plan-act-observe across
  subagents, `stopWhen`/`maxSteps`, Session-threaded budget/health/usage, the tree trace.
- **Phase 3 — tools.** `ToolExecutor` interface + a default direct executor + an MCP
  adapter; `routeTools` for selection.
- **Phase 4 — memory.** `Memory` interface + a default store; rerank-ranked context assembly.

**Dogfood gate:** Glowup's 9-stage pipeline must collapse onto `createAgent` *while still
able to drop to raw `router.run`*. If it doesn't simplify Glowup, the abstraction is wrong.

## 6. Domain-adapter pattern (connectors / sandboxes / other non-model catalogs)

Uniform shape so every non-model domain plugs into the engine identically:

> **`define → catalog → route` + a side registry for the payload**
> (`plan()` returns ids; the app holds the `Map<id, payload>`).

| Domain | capability (intent) | payload | package |
|---|---|---|---|
| Subagents | skills | `run()` | `@swoosh-dev/agent` (Phase 1) |
| Tools | input/effect tags | `call()` | `@swoosh-dev/agent` |
| Connectors | coverage tags | `search()`/`fetch()` | app today (Quizzical); extract `@swoosh-dev/connectors` on 2nd consumer |
| Sandboxes | isolation axes | `up()` | future (Blip-shaped) |

`@swoosh-dev/agent` is domain adapter #1 and demonstrates the shape. Extract other
domains into packages only when a 2nd consumer appears. The generic `Candidate`/`resolve<C>`
kernel is deferred (§2 trigger).

## 7. Distribution & landscape (context for positioning)

- **Seam analysis:** model boundary = *universal* seam (high distribution); rerank = RAG
  reranker seam (medium); subagent/tool/connector routing = *no seam in bundled frameworks*,
  only in "you own the routing" frameworks (LangGraph edges, Agents-SDK handoffs) or your
  own loop. This is exactly why the own-harness decision (§0) is correct.
- **`asModel(router, opts)` adapter** (swoosh as a "model" any framework accepts — Mastra
  dynamic fallback array, AI-SDK, LangChain): NOT the chosen primary play, but it's the
  highest-leverage *distribution* artifact (it carries all of swoosh's routing/resilience
  through the one universal seam). Keep as a **secondary** deliverable.
- **Mastra** (researched): an orchestration framework, not a routing kernel. Its "model
  routing" = provider dispatch + a hand-ordered fallback array; no capability catalog, no
  policy selection, no inspectable plan, no composable resilience, no resolver
  generalization. Overlap only in sequential fallback + rerank (as a RAG utility). swoosh
  is **complementary** (could sit under Mastra's `model:` field), not a feature subset.
- **LiteLLM-lean stance:** ship the routing/balancing/resilience pieces as composable
  functions; **never** the proxy server, virtual keys, spend DB, or dashboards. Embeddable
  library, not a gateway.

## 8. Open items / backlog

- **Agent harness Phases 1–4** (§5) — the active work.
- **Soft-requirement-with-reasons:** `byCoverage` drops zero-overlap candidates silently
  (policy-level, not in `plan.rejected`). A filter-variant could record reasons.
- **More LB strategies:** weighted / least-busy / usage-(TPM·RPM)-aware. `hedging` (fire
  top-N, take first) — opt-in, 2× cost. Cache-discounted cost (a `cachedInputTokens` hint
  + discounted `estimatedCostUsd`) to make `sticky`'s economics exact.
- **npm hygiene:** publish `0.3.0` (tag `v0.3.0`); deprecate the broken `0.1.0` of
  sdk/ai-sdk/capabilities/judge (shipped with `workspace:*`); migrate to **Trusted
  Publishing** (OIDC) so the bypass token can be removed and org 2FA re-enabled.
- **Connector routing:** review/commit the Quizzical changes; extract to a package on a
  2nd consumer.
- **Kernel extraction:** only when §2's trigger fires.

## 9. Guardrails for the executing agent

1. **Candidate-agnostic discipline:** stateful/glue code reads only `RoutePlan` + `attempts`,
   never `ModelCapability` specifics. This is what keeps the kernel generic across domains.
2. **Don't build orchestration into `@swoosh-dev/router`** — the kernel stays
   stateless-resolve + policies + resilience + Session. Orchestration lives in
   `@swoosh-dev/agent`.
3. **Keep the unbundled invariant:** the harness must be composition over public exports
   (no privileged internals); every subsystem behind a swappable interface.
4. **Fallback safety is domain-specific** (free/pinned/floor) — encode it, don't assume
   cross-model fallback is always safe (it isn't for embeddings; it is for rerank/subagents).
5. **Verify everything:** `bun run check:tsc` + `bun test packages` + `bun run build`;
   regenerate docs with `bun run docs`; commit + push (workflow scope is granted; dist is
   committed and consumed downstream, so rebuild before pushing).
6. **Let demand pull scope** — Glowup/Quizzical/Forked are the dogfood. Don't speculatively
   build what no consumer needs.
