// Builds src/capabilities.generated.json: the models.dev base, curated down to
// major providers, enriched with src/overrides.ts. Run by CI on a schedule (it
// opens a PR with the diff) or locally: `bun run build` from this package.
//
//   MODELS_DEV_URL  override the source (defaults to the live API)
//   MODELS_DEV_FILE  read a local api.json instead of fetching
//   SWOOSH_PROVIDERS   comma-separated provider allowlist (defaults below)
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  mergeCapabilities,
  normalizeModelsDevCatalog,
  type ModelCapability,
} from "@swoosh/router";
import { defaultOverrides } from "../src/overrides";

const DEFAULT_PROVIDERS = [
  "openai", "anthropic", "google", "google-vertex", "xai", "mistral", "groq",
  "deepseek", "cohere", "perplexity", "amazon-bedrock", "azure", "togetherai",
  "fireworks-ai", "openrouter",
];

const url = process.env.MODELS_DEV_URL ?? "https://models.dev/api.json";
const providers = new Set(
  (process.env.SWOOSH_PROVIDERS?.split(",").map((s) => s.trim()).filter(Boolean)) ?? DEFAULT_PROVIDERS,
);

const raw: unknown = process.env.MODELS_DEV_FILE
  ? JSON.parse(await Bun.file(process.env.MODELS_DEV_FILE).text())
  : await (await fetch(url)).json();

const base = normalizeModelsDevCatalog(raw).filter((m) => providers.has(m.providerId));
const enriched = mergeCapabilities(base, defaultOverrides);

// Sort deterministically so snapshot diffs stay readable.
const models = [...enriched].sort((a, b) =>
  `${a.providerId}/${a.modelId}`.localeCompare(`${b.providerId}/${b.modelId}`),
);

const snapshot = {
  source: url,
  generatedAt: new Date().toISOString(),
  providers: [...providers].sort(),
  count: models.length,
  models: models satisfies readonly ModelCapability[],
};

const out = join(import.meta.dir, "..", "src", "capabilities.generated.json");
writeFileSync(out, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`Wrote ${models.length} models from ${snapshot.providers.length} providers → ${out}`);
