import { describe, expect, test } from "bun:test";
import {
  createStaticCapabilityCatalog,
  ModelRouter,
  type ModelCapability,
} from "@swoosh/router";
import { createAiSdkProviderAdapter } from "@swoosh/ai-sdk";

const cap = (modelId: string): ModelCapability => ({
  providerId: "openai", providerName: "OpenAI", modelId, modelName: modelId,
  inputModalities: ["text"], outputModalities: ["text"], features: ["structured_output"],
  limits: {}, pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1 }, latencyClass: "fast",
});

const router = (adapter: ReturnType<typeof createAiSdkProviderAdapter>) =>
  new ModelRouter({ catalog: createStaticCapabilityCatalog([cap("gpt-4o")]), providers: [adapter] });

describe("createAiSdkProviderAdapter", () => {
  test("resolves models via a function and unwraps the AI SDK { object }", async () => {
    const seen: string[] = [];
    const adapter = createAiSdkProviderAdapter({
      providerId: "openai",
      models: (id) => { seen.push(id); return { id }; },
      generateObject: async ({ model }) => ({ object: { via: (model as { id: string }).id } }),
    });
    const out = await router(adapter).generateObject<string, { via: string }>({
      task: "t", input: "x", prompt: "x", inputModalities: ["text"],
    });
    expect(seen).toEqual(["gpt-4o"]);
    expect(out).toEqual({ via: "gpt-4o" });
  });

  test("supports a static models map", async () => {
    const adapter = createAiSdkProviderAdapter({
      providerId: "openai",
      models: { "gpt-4o": { tag: "static" } },
      generateObject: async ({ model }) => ({ object: model }),
    });
    const out = await router(adapter).generateObject({ task: "t", input: "x", prompt: "x", inputModalities: ["text"] });
    expect(out).toEqual({ tag: "static" });
  });

  test("wires generateText for runText", async () => {
    const adapter = createAiSdkProviderAdapter({
      providerId: "openai",
      models: (id) => ({ id }),
      generateObject: async () => ({ object: {} }),
      generateText: async ({ model }) => `text from ${(model as { id: string }).id}`,
    });
    const result = await router(adapter).runText({ task: "t", input: "x", prompt: "x", inputModalities: ["text"] });
    expect(result.output).toBe("text from gpt-4o");
  });
});
