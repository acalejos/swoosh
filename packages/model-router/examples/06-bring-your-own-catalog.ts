// Opt out of models.dev: source the catalog from your own database (or any
// async loader) while still producing the canonical ModelCapability shape.
// Run from the repo root: bun packages/model-router/examples/06-bring-your-own-catalog.ts
import {
  createCallbackProviderAdapter,
  createCapabilityCatalog,
  type ModelCapability,
  ModelRouter,
} from "@swoosh/router";
import { printPlan } from "./shared/print";

// Pretend this is a table in your database. The "columns" are exactly the
// ModelCapability fields — your row maps straight onto the interface.
interface ModelRow {
  provider: string;
  model: string;
  vision: boolean;
  ctx: number;
  inUsdPerM: number;
  outUsdPerM: number;
}

const rows: ModelRow[] = [
  { provider: "internal", model: "house-small", vision: false, ctx: 32_000, inUsdPerM: 0, outUsdPerM: 0 },
  { provider: "internal", model: "house-large", vision: true, ctx: 200_000, inUsdPerM: 0.5, outUsdPerM: 1.5 },
];

const rowToCapability = (row: ModelRow): ModelCapability => ({
  providerId: row.provider,
  providerName: "Internal",
  modelId: row.model,
  modelName: row.model,
  inputModalities: row.vision ? ["text", "image"] : ["text"],
  outputModalities: ["text"],
  features: row.vision
    ? ["structured_output", "tools", "attachments"]
    : ["structured_output", "tools"],
  limits: { contextTokens: row.ctx },
  pricing: { inputPerMillionTokens: row.inUsdPerM, outputPerMillionTokens: row.outUsdPerM },
  latencyClass: "fast",
});

const router = new ModelRouter({
  // No models.dev — load and map your own rows. Could be a DB query, an API, a file.
  catalog: createCapabilityCatalog(async () => {
    const fetched = await Promise.resolve(rows); // e.g. await db.select().from(models)
    return fetched.map(rowToCapability);
  }),
  providers: ["internal"].map((providerId) => createCallbackProviderAdapter({ providerId })),
});

const plan = await router.plan({
  task: "doc.summarize",
  input: "(an internal document)",
  inputModalities: ["text"],
  preference: "cheapest",
});

// Routes purely against your own catalog — house-small wins on price.
printPlan(plan);
