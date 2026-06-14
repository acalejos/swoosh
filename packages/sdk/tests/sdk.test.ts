import { describe, expect, test } from "bun:test";
import {
  autoProviders,
  byBenchmark,
  createCallbackProviderAdapter,
  createRouter,
  defaultCatalog,
  llmJudgePolicy,
} from "@swoosh-dev/sdk";

// A fake module loader standing in for `ai` + the @ai-sdk/* provider packages.
const fakeLoad = (id: string): Promise<unknown> => {
  if (id === "ai") {
    return Promise.resolve({
      generateObject: async () => ({ object: { ok: true } }),
      generateText: async () => ({ text: "hello" }),
    });
  }
  if (id === "@ai-sdk/openai") return Promise.resolve({ openai: (modelId: string) => ({ modelId }) });
  if (id === "@ai-sdk/anthropic") return Promise.resolve({ anthropic: (modelId: string) => ({ modelId }) });
  if (id === "@openrouter/ai-sdk-provider") return Promise.resolve({ openrouter: (modelId: string) => ({ modelId }) });
  return Promise.reject(new Error(`not installed: ${id}`));
};

describe("@swoosh-dev/sdk re-exports", () => {
  test("surfaces the whole toolkit from one import", () => {
    expect(typeof createRouter).toBe("function");
    expect(typeof byBenchmark).toBe("function");
    expect(typeof llmJudgePolicy).toBe("function");
    expect(typeof defaultCatalog).toBe("function");
    expect(typeof createCallbackProviderAdapter).toBe("function");
  });
});

describe("autoProviders", () => {
  test("wires only providers with a key AND an installed package", async () => {
    const adapters = await autoProviders({
      env: { OPENAI_API_KEY: "x", GEMINI_API_KEY: "x" }, // openai + google keyed
      load: fakeLoad, // but only openai/anthropic packages "installed"
    });
    const ids = adapters.map((a) => a.providerId);
    expect(ids).toEqual(["openai"]); // google keyed but package not installed; anthropic installed but no key
  });

  test("BYO keys: a user's keys alone decide which providers are wired", async () => {
    // Simulate an end user who only brought an OpenRouter key.
    const adapters = await autoProviders({
      env: { OPENROUTER_API_KEY: "user-supplied" },
      load: fakeLoad,
    });
    expect(adapters.map((a) => a.providerId)).toEqual(["openrouter"]);
  });

  test("returns [] when ai is unavailable", async () => {
    const adapters = await autoProviders({
      env: { OPENAI_API_KEY: "x" },
      load: (id) => (id === "ai" ? Promise.reject(new Error("no ai")) : fakeLoad(id)),
    });
    expect(adapters).toEqual([]);
  });
});

describe("createRouter", () => {
  test("auto-wires providers and routes against the default catalog", async () => {
    const router = await createRouter({ env: { OPENAI_API_KEY: "x" }, load: fakeLoad });
    const result = await router.run<string, { ok: boolean }>({
      task: "drop-in",
      input: "hi",
      prompt: "hi",
      inputModalities: ["text"],
      requiresFeatures: ["structured_output"],
      constraints: { allowedProviderIds: ["openai"] },
    });
    expect(result.output).toEqual({ ok: true });
    expect(result.plan.selected.capability.providerId).toBe("openai");
  });

  test("accepts explicit providers and a custom catalog", async () => {
    const router = await createRouter({
      providers: [createCallbackProviderAdapter({ providerId: "openai", generateObject: () => ({ ok: 1 }) })],
    });
    const plan = await router.plan({ task: "t", input: "x", inputModalities: ["text"], constraints: { allowedProviderIds: ["openai"] } });
    expect(plan.selected.capability.providerId).toBe("openai");
  });
});
