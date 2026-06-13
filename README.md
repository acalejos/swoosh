<div align="center">

# swoosh

**Just give me a model.**

Intent-driven, policy-driven model routing for TypeScript. Declare *what* a task
needs and *how* to choose; swoosh plans the best model, explains every rejection,
and falls back automatically.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

---

Hard-coding `model: "gpt-..."` couples your app to one provider's naming, pricing,
and outages. swoosh inverts that:

- **Intent, not model IDs.** Requests declare requirements (`inputModalities`,
  `requiresFeatures`), and the router finds the models that satisfy them.
- **Policy, not hope.** Constraints (`maxCostUsd`, `maxLatencyClass`, provider
  allow/deny, benchmark scores, an LLM judge) are enforced at planning time —
  each rejection carries a reason.
- **Plans are inspectable.** `plan()` returns the selected model, ranked
  fallbacks, every rejected candidate with its reason, and a cost estimate —
  before anything executes.
- **Execution falls back automatically**, recording every attempt.

## Quick start

```sh
npm install swoosh-sdk ai @ai-sdk/openai
```

```ts
import { createRouter } from "swoosh-sdk";

const router = await createRouter(); // enriched catalog + providers from your keys

const out = await router.generateObject({
  task: "support.triage",
  input: ticket,
  prompt: `Classify: ${ticket}`,
  inputModalities: ["text"],
  requiresFeatures: ["structured_output"],
  preference: "cheapest",
});
```

`createRouter()` wires AI-SDK providers for whatever API keys are present and
defaults to the bundled, enriched model catalog. Want control over each piece?
Compose the packages directly.

## Packages

| Package | Install | What |
| --- | --- | --- |
| [`swoosh-sdk`](packages/sdk) | `npm i swoosh-sdk ai @ai-sdk/openai` | Batteries-included drop-in — `createRouter()`, auto-wired providers, re-exports everything |
| [`swoosh-router`](packages/model-router) | `npm i swoosh-router` | Zero-dependency core: intent + policy routing, inspectable plans, fallback |
| [`swoosh-capabilities`](packages/capabilities) | `npm i swoosh-capabilities` | Curated, enriched model dataset (models.dev ∪ web_search / latency / quality / benchmarks) |
| [`swoosh-judge`](packages/judge) | `npm i swoosh-judge` | Dynamic policies — classify the prompt with an LLM judge, route by verdict |
| [`swoosh-ai-sdk`](packages/ai-sdk) | `npm i swoosh-ai-sdk ai` | Vercel AI SDK provider adapter |

The core has **zero runtime dependencies** — plain Promises, no framework to adopt.

## Examples

Eleven runnable scripts in [`packages/model-router/examples`](packages/model-router/examples)
— all run offline with simulated providers, no API keys:

```sh
bun packages/model-router/examples/01-quickstart.ts
```

Quickstart · cost guardrails · multimodal routing · custom policy · outage
fallback · bring-your-own-catalog · model access · web search · load balancing ·
benchmark routing · LLM judge.

## Develop

```sh
bun install
bun run check:tsc   # typecheck
bun test            # run the suite
```

## License

[Apache-2.0](LICENSE) © Andres Alejos
