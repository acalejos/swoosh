# @swoosh-dev/testing

Test utilities for [`@swoosh-dev/router`](../model-router) — exercise your catalog, policies, and routing config **without hitting real providers**. Framework-agnostic: assertions just throw, so it works in `bun:test`, Vitest, Jest, or `node:test`.

```sh
npm i -D @swoosh-dev/testing
```

## Fixtures + mocks

```ts
import { model, mockProvider, routerForTest, failAlways } from "@swoosh-dev/testing";

const router = routerForTest({
  models: [
    model("openai/gpt-5", { features: ["tools"], pricing: { input: 5, output: 15 }, qualityScore: 0.9 }),
    model("google/gemini-2.5-flash", { inputModalities: ["text", "image"], pricing: { input: 0.1 } }),
  ],
  providers: [
    mockProvider("openai", { generateObject: () => ({ category: "billing" }) }),
    mockProvider("google", { generateText: () => "hi" }),
  ],
});
```

- **`model("provider/id", opts)`** — a fake `ModelCapability`; everything unspecified gets a sensible default.
- **`fakeCatalog(models)`** — a static catalog over those models.
- **`mockProvider(id, handlers)`** — a programmable provider adapter that **records every call** (`provider.calls`, `provider.callCount()`). Handlers are a value or a function of the request.
- **`failAlways()`** (provider is down → drives fallback), **`failOnce(value)`** (transient), **`echo`** (returns the prompt).
- **`routerForTest({ models, providers })`** — a wired `ModelRouter`; its `.plan()` result also carries `.expects()`.

## Asserting on plans

A fluent, throwing chain — no matcher registration, works in any runner:

```ts
const plan = await router.plan({
  task: "support.triage",
  input: ticket,
  inputModalities: ["text"],
  requiresFeatures: ["structured_output"],
  preference: "cheapest",
  constraints: { maxCostUsd: 0.01 },
});

plan.expects()                               // or: expects(plan)
  .selects("google/gemini-2.5-flash")        // bare "gemini-2.5-flash" also matches
  .rejects("openai/gpt-5", /over budget/)    // in plan.rejected, with a matching reason
  .ranksBefore("google/gemini-2.5-flash", "openai/gpt-5")
  .costsUnder(0.01)
  .not.selects("openai/gpt-5");
```

Matchers: `selects` · `rejects(id, reason?)` · `ranksBefore(a, b)` · `fallsBackTo(id)` · `costsUnder(usd)`, each negatable via `.not`. Ids are `"provider/model"` (exact) or a bare `"model"` (matches across providers). Failures throw a `SwooshExpectError` whose message includes a `formatPlan(plan)` dump (also exported for snapshot tests).

## Testing fallback

```ts
import { routerForTest, model, mockProvider, failAlways } from "@swoosh-dev/testing";

const router = routerForTest({
  models: [model("openai/gpt-5", { qualityScore: 0.9 }), model("anthropic/claude-haiku-4-5", { qualityScore: 0.7 })],
  providers: [
    mockProvider("openai", { generateText: failAlways("503") }), // selected, but down
    mockProvider("anthropic", { generateText: () => "recovered" }),
  ],
});

const { output, attempts } = await router.runText({
  task: "t", input: "x", prompt: "hi", inputModalities: ["text"], preference: "best_quality",
});
// output === "recovered"; attempts records the failed openai try then the anthropic success
```

## License

[Apache-2.0](LICENSE) © Andres Alejos
