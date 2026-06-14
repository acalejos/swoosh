# swoosh-capabilities

> Curated, enriched model dataset (models.dev ∪ web_search / latency / quality / benchmarks).

`npm install swoosh-capabilities` · [source](https://github.com/acalejos/swoosh/tree/main/packages/capabilities)

# swoosh-capabilities

A curated, ready-to-use model-capability dataset for [`swoosh-router`](../model-router) — the models.dev catalog, narrowed to major providers and **enriched with the things models.dev doesn't carry**: `web_search` support, latency classes, quality scores (which `fastest` / `best_quality` need), and per-domain `benchmarks` (which `byBenchmark` ranks on).

```sh
npm install swoosh-capabilities
```

```ts
import { ModelRouter } from "swoosh-router";
import { defaultCatalog } from "swoosh-capabilities";

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

`bun run refresh` (see [scripts/build.ts](scripts/build.ts)) pulls `models.dev/api.json`, normalizes it via `swoosh-router`'s `normalizeModelsDevCatalog`, narrows it to a major-provider allowlist (`SWOOSH_PROVIDERS` to override), merges [src/overrides.ts](src/overrides.ts) with `mergeCapabilities`, sorts deterministically, and writes `src/capabilities.generated.json`.

CI runs this on a schedule and opens a PR with the diff ([ci/refresh-capabilities.yml](ci/refresh-capabilities.yml)) — refreshes are **reviewed, never auto-merged**, so a models.dev change can't silently alter routing.

## Adding enrichment

Edit [src/overrides.ts](src/overrides.ts) — small, reviewed entries keyed by `providerId/modelId`, citing the provider doc/pricing source in the PR. **Don't auto-scrape provider docs**: doc HTML rots silently and would emit wrong data. Per-provider scrapers, if ever added, should be human-run helpers whose output a reviewer eyeballs before commit.

Prefer live data plus overrides instead of the bundled snapshot? Use the primitive directly:

```ts
import { ModelsDevCapabilityCatalog, createCapabilityCatalog, mergeCapabilities } from "swoosh-router";
import { defaultOverrides } from "swoosh-capabilities";

const live = new ModelsDevCapabilityCatalog();
const enriched = createCapabilityCatalog(async () =>
  mergeCapabilities(await live.listCapabilities(), defaultOverrides),
);
```

## Type definitions

Generated from source — the authoritative public API.

```ts
import { CapabilityOverride, ModelCapability, CapabilityCatalog } from 'swoosh-router';

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
declare const defaultOverrides: readonly CapabilityOverride[];

/** When the bundled snapshot was generated, and from where. */
declare const meta: {
    readonly source: string;
    readonly generatedAt: string;
    readonly count: number;
};
/** The bundled, enriched capability dataset (models.dev ∪ curated overrides). */
declare const capabilities: readonly ModelCapability[];
/** A ready-to-use catalog backed by the bundled dataset — no network, no keys. */
declare const defaultCatalog: () => CapabilityCatalog;

export { capabilities, defaultCatalog, defaultOverrides, meta };
```
