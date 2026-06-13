# swoosh — just give me a model

[![npm](https://img.shields.io/npm/v/@swoosh/router.svg)](https://www.npmjs.com/package/@swoosh/router)

```sh
npm install @swoosh/router
```

Intent-driven, policy-driven model routing. Describe **what** a task needs — modalities, structured output, tools, token estimates — and **how** to choose — cheapest, fastest, best quality, or a custom policy — and the router plans the best model, explains every rejection, and executes with automatic fallback.

Zero runtime dependencies — plain Promises, no framework to adopt. Provider-agnostic: bring any provider via a small adapter, or plug in the [Vercel AI SDK](https://sdk.vercel.ai).

## Packages

The core router has zero runtime dependencies. Provider integrations that pull in third-party SDKs live in their own packages so the core stays light.

| Package | Install | Contents |
| --- | --- | --- |
| [`@swoosh/sdk`](../sdk) | `npm i @swoosh/sdk ai @ai-sdk/openai` | **Batteries-included drop-in** — `createRouter()` with the enriched catalog and providers auto-wired from your API keys. Re-exports everything. |
| [`@swoosh/router`](.) | `npm i @swoosh/router` | Router engine, capability catalogs, policies, callback adapter |
| [`@swoosh/ai-sdk`](../ai-sdk) | `npm i @swoosh/ai-sdk ai` | Vercel AI SDK provider adapter (`ai` is a peer dependency) |
| [`@swoosh/capabilities`](../capabilities) | `npm i @swoosh/capabilities` | Curated, enriched model dataset + `defaultCatalog()` (models.dev ∪ web_search / latency / quality / benchmarks) |
| [`@swoosh/judge`](../judge) | `npm i @swoosh/judge` | Dynamic policies — classify the prompt with an LLM judge, route by the verdict |

## Why

Hard-coding `model: "gpt-..."` couples your application to one provider's naming, pricing, and outages. This router inverts that:

- **Intent, not model IDs.** Requests declare requirements (`inputModalities: ["text", "image"]`, `requiresFeatures: ["structured_output"]`), and the router finds models that satisfy them.
- **Policy, not hope.** Constraints (`maxCostUsd`, `maxLatencyClass`, provider allow/deny lists) are enforced at planning time, with a per-model rejection reason you can log or display.
- **Plans are inspectable.** `plan()` returns the selected model, ranked fallbacks, every rejected candidate with its reason, and a cost estimate — before anything is executed.
- **Execution falls back automatically.** `run()` / `runText()` walk the ranked routes until one succeeds, recording each attempt.

## Quick start

```ts
import { ModelRouter, ModelsDevCapabilityCatalog } from "@swoosh/router";
import { createAiSdkProviderAdapter } from "@swoosh/ai-sdk";
import { google } from "@ai-sdk/google";
import { generateObject } from "ai";

const router = new ModelRouter({
  // Live capability/pricing metadata from models.dev (or use createStaticCapabilityCatalog).
  catalog: new ModelsDevCapabilityCatalog(),
  providers: [
    createAiSdkProviderAdapter({
      providerId: "google",
      models: { "gemini-2.5-flash": google("gemini-2.5-flash") },
      generateObject: (request) => generateObject(request as never),
    }),
  ],
  defaultPreference: "balanced",
});

const recipe = await router.generateObject({
  task: "recipe.extract",
  input: pageText,
  prompt: "Extract the recipe from this page.",
  inputModalities: ["text"],
  requiresFeatures: ["structured_output"],
  preference: "cheapest",
  constraints: { maxCostUsd: 0.01 },
});
```

## Planning without executing

```ts
const plan = await router.plan({
  task: "video.summarize",
  input: videoUrl,
  inputModalities: ["video"],
  estimatedInputTokens: 120_000,
  preference: "fastest",
  constraints: { deniedProviderIds: ["openai"], maxLatencyClass: "standard" },
});

plan.selected;  // { capability, score, reason, estimatedCostUsd }
plan.fallbacks; // ranked alternates, tried in order on failure
plan.rejected;  // [{ providerId, modelId, reason: "Estimated cost exceeds policy." }, ...]
plan.estimate;  // { inputTokens, outputTokens, costUsd }
```

## Custom routing policies

A policy is just a function from ranked candidates to ranked candidates — pass it as the `preference`:

```ts
import type { RoutingPolicy } from "@swoosh/router";

const euOnlyThenCheapest: RoutingPolicy = ({ candidates }) =>
  candidates
    .filter((candidate) => EU_PROVIDERS.has(candidate.capability.providerId))
    .sort((a, b) => (a.estimatedCostUsd ?? Infinity) - (b.estimatedCostUsd ?? Infinity));
```

Policies can be **async**, which unlocks dynamic routing — e.g. classifying the prompt with an LLM judge before choosing (see [`@swoosh/judge`](../judge)). And `byBenchmark` ranks on benchmark scores, by a single name or a composite scoring function:

```ts
import { byBenchmark } from "@swoosh/router";

preference: byBenchmark("swe_bench", { minimum: 0.5 });
preference: byBenchmark((m) => 0.7 * (m.benchmarks?.swe_bench ?? 0) + 0.3 * (m.benchmarks?.gpqa ?? 0));
```

## Provider adapters

Adapters are tiny — implement `generateObject` and/or `generateText` against your client of choice:

```ts
import { createCallbackProviderAdapter } from "@swoosh/router";

const anthropic = createCallbackProviderAdapter({
  providerId: "anthropic",
  isAvailable: () => Boolean(process.env.ANTHROPIC_API_KEY),
  generateText: async ({ model, prompt }) => callClaude(model.modelId, prompt),
});
```

## Capability catalogs

`ModelCapability` is the canonical schema the router reads — the "columns" your source populates. models.dev is just one built-in source; opt out entirely and bring your own via `createCapabilityCatalog`, which wraps any sync/async loader (a DB query, an internal API, a cached file):

```ts
import { createCapabilityCatalog, normalizeModelsDevCatalog } from "@swoosh/router";

// Map your own rows onto the ModelCapability shape.
const catalog = createCapabilityCatalog(async () => {
  const rows = await db.select().from(models);
  return rows.map(toModelCapability);
});

// Or, if your rows are already in models.dev's JSON shape, reuse the normalizer:
const cached = createCapabilityCatalog(() => normalizeModelsDevCatalog(cachedJson));
```

`createStaticCapabilityCatalog` (fixed array) and `ModelsDevCapabilityCatalog` (live fetch) are the other two built-ins — all three satisfy the same `CapabilityCatalog` interface.

### Scoping to the models you can access

A catalog lists the *universe* of models; you rarely have access to all of them. Declare what you can actually use **once, at construction** — the config still comes from the catalog, you only name the ids. `filterCapabilityCatalog` wraps any catalog with an allowlist or a predicate:

```ts
import { ModelsDevCapabilityCatalog, filterCapabilityCatalog } from "@swoosh/router";

// Allowlist exact models (a bare modelId matches across providers):
const catalog = filterCapabilityCatalog(new ModelsDevCapabilityCatalog(), [
  "openai/gpt-4o",
  "anthropic/claude-haiku-4-5",
]);

// Or a predicate, re-evaluated each plan — read live entitlements:
const scoped = filterCapabilityCatalog(new ModelsDevCapabilityCatalog(), (m) =>
  tenant.enabledModels.has(`${m.providerId}/${m.modelId}`),
);
```

You have five composable options — provider keys via adapter `isAvailable()` (use `hasApiKey("openai")`, which checks the conventional env vars like `OPENAI_API_KEY` / `GEMINI_API_KEY`), an allowlist, a predicate, a bring-your-own-DB catalog, or live discovery from a provider's list-models endpoint. See [Model access in the docs](site/docs.html) for all five.

## Examples

The [examples directory](examples/README.md) has eleven runnable scripts — quickstart, cost guardrails, multimodal routing, custom policy, outage fallback, bring-your-own-catalog, model access, web search, load balancing, benchmark routing, and an LLM judge. All of them run offline with simulated providers:

```sh
bun packages/model-router/examples/01-quickstart.ts
```

## Module map

| Module | Contents |
| --- | --- |
| `types` | Request/plan/capability types, `ModelRouterError` |
| `catalog` | `createCapabilityCatalog` (bring your own DB/API), `filterCapabilityCatalog` (scope to accessible models), `mergeCapabilities` (enrich with overrides), `createStaticCapabilityCatalog`, `ModelsDevCapabilityCatalog`, `normalizeModelsDevCatalog` |
| `policy` | Built-in preference policies, `byBenchmark` (rank by a benchmark or composite score), cost estimation, quality scoring |
| `balance` | `loadBalance` (rotate across the top-N providers), `roundRobin` (rotate keys within a provider) |
| `router` | `ModelRouter` — `plan`, `run`, `runText`, `generateObject`, `generateText` |
| `adapters` | `createCallbackProviderAdapter` |
| `env` | `hasApiKey`, `apiKeyEnvVars`, `apiKeyEnvVarsFor` — detect provider keys from the environment |

Everything is re-exported from the package root.
