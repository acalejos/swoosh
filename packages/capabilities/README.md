# @swoosh-dev/capabilities

A curated, ready-to-use model-capability dataset for [`@swoosh-dev/router`](../model-router) — the models.dev catalog, narrowed to major providers and **enriched with the things models.dev doesn't carry**: `web_search` support, latency classes, quality scores (which `fastest` / `best_quality` need), and per-domain `benchmarks` (which `byBenchmark` ranks on).

```sh
npm install @swoosh-dev/capabilities
```

```ts
import { ModelRouter } from "@swoosh-dev/router";
import { defaultCatalog } from "@swoosh-dev/capabilities";

const router = new ModelRouter({
  catalog: defaultCatalog(), // bundled snapshot — no network, no API keys
  providers: [/* your adapters */],
});
```

## What it exports

| Export | What |
| --- | --- |
| `defaultCatalog()` | A `CapabilityCatalog` backed by the bundled snapshot (offline, synchronous). |
| `capabilities` | The raw `ModelCapability[]` dataset. |
| `defaultOverrides` | The curated enrichment layer (also usable with `mergeCapabilities` on a live catalog). |
| `meta` | `{ source, generatedAt, count }` for the bundled snapshot. |

## How it's built

`bun run refresh` (see [scripts/build.ts](scripts/build.ts)) pulls `models.dev/api.json`, normalizes it via `@swoosh-dev/router`'s `normalizeModelsDevCatalog`, narrows it to a major-provider allowlist (`SWOOSH_PROVIDERS` to override), merges [src/overrides.ts](src/overrides.ts) with `mergeCapabilities`, sorts deterministically, and writes `src/capabilities.generated.json`.

CI runs this on a schedule and opens a PR with the diff ([ci/refresh-capabilities.yml](ci/refresh-capabilities.yml)) — refreshes are **reviewed, never auto-merged**, so a models.dev change can't silently alter routing.

## Adding enrichment

Edit [src/overrides.ts](src/overrides.ts) — small, reviewed entries keyed by `providerId/modelId`, citing the provider doc/pricing source in the PR. **Don't auto-scrape provider docs**: doc HTML rots silently and would emit wrong data. Per-provider scrapers, if ever added, should be human-run helpers whose output a reviewer eyeballs before commit.

Prefer live data plus overrides instead of the bundled snapshot? Use the primitive directly:

```ts
import { ModelsDevCapabilityCatalog, createCapabilityCatalog, mergeCapabilities } from "@swoosh-dev/router";
import { defaultOverrides } from "@swoosh-dev/capabilities";

const live = new ModelsDevCapabilityCatalog();
const enriched = createCapabilityCatalog(async () =>
  mergeCapabilities(await live.listCapabilities(), defaultOverrides),
);
```
