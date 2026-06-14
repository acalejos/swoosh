# @swoosh-dev/ai-sdk

Vercel AI SDK provider adapter for [`@swoosh-dev/router`](../model-router). Kept separate so the core router stays free of the `ai` dependency — install this only if you route through the AI SDK.

```sh
npm install @swoosh-dev/ai-sdk ai
```

```ts
import { ModelRouter, ModelsDevCapabilityCatalog } from "@swoosh-dev/router";
import { createAiSdkProviderAdapter } from "@swoosh-dev/ai-sdk";
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
