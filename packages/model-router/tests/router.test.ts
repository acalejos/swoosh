import { describe, expect, test } from "bun:test";
import {
  apiKeyEnvVarsFor,
  byBenchmark,
  createCallbackProviderAdapter,
  createCapabilityCatalog,
  createStaticCapabilityCatalog,
  filterCapabilityCatalog,
  hasApiKey,
  loadBalance,
  mergeCapabilities,
  ModelRouter,
  ModelRouterError,
  type ModelCapability,
  normalizeModelsDevCatalog,
  roundRobin,
  type RoutingPolicy,
} from "@swoosh/router";

const capability = (overrides: Partial<ModelCapability>): ModelCapability => ({
  providerId: "alpha",
  providerName: "Alpha",
  modelId: "alpha-1",
  modelName: "Alpha One",
  inputModalities: ["text"],
  outputModalities: ["text"],
  features: ["structured_output", "tools"],
  limits: { contextTokens: 200_000, outputTokens: 16_000 },
  pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
  latencyClass: "standard",
  ...overrides,
});

const catalog = createStaticCapabilityCatalog([
  capability({}),
  capability({
    providerId: "beta",
    providerName: "Beta",
    modelId: "beta-1",
    modelName: "Beta One",
    pricing: { inputPerMillionTokens: 10, outputPerMillionTokens: 20 },
    latencyClass: "slow",
    qualityScore: 9,
  }),
]);

const availableAdapter = (providerId: string) =>
  createCallbackProviderAdapter({ providerId, isAvailable: () => true });

describe("ModelRouter.plan", () => {
  test("applies denied provider constraints with reasons", async () => {
    const router = new ModelRouter({
      catalog,
      providers: [availableAdapter("alpha"), availableAdapter("beta")],
    });

    const plan = await router.plan({
      task: "summarize",
      input: "text",
      inputModalities: ["text"],
      constraints: { deniedProviderIds: ["beta"] },
    });

    expect(plan.selected.capability.providerId).toBe("alpha");
    expect(plan.rejected).toContainEqual({
      providerId: "beta",
      modelId: "beta-1",
      reason: "Provider is denied by policy.",
    });
  });

  test("enforces maxCostUsd against token estimates", async () => {
    const router = new ModelRouter({
      catalog,
      providers: [availableAdapter("alpha"), availableAdapter("beta")],
    });

    const plan = await router.plan({
      task: "summarize",
      input: "text",
      inputModalities: ["text"],
      estimatedInputTokens: 100_000,
      estimatedOutputTokens: 10_000,
      constraints: { maxCostUsd: 0.5 },
    });

    expect(plan.selected.capability.providerId).toBe("alpha");
    expect(plan.rejected.map((entry) => entry.reason)).toContain("Estimated cost exceeds policy.");
  });

  test("enforces maxLatencyClass", async () => {
    const router = new ModelRouter({
      catalog,
      providers: [availableAdapter("alpha"), availableAdapter("beta")],
    });

    const plan = await router.plan({
      task: "summarize",
      input: "text",
      inputModalities: ["text"],
      preference: "best_quality",
      constraints: { maxLatencyClass: "standard" },
    });

    expect(plan.selected.capability.providerId).toBe("alpha");
    expect(plan.rejected.map((entry) => entry.reason)).toContain(
      "Model is slower than the latency policy allows.",
    );
  });

  test("rejects models missing a required feature", async () => {
    const router = new ModelRouter({
      catalog: createStaticCapabilityCatalog([
        capability({ features: ["structured_output"] }),
        capability({ providerId: "beta", modelId: "beta-1", features: ["structured_output", "reasoning"] }),
      ]),
      providers: [availableAdapter("alpha"), availableAdapter("beta")],
    });

    const plan = await router.plan({
      task: "summarize",
      input: "text",
      inputModalities: ["text"],
      requiresFeatures: ["reasoning"],
    });

    expect(plan.selected.capability.providerId).toBe("beta");
    expect(plan.rejected).toContainEqual({
      providerId: "alpha",
      modelId: "alpha-1",
      reason: "Missing required feature: reasoning.",
    });
  });

  test("filters on web_search like any other feature", async () => {
    const router = new ModelRouter({
      catalog: createStaticCapabilityCatalog([
        capability({ providerId: "alpha", modelId: "alpha-1", features: ["structured_output"] }),
        capability({
          providerId: "beta",
          modelId: "beta-1",
          features: ["structured_output", "web_search"],
        }),
      ]),
      providers: [availableAdapter("alpha"), availableAdapter("beta")],
    });

    const plan = await router.plan({
      task: "research",
      input: "x",
      inputModalities: ["text"],
      requiresFeatures: ["web_search"],
    });

    expect(plan.selected.capability.providerId).toBe("beta");
    expect(plan.rejected).toContainEqual({
      providerId: "alpha",
      modelId: "alpha-1",
      reason: "Missing required feature: web_search.",
    });
  });

  test("supports custom routing policies", async () => {
    const preferBeta: RoutingPolicy = ({ candidates }) =>
      [...candidates].sort((left, right) =>
        left.capability.providerId === "beta" ? -1 : right.capability.providerId === "beta" ? 1 : 0,
      );
    const router = new ModelRouter({
      catalog,
      providers: [availableAdapter("alpha"), availableAdapter("beta")],
    });

    const plan = await router.plan({
      task: "summarize",
      input: "text",
      inputModalities: ["text"],
      preference: preferBeta,
    });

    expect(plan.preference).toBe("custom");
    expect(plan.selected.capability.providerId).toBe("beta");
  });

  test("fails when constraints reject every model", async () => {
    const router = new ModelRouter({
      catalog,
      providers: [availableAdapter("alpha"), availableAdapter("beta")],
    });

    await expect(
      router.plan({ task: "transcribe", input: "audio", inputModalities: ["audio"] }),
    ).rejects.toBeInstanceOf(ModelRouterError);
  });

  test("omits fallbacks when allowFallbacks is false", async () => {
    const router = new ModelRouter({
      catalog,
      providers: [availableAdapter("alpha"), availableAdapter("beta")],
    });

    const plan = await router.plan({
      task: "summarize",
      input: "text",
      inputModalities: ["text"],
      constraints: { allowFallbacks: false },
    });

    expect(plan.fallbacks).toEqual([]);
  });
});

