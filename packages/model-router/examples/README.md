# Examples

Every example runs offline — providers are simulated with `createCallbackProviderAdapter`, so you can see routing behavior without API keys. From the repo root:

```sh
bun packages/model-router/examples/01-quickstart.ts
```

| Example | Shows |
| --- | --- |
| [01-quickstart.ts](01-quickstart.ts) | Route a task, get structured output, read the plan and attempts |
| [02-cost-guardrails.ts](02-cost-guardrails.ts) | `maxCostUsd` rejects over-budget models before any tokens are spent |
| [03-multimodal-routing.ts](03-multimodal-routing.ts) | Image input filters out text-only models automatically |
| [04-custom-policy.ts](04-custom-policy.ts) | A custom policy function (EU data residency, then cheapest) |
| [05-outage-fallback.ts](05-outage-fallback.ts) | Automatic fallback across providers during an outage, with attempt history |
| [06-bring-your-own-catalog.ts](06-bring-your-own-catalog.ts) | Source the catalog from your own DB via `createCapabilityCatalog` — no models.dev |
| [07-model-access.ts](07-model-access.ts) | Scope a broad catalog to the models you can access with `filterCapabilityCatalog` + provider-key gating |
| [08-web-search.ts](08-web-search.ts) | Route a current-events task to a web-search-capable model via `requiresFeatures: ["web_search"]` |
| [09-load-balancing.ts](09-load-balancing.ts) | `loadBalance` spreads across the cheapest providers; `roundRobin` rotates API keys within one |
| [10-benchmark-routing.ts](10-benchmark-routing.ts) | Route by benchmark with `byBenchmark` — a named score or a composite scoring function |
| [11-llm-judge.ts](11-llm-judge.ts) | Dynamic routing: an LLM judge classifies the prompt, then routes by verdict (`@swoosh-dev/judge`) |

To call real providers, replace the callback adapters with `createAiSdkProviderAdapter` — see the [package README](../README.md#quick-start) for the wiring.
