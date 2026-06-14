// Tell the router which models you actually have access to — declared once,
// not per request. A broad catalog (here the fixture; in production, models.dev)
// supplies the configs; you intersect it down to your accessible set.
// Run from the repo root: bun packages/model-router/examples/07-model-access.ts
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  filterCapabilityCatalog,
  hasApiKey,
  ModelRouter,
} from "@swoosh-dev/router";
import { exampleCatalog } from "./shared/catalog";
import { printPlan } from "./shared/print";

// The full catalog lists models across google, anthropic, openai, mistral, local.
const universe = createStaticCapabilityCatalog(exampleCatalog);

// Option A — allowlist the exact models your account/contract permits.
// Configs (pricing, limits, features) still come from the catalog; you only name ids.
const accessible = filterCapabilityCatalog(universe, [
  "google/gemini-2.5-flash",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-4o",
]);

// Option B — gate whole providers by whether their API key is present.
// hasApiKey looks up the conventional env var(s) per provider (GEMINI_API_KEY,
// OPENAI_API_KEY, …). It reads process.env by default; here we inject a fake
// env so the example is deterministic offline.
const env = { GEMINI_API_KEY: "demo", OPENAI_API_KEY: "demo" }; // no ANTHROPIC_API_KEY
const providers = ["google", "anthropic", "openai", "mistral", "local"].map((providerId) =>
  createCallbackProviderAdapter({ providerId, isAvailable: () => hasApiKey(providerId, { env }) }),
);

const router = new ModelRouter({ catalog: accessible, providers });

const plan = await router.plan({
  task: "doc.classify",
  input: "(a document)",
  inputModalities: ["text"],
  requiresFeatures: ["structured_output"],
  preference: "cheapest",
});

// Only the three allowlisted models are even considered; claude-haiku is then
// rejected because its key is missing — leaving gemini (selected) and gpt-4o.
printPlan(plan);