describe("ModelRouter.runText", () => {
  test("routes text generation and falls back on failure", async () => {
    const attempts: string[] = [];
    const router = new ModelRouter({
      catalog,
      providers: [
        createCallbackProviderAdapter({
          providerId: "alpha",
          isAvailable: () => true,
          generateText: () => {
            attempts.push("alpha");
            throw new Error("overloaded");
          },
        }),
        createCallbackProviderAdapter({
          providerId: "beta",
          isAvailable: () => true,
          generateText: () => {
            attempts.push("beta");
            return "fallback text";
          },
        }),
      ],
    });

    const result = await router.runText({
      task: "summarize",
      input: "text",
      prompt: "Summarize this.",
      inputModalities: ["text"],
      preference: "cheapest",
    });

    expect(attempts).toEqual(["alpha", "beta"]);
    expect(result.output).toBe("fallback text");
    expect(result.attempts.map((attempt) => attempt.ok)).toEqual([false, true]);
  });

  test("rejects with ModelRouterError when every route fails", async () => {
    const router = new ModelRouter({
      catalog,
      providers: [
        createCallbackProviderAdapter({
          providerId: "alpha",
          isAvailable: () => true,
          generateText: () => {
            throw new Error("down");
          },
        }),
        createCallbackProviderAdapter({
          providerId: "beta",
          isAvailable: () => true,
          generateText: () => {
            throw new Error("down");
          },
        }),
      ],
    });

    await expect(
      router.runText({
        task: "summarize",
        input: "text",
        prompt: "Summarize this.",
        inputModalities: ["text"],
      }),
    ).rejects.toBeInstanceOf(ModelRouterError);
  });
});

describe("createCapabilityCatalog (bring your own source)", () => {
  test("loads capabilities from an async loader and routes against them", async () => {
    let loads = 0;
    const router = new ModelRouter({
      catalog: createCapabilityCatalog(async () => {
        loads += 1;
        return [capability({ providerId: "db", modelId: "db-1" })];
      }),
      providers: [availableAdapter("db")],
    });

    const plan = await router.plan({ task: "summarize", input: "x", inputModalities: ["text"] });

    expect(loads).toBe(1);
    expect(plan.selected.capability.providerId).toBe("db");
  });

  test("surfaces loader failures as ModelRouterError", async () => {
    const router = new ModelRouter({
      catalog: createCapabilityCatalog(async () => {
        throw new Error("db unreachable");
      }),
      providers: [availableAdapter("db")],
    });

    await expect(
      router.plan({ task: "summarize", input: "x", inputModalities: ["text"] }),
    ).rejects.toBeInstanceOf(ModelRouterError);
  });

  test("reuses normalizeModelsDevCatalog for models.dev-shaped rows", async () => {
    const rows = {
      openai: {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4o": {
            id: "gpt-4o",
            structured_output: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 128_000, output: 16_000 },
            cost: { input: 2.5, output: 10 },
          },
        },
      },
    };
    const router = new ModelRouter({
      catalog: createCapabilityCatalog(() => normalizeModelsDevCatalog(rows)),
      providers: [availableAdapter("openai")],
    });

    const plan = await router.plan({ task: "summarize", input: "x", inputModalities: ["text"] });

    expect(plan.selected.capability.modelId).toBe("gpt-4o");
  });
});

