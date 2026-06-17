# swoosh as a resolver kernel

> Status: design note / thesis. Captures where the routing engine generalizes and
> — importantly — where it should **not** grow into a framework.

## Thesis

swoosh is not fundamentally a "model router." Its primitive is a **resolver**:

> declare **intent** + **policy** → resolve to a concrete choice over a **catalog of
> candidates**, where every rejection carries a **reason** and execution **falls back**.

"Models" is instance #1. The same engine routes anything with declared capabilities.

## The resolution shape (the engine)

```
catalog of candidates (each declares capabilities)
  → filter by the request's requirements        → rejected[] (each with a reason)
  → rank the survivors by a policy (preference)  → selected + ranked fallbacks
  → execute with fallback, recording attempts    → inspectable RoutePlan + result
```

`ModelRouter.plan()` is this for `ModelCapability`. Nothing in the loop is
model-specific except the candidate type.

## The five dimensions (each is domain-supplied)

Lining up real instances surfaced five axes a resolver must let the domain set:

1. **Fallback safety** — `free | pinned | floor-gated`.
   rerank = free (stateless); embeddings = pinned (vector spaces differ, silent
   corruption); sandbox(Blip) = floor-gated (never silently weaken a boundary).
2. **Cardinality** — `single + fallback | top-K fan-out`.
   models/subagents = single; connectors/rerank = top-K.
3. **Requirement hardness** — `hard-AND (requiresFeatures) | hard-OR
   (requiresAnyFeatures) | soft-rank (byCoverage)`. Hard filters explain their
   rejections; soft-rank drops silently (open item below).
4. **Cost model** — per-token | per-search (`rerank.pricePerSearchUsd`) |
   cache-discounted. Pluggable; cost-based policies read it.
5. **Policy state & live signals** — the ranking stage may be **stateful** and read
   live signals: rotation cursors (`roundRobin`/`loadBalance`), warm-cache identity
   (`sticky`), in-flight counts (least-busy), recent TPM/RPM, error cooldowns.
   The policy is a closure, not a pure function — this is what makes LiteLLM-style
   balancing fit without a server (see below).

## Instances (proof the engine generalizes)

| Instance | Catalog | Notes |
|---|---|---|
| **Models** | `ModelCapability` (`@swoosh-dev/capabilities`) | instance #1 |
| **Rerankers** | reranker `ModelCapability`s | top-K, safe fallback, per-search cost |
| **Connectors** | knowledge sources (Quizzical's 22) | tag routing via `byCoverage`; "plan returns ids, app holds payload" |
| **Subagents** | `{ id, skills, run }` | single-select; payload via a side registry; no engine change |
| **Sandboxes** | Blip (Go, external) | independent convergence: `blip plan` = `plan()`, drivers = catalog, `MissingGuarantees` = explained rejections, downgrade-gate = fallback policy |

Three TS instances + one external (Go) converged on the same skeleton — twice over,
independently. The shape is fundamental.

## Conclusion: the router *is* the kernel

You do **not** need a separate `@swoosh-dev/resolve` package or an agent-harness
framework to get the generalization. Every instance so far is "point the existing
`ModelRouter` at a different catalog + (for non-model payloads) a side registry +
a tag policy." The **subagent router** — the agent primitive — is `router + Map +
byCoverage`, ~30 lines, no new package.

What makes each new domain turnkey is a handful of **policy/verb helpers**, already
shipped: `byCoverage` (soft tags), `requiresAnyFeatures` (hard OR), `pin`,
`qualityCap`, `sticky` (cache-aware), `byBenchmark({resolve})` (live scores),
`loadBalance`/`roundRobin` (rotation), plus the `rerank` verb.

**Extraction trigger (not yet met):** a generic `Candidate { id, tags, meta }` base
is only worth it when the model-specific field noise (`pricing`/`modalities` empty
on connectors/subagents) becomes intolerable. Three instances tolerated it — defer.

## LiteLLM, the lean subset

LiteLLM's *routing intelligence* fits swoosh as **stateful policies** (dimension 5);
its *heft* is the proxy server — which swoosh should never become.

- **Fits (as policies/light state, embedded):** multiple deployments of one model
  (just more catalog entries), weighted / least-busy / latency- / usage-(TPM·RPM)-
  aware strategies, error **cooldowns** on 429s (deprioritize a hot deployment;
  fallback covers the miss), key rotation (`roundRobin`).
- **Skip (the heft):** the proxy/gateway, virtual keys, spend DB, dashboards,
  response caching. swoosh stays an embeddable library, not a gateway.

## Open items

- **Soft requirement with reasons** — `byCoverage` drops zero-overlap candidates
  silently (policy-level), unlike hard filters. A filter-variant could record
  rejections for a full audit trail.
- **Cache-discounted cost** — `sticky` handles the switch decision; a
  `cachedInputTokens` request hint + discounted `estimatedCostUsd` would make the
  *cost* accurate too.
- **Health/cooldown-aware policy** — the lean LiteLLM piece most likely to be
  pulled next (by load-balanced production use).
