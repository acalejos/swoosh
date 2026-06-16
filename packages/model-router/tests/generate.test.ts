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
