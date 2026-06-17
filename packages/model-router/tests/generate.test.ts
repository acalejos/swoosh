import { describe, expect, test } from "bun:test";
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  type GeneratedImage,
  ModelRouter,
  type ModelCapability,
} from "@swoosh-dev/router";

const textModel: ModelCapability = {
  providerId: "alpha",
  providerName: "Alpha",
  modelId: "alpha-1",
  modelName: "Alpha One",
  inputModalities: ["text"],
  outputModalities: ["text"],
  features: ["structured_output"],
  limits: { contextTokens: 200_000, outputTokens: 16_000 },
  pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
};

const imageModel: ModelCapability = {
  providerId: "img",
  providerName: "Img",
  modelId: "img-1",
  modelName: "Img One",
  inputModalities: ["text"],
  outputModalities: ["image"],
  features: [],
  limits: {},
  pricing: {},
};

const catalog = createStaticCapabilityCatalog([textModel, imageModel]);

const textAdapter = createCallbackProviderAdapter({
  providerId: "alpha",
  isAvailable: () => true,
  generateText: () => "TEXT",
  generateObject: (request) => ({ kind: "object", task: request.task }),
});

const imageAdapter = createCallbackProviderAdapter({
  providerId: "img",
  isAvailable: () => true,
  generateImage: () => ({ base64: "AAAA", mediaType: "image/png" }),
});

const router = new ModelRouter({ catalog, providers: [textAdapter, imageAdapter] });

describe("ModelRouter.generate — output inferred from the request", () => {
  test("routes to text when there is no schema and no image modality", async () => {
    const result = await router.generate<null, string>({
      task: "summarize",
      input: null,
      inputModalities: ["text"],
      prompt: "hi",
    });
    expect(result.output).toBe("TEXT");
    expect(result.attempts.at(-1)?.ok).toBe(true);
    expect(result.attempts.at(-1)?.providerId).toBe("alpha");
  });

  test("routes to a structured object when a schema is present", async () => {
    const result = await router.generate<null, { kind: string; task: string }>({
      task: "extract",
      input: null,
      inputModalities: ["text"],
      schema: { type: "object" },
    });
    expect(result.output).toEqual({ kind: "object", task: "extract" });
  });

  test("routes to image generation when outputModalities includes image", async () => {
    const result = await router.generate<null, GeneratedImage>({
      task: "thumbnail",
      input: null,
      inputModalities: ["text"],
      outputModalities: ["image"],
      prompt: "a cat",
    });
    expect(result.output.base64).toBe("AAAA");
    expect(result.output.mediaType).toBe("image/png");
    expect(result.attempts.at(-1)?.providerId).toBe("img");
  });

  test("fails over when the routed adapter cannot satisfy the modality", async () => {
    // the only image-capable model has an adapter with no generateImage
    const noImage = createCallbackProviderAdapter({
      providerId: "img",
      isAvailable: () => true,
      generateText: () => "x",
    });
    const router2 = new ModelRouter({
      catalog: createStaticCapabilityCatalog([imageModel]),
      providers: [noImage],
    });
    await expect(
      router2.generate({
        task: "thumbnail",
        input: null,
        inputModalities: ["text"],
        outputModalities: ["image"],
        prompt: "x",
      }),
    ).rejects.toThrow(/All model routes failed/);
  });

  test("deprecated run/runText delegate to the same paths", async () => {
    const text = await router.runText<null>({
      task: "t",
      input: null,
      inputModalities: ["text"],
      prompt: "hi",
    });
    expect(text.output).toBe("TEXT");

    const object = await router.run<null, { kind: string }>({
      task: "o",
      input: null,
      inputModalities: ["text"],
      schema: { type: "object" },
    });
    expect(object.output.kind).toBe("object");
  });
});

describe("ModelRouter.generate — structured-output schema validation", () => {
  const schema = {
    type: "object",
    properties: {
      product: { type: "string" },
      colors: { type: "array", items: { type: "string" } },
    },
    required: ["product", "colors"],
    additionalProperties: false,
  };

  const good: ModelCapability = {
    providerId: "good",
    providerName: "Good",
    modelId: "good-1",
    modelName: "Good One",
    inputModalities: ["text"],
    outputModalities: ["text"],
    features: ["structured_output"],
    limits: {},
    pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 1 },
  };
  const bad: ModelCapability = { ...good, providerId: "bad", modelId: "bad-1", modelName: "Bad One" };

  // The conforming model returns the right shape; the bad one returns the
  // "GLM via OpenRouter" failure mode — renamed keys, missing required props.
  const goodAdapter = createCallbackProviderAdapter({
    providerId: "good",
    isAvailable: () => true,
    generateObject: () => ({ product: "Velvet Peak", colors: ["#2C1A15"] }),
  });
  const badAdapter = createCallbackProviderAdapter({
    providerId: "bad",
    isAvailable: () => true,
    generateObject: () => ({ product_name: "Velvet Peak", brand_colors: ["#2C1A15"] }),
  });

  // Force "bad" to be tried first so we exercise the fall-through.
  const badFirst = ({ candidates }: { candidates: readonly { capability: ModelCapability }[] }) =>
    [...candidates].sort((a, b) =>
      a.capability.modelId === "bad-1" ? -1 : b.capability.modelId === "bad-1" ? 1 : 0,
    ) as never;

  test("falls through to the next model when output fails the schema", async () => {
    const router = new ModelRouter({
      catalog: createStaticCapabilityCatalog([bad, good]),
      providers: [badAdapter, goodAdapter],
    });
    const result = await router.generate<null, { product: string; colors: string[] }>({
      task: "brand",
      input: null,
      inputModalities: ["text"],
      schema,
      preference: badFirst,
    });
    expect(result.output).toEqual({ product: "Velvet Peak", colors: ["#2C1A15"] });
    expect(result.attempts[0]?.ok).toBe(false);
    expect(result.attempts[0]?.error).toMatch(/schema validation/);
    expect(result.attempts.at(-1)?.ok).toBe(true);
    expect(result.attempts.at(-1)?.providerId).toBe("good");
  });

  test("throws when no routed model produces a conforming object", async () => {
    const router = new ModelRouter({
      catalog: createStaticCapabilityCatalog([bad]),
      providers: [badAdapter],
    });
    await expect(
      router.generate({ task: "brand", input: null, inputModalities: ["text"], schema }),
    ).rejects.toThrow(/All model routes failed/);
  });

  test("validateStructuredOutput:false restores pass-through behavior", async () => {
    const router = new ModelRouter({
      catalog: createStaticCapabilityCatalog([bad]),
      providers: [badAdapter],
      validateStructuredOutput: false,
    });
    const result = await router.generate<null, Record<string, unknown>>({
      task: "brand",
      input: null,
      inputModalities: ["text"],
      schema,
    });
    expect(result.output).toEqual({ product_name: "Velvet Peak", brand_colors: ["#2C1A15"] });
    expect(result.attempts.at(-1)?.ok).toBe(true);
  });
});
