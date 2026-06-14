# swoosh-ai-sdk

> Vercel AI SDK provider adapter.

`npm install swoosh-ai-sdk` · [source](https://github.com/acalejos/swoosh/tree/main/packages/ai-sdk)

# swoosh-ai-sdk

Vercel AI SDK provider adapter for [`swoosh-router`](../model-router). Kept separate so the core router stays free of the `ai` dependency — install this only if you route through the AI SDK.

```sh
npm install swoosh-ai-sdk ai
```

```ts
import { ModelRouter, ModelsDevCapabilityCatalog } from "swoosh-router";
import { createAiSdkProviderAdapter } from "swoosh-ai-sdk";
import { google } from "@ai-sdk/google";
import { generateObject } from "ai";

const router = new ModelRouter({
  catalog: new ModelsDevCapabilityCatalog(),
  providers: [
    createAiSdkProviderAdapter({
      providerId: "google",
      models: { "gemini-2.5-flash": google("gemini-2.5-flash") },
      generateObject: (request) => generateObject(request as never),
    }),
  ],
});
```

`models` maps each `modelId` from the catalog to its AI SDK model instance; the router picks the capability and this adapter resolves and calls it. `ai` is a peer dependency.

## Type definitions

Generated from source — the authoritative public API.

```ts
import { ProviderAdapter } from 'swoosh-router';

interface AiSdkProviderOptions {
    readonly providerId: string;
    readonly name?: string;
    readonly isAvailable?: () => boolean;
    /**
     * AI SDK model instances keyed by `modelId`, or a resolver that builds one
     * from a `modelId` (e.g. `(id) => openai(id)`). The resolver form is what lets
     * a provider serve any model in the catalog without enumerating them.
     */
    readonly models: Record<string, unknown> | ((modelId: string) => unknown);
    readonly generateObject: (request: {
        readonly model: unknown;
        readonly schema?: unknown;
        readonly prompt?: string;
        readonly input?: unknown;
        readonly metadata?: Record<string, unknown>;
    }) => Promise<unknown>;
    readonly generateText?: (request: {
        readonly model: unknown;
        readonly prompt?: string;
        readonly input?: unknown;
        readonly metadata?: Record<string, unknown>;
    }) => Promise<string>;
}
/**
 * Wraps Vercel AI SDK calls as a swoosh provider adapter. The router selects a
 * `ModelCapability`; this resolves the matching AI SDK model from `models` by
 * `modelId` and forwards the request. Provide `generateText` too for `runText`.
 */
declare const createAiSdkProviderAdapter: (options: AiSdkProviderOptions) => ProviderAdapter;

export { type AiSdkProviderOptions, createAiSdkProviderAdapter };
```