describe("byBenchmark & async policies", () => {
  const benched = createStaticCapabilityCatalog([
    capability({ providerId: "a", modelId: "a", benchmarks: { swe_bench: 0.5, gpqa: 0.9 } }),
    capability({ providerId: "b", modelId: "b", benchmarks: { swe_bench: 0.8, gpqa: 0.6 } }),
    capability({ providerId: "c", modelId: "c" }), // no benchmarks
  ]);
  const router = new ModelRouter({
    catalog: benched,
    providers: ["a", "b", "c"].map(availableAdapter),
  });

  test("ranks by a named benchmark, unscored last", async () => {
    const plan = await router.plan({
      task: "t", input: "x", inputModalities: ["text"], preference: byBenchmark("swe_bench"),
    });
    expect(plan.selected.capability.providerId).toBe("b");
    expect(plan.fallbacks.at(-1)?.capability.providerId).toBe("c");
  });

  test("ranks by a composite scoring function", async () => {
    const plan = await router.plan({
      task: "t", input: "x", inputModalities: ["text"],
      preference: byBenchmark((m) => 0.1 * (m.benchmarks?.swe_bench ?? 0) + (m.benchmarks?.gpqa ?? 0)),
    });
    expect(plan.selected.capability.providerId).toBe("a"); // gpqa-weighted
  });

  test("minimum drops unscored and below-threshold models", async () => {
    const plan = await router.plan({
      task: "t", input: "x", inputModalities: ["text"], preference: byBenchmark("swe_bench", { minimum: 0.7 }),
    });
    expect(plan.selected.capability.providerId).toBe("b");
    expect(plan.fallbacks).toEqual([]); // a (0.5) and c (none) dropped
  });

  test("awaits an async custom policy", async () => {
    const asyncPolicy: RoutingPolicy = async ({ candidates }) => {
      await Promise.resolve();
      return [...candidates].reverse();
    };
    const plan = await router.plan({
      task: "t", input: "x", inputModalities: ["text"], preference: asyncPolicy,
    });
    expect(plan.preference).toBe("custom");
    expect(plan.selected.capability.providerId).toBe("c");
  });
});

