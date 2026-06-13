# @semafore/sdk

The batteries-included drop-in for [swoosh](../model-router). One install, one call — the enriched default catalog plus AI-SDK provider adapters auto-wired from whatever API keys are in your environment. Also re-exports the whole toolkit, so it's a single import surface.

```sh
npm install @semafore/sdk ai @ai-sdk/openai   # add more @ai-sdk/* providers as you like
```

```ts
import { createRouter } from "@semafore/sdk";

const router = await createRouter();        // catalog + providers, wired from your keys

const out = await router.generateObject({
  task: "support.triage",
  input: ticket,
  prompt: `Classify: ${ticket}`,
  inputModalities: ["text"],
  requiresFeatures: ["structured_output"],
  preference: "cheapest",
});
```

`OPENAI_API_KEY` present + `@ai-sdk/openai` installed → OpenAI is live. Add `ANTHROPIC_API_KEY` + `@ai-sdk/anthropic` and Anthropic joins automatically. Providers without a key, or without their package installed, are simply skipped.

## `createRouter(options?)`

| Option | Default | Notes |
| --- | --- | --- |
| `catalog` | `defaultCatalog()` from `@semafore/capabilities` | Any `CapabilityCatalog`. |
| `providers` | auto-wired from API keys | Pass your own adapters to opt out of auto-wiring. |
| `defaultPreference` | `"balanced"` | Used when a request omits `preference`. |
| `env` | `process.env` | Source for key detection. |
| `load` | dynamic `import` | Module loader (injectable for tests). |

Returns a `Promise<ModelRouter>` — it's async because provider packages are loaded on demand.

## Bring-your-own-keys apps

Because providers are chosen from whatever keys are present, you can build a BYO-keys app without branching on provider in your code — pass the user's keys as the `env` and the router wires whatever they brought:

```ts
// Per request / per tenant — the user supplies whichever keys they have.
const router = await createRouter({
  env: {
    OPENAI_API_KEY: user.keys.openai,
    OPENROUTER_API_KEY: user.keys.openrouter, // one key, hundreds of models
    ANTHROPIC_API_KEY: user.keys.anthropic,
  },
});
// Same call regardless of who they are; the router routes across what they brought.
const out = await router.generateObject({ task, input, requiresFeatures: ["structured_output"] });
```

Users never configure models — the catalog supplies them, so new models become routable as the dataset updates, with no code change. A user with only an OpenRouter key gets routed across the OpenRouter catalog; a user with raw provider keys gets routed across those. "Bring me your keys, I'll handle the rest."

## Auto-wiring details

`autoProviders()` is also exported if you want the adapters without the router. It maps each provider id to its `@ai-sdk/*` package via `providerRegistry`, checks `hasApiKey`, dynamically imports the package, and builds an adapter that resolves models through the provider factory. Requires `ai`; returns `[]` if `ai` isn't installed.

## When to reach past the drop-in

This package trades a heavier dependency footprint for zero-config. If you want a lean install or full control, compose the granular packages directly — [`@semafore/router`](../model-router) (zero-dep core), [`@semafore/ai-sdk`](../ai-sdk), [`@semafore/capabilities`](../capabilities), [`@semafore/judge`](../judge). The drop-in is built entirely from them.

```ts
// Everything is also re-exported here:
import { byBenchmark, llmJudgePolicy, filterCapabilityCatalog, defaultCatalog } from "@semafore/sdk";
```
