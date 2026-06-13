import { describe, expect, test } from "bun:test";
import { ModelRouter, createCallbackProviderAdapter } from "@semafore/router";
import { capabilities, defaultCatalog, defaultOverrides, meta } from "@semafore/capabilities";

describe("@semafore/capabilities", () => {
  test("ships a non-empty dataset with matching meta", () => {
    expect(capabilities.length).toBeGreaterThan(0);
    expect(meta.count).toBe(capabilities.length);
    expect(meta.source).toContain("models.dev");
  });

  test("defaultCatalog lists the bundled capabilities", async () => {
    const list = await defaultCatalog().listCapabilities();
    expect(list.length).toBe(capabilities.length);
  });

  test("enrichment is applied — gpt-4o has web_search, latency, quality, benchmarks", () => {
    const gpt4o = capabilities.find((m) => m.providerId === "openai" && m.modelId === "gpt-4o");
    expect(gpt4o?.features).toContain("web_search");
    expect(gpt4o?.latencyClass).toBeDefined();
    expect(gpt4o?.qualityScore).toBeDefined();
    expect(gpt4o?.benchmarks?.swe_bench).toBeGreaterThan(0);
  });

  test("every override matched a base model (no stale overrides)", () => {
    for (const o of defaultOverrides) {
      const match = capabilities.find((m) => m.providerId === o.providerId && m.modelId === o.modelId);
      expect(match, `override ${o.providerId}/${o.modelId} has no base model`).toBeDefined();
    }
  });

  test("routes through the default catalog requiring web_search", async () => {
    const router = new ModelRouter({
      catalog: defaultCatalog(),
      providers: ["openai", "anthropic", "google", "perplexity"].map((providerId) =>
        createCallbackProviderAdapter({ providerId }),
      ),
    });
    const plan = await router.plan({
      task: "research",
      input: "x",
      inputModalities: ["text"],
      requiresFeatures: ["web_search"],
    });
    expect(plan.selected.capability.features).toContain("web_search");
  });
});