describe("mergeCapabilities (enrichment)", () => {
  const base = [
    capability({ providerId: "openai", modelId: "gpt", features: ["tools"], qualityScore: undefined }),
    capability({ providerId: "anthropic", modelId: "claude", features: ["tools"] }),
  ];

  test("unions features and replaces scalar fields on matched models", () => {
    const merged = mergeCapabilities(base, [
      { providerId: "openai", modelId: "gpt", features: ["web_search"], latencyClass: "fast", qualityScore: 9 },
    ]);
    const gpt = merged.find((m) => m.modelId === "gpt")!;
    expect(gpt.features).toEqual(["tools", "web_search"]);
    expect(gpt.latencyClass).toBe("fast");
    expect(gpt.qualityScore).toBe(9);
  });

  test("shallow-merges limits and pricing", () => {
    const merged = mergeCapabilities(base, [
      { providerId: "openai", modelId: "gpt", pricing: { inputPerMillionTokens: 0.5 } },
    ]);
    const gpt = merged.find((m) => m.modelId === "gpt")!;
    expect(gpt.pricing.inputPerMillionTokens).toBe(0.5);
    expect(gpt.pricing.outputPerMillionTokens).toBe(2); // preserved from base
  });

  test("leaves unmatched base models untouched and ignores unmatched overrides", () => {
    const merged = mergeCapabilities(base, [
      { providerId: "ghost", modelId: "nope", features: ["web_search"] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.modelId === "claude")!.features).toEqual(["tools"]);
  });
});

describe("hasApiKey (provider key detection)", () => {
  test("detects a key via the conventional env var", () => {
    expect(hasApiKey("openai", { env: { OPENAI_API_KEY: "sk-x" } })).toBe(true);
    expect(hasApiKey("openai", { env: {} })).toBe(false);
    expect(hasApiKey("openai", { env: { OPENAI_API_KEY: "" } })).toBe(false);
  });

  test("accepts any of a provider's conventional names", () => {
    expect(hasApiKey("google", { env: { GEMINI_API_KEY: "x" } })).toBe(true);
    expect(hasApiKey("google", { env: { GOOGLE_GENERATIVE_AI_API_KEY: "x" } })).toBe(true);
  });

  test("derives <PROVIDER>_API_KEY for unmapped providers", () => {
    expect(apiKeyEnvVarsFor("gemini")).toEqual(["GEMINI_API_KEY"]);
    expect(hasApiKey("acme-labs", { env: { ACME_LABS_API_KEY: "x" } })).toBe(true);
  });

  test("custom vars override the convention", () => {
    expect(hasApiKey("openai", { env: { MY_KEY: "x" }, vars: ["MY_KEY"] })).toBe(true);
  });

  test("gates a provider adapter's availability", async () => {
    const env = { OPENAI_API_KEY: "sk-x" };
    const router = new ModelRouter({
      catalog: createStaticCapabilityCatalog([
        capability({ providerId: "openai", modelId: "gpt" }),
        capability({ providerId: "anthropic", modelId: "claude" }),
      ]),
      providers: [
        createCallbackProviderAdapter({ providerId: "openai", isAvailable: () => hasApiKey("openai", { env }) }),
        createCallbackProviderAdapter({ providerId: "anthropic", isAvailable: () => hasApiKey("anthropic", { env }) }),
      ],
    });

    const plan = await router.plan({ task: "t", input: "x", inputModalities: ["text"] });
    expect(plan.selected.capability.providerId).toBe("openai");
    expect(plan.rejected).toContainEqual({
      providerId: "anthropic",
      modelId: "claude",
      reason: "No available provider adapter.",
    });
  });
});

describe("loadBalance & roundRobin (rotation)", () => {
  // alpha is cheapest, beta next, gamma most expensive.
  const cheap = createStaticCapabilityCatalog([
    capability({ providerId: "alpha", modelId: "a", pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1 } }),
    capability({ providerId: "beta", modelId: "b", pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 2 } }),
    capability({ providerId: "gamma", modelId: "g", pricing: { inputPerMillionTokens: 9, outputPerMillionTokens: 9 } }),
  ]);

  test("round-robins selection across the two cheapest, keeping the rest as fallbacks", async () => {
    const router = new ModelRouter({
      catalog: cheap,
      providers: ["alpha", "beta", "gamma"].map(availableAdapter),
    });
    const balanced = loadBalance("cheapest", { across: 2 });

    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const plan = await router.plan({
        task: "img",
        input: "x",
        inputModalities: ["text"],
        preference: balanced,
      });
      picks.push(plan.selected.capability.providerId);
      // gamma is never in the rotated pair — it stays a fallback.
      expect(plan.fallbacks.at(-1)?.capability.providerId).toBe("gamma");
    }
    expect(picks).toEqual(["alpha", "beta", "alpha", "beta"]);
  });

  test("roundRobin cycles items and wraps around", () => {
    const next = roundRobin(["k1", "k2", "k3"]);
    expect([next(), next(), next(), next()]).toEqual(["k1", "k2", "k3", "k1"]);
  });

  test("roundRobin throws on an empty list", () => {
    expect(() => roundRobin([])).toThrow();
  });
});

describe("filterCapabilityCatalog (scope to accessible models)", () => {
  const universe = createStaticCapabilityCatalog([
    capability({ providerId: "alpha", modelId: "alpha-1" }),
    capability({ providerId: "alpha", modelId: "alpha-2" }),
    capability({ providerId: "beta", modelId: "beta-1" }),
  ]);

  test("scopes a broad catalog with an allowlist of provider/model keys", async () => {
    const scoped = filterCapabilityCatalog(universe, ["alpha/alpha-2"]);
    const list = await scoped.listCapabilities();
    expect(list.map((c) => `${c.providerId}/${c.modelId}`)).toEqual(["alpha/alpha-2"]);
  });

  test("scopes with a predicate evaluated on every call", async () => {
    let enabled = new Set(["alpha-1"]);
    const scoped = filterCapabilityCatalog(universe, (c) => enabled.has(c.modelId));
    expect((await scoped.listCapabilities()).map((c) => c.modelId)).toEqual(["alpha-1"]);
    enabled = new Set(["alpha-1", "beta-1"]);
    expect((await scoped.listCapabilities()).map((c) => c.modelId)).toEqual(["alpha-1", "beta-1"]);
  });

  test("the router only routes to models that survive the filter", async () => {
    const router = new ModelRouter({
      catalog: filterCapabilityCatalog(universe, ["beta/beta-1"]),
      providers: [availableAdapter("alpha"), availableAdapter("beta")],
    });
    const plan = await router.plan({ task: "summarize", input: "x", inputModalities: ["text"] });
    expect(plan.selected.capability.providerId).toBe("beta");
    expect(plan.fallbacks).toEqual([]);
  });
});
