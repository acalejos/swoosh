# @swoosh/judge

Dynamic routing policies for [`@swoosh/router`](../model-router). Classify each request's prompt with an LLM judge (structured output), then route by the verdict — cheap models for small talk, top models for hard problems, search-capable models for current events.

```sh
npm install @swoosh/judge
```

```ts
import { ModelRouter } from "@swoosh/router";
import { byBenchmark } from "@swoosh/router";
import { llmJudgePolicy } from "@swoosh/judge";

type Kind = "chat" | "coding" | "research";

const smart = llmJudgePolicy<Kind>({
  // Your structured-output classifier — route the judge through a cheap model.
  classify: ({ prompt }) => judge.generateObject({ schema: KindSchema, prompt }),
  route: {
    chat: "cheapest",
    coding: byBenchmark("swe_bench"),
    research: ({ candidates }) => candidates.filter((c) => c.capability.features.includes("web_search")),
  },
  fallback: "balanced",     // used if classify throws or returns an unmapped verdict
});

await router.run({ ...request, preference: smart });
```

## How it works

`llmJudgePolicy` returns an ordinary `RoutingPolicy` — async, since it awaits your classifier. The verdict picks a base preference/policy from `route`; the result is still a ranked candidate list, so fallback, constraints, and `plan()` inspection all work unchanged. `plan.preference` reports `"custom"`.

- **You supply the judge.** `classify` is your call (sync or async). The package adds no LLM dependency — route the judge itself through a cheap swoosh model if you like.
- **Verdicts are cached** by prompt signature (the judge costs latency + tokens). On by default; `cache: false` to disable, or `cache: { key, max }` to tune.
- **Best-effort prompt.** The classifier receives `{ prompt, request }`, where `prompt` is `request.prompt` if present, else a stringified `request.input` — so it works with `plan`, `run`, and `runText`.

## Options

| Field | Type | Notes |
| --- | --- | --- |
| `classify` | `(input) => Verdict \| Promise<Verdict>` | Your structured-output classifier. |
| `route` | `Record<Verdict, RoutingPreference \| RoutingPolicy>` | Verdict → base ranking. |
| `fallback` | `RoutingPreference \| RoutingPolicy` | On error/unmapped verdict. Defaults to `"balanced"`. |
| `cache` | `boolean \| { key?, max? }` | Cache verdicts by prompt. Defaults to on. |
