// One method, three kinds of output — the request decides, not the method name.
// Run from the repo root: bun packages/model-router/examples/12-unified-generate.ts
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  type GeneratedImage,
  type ModelCapability,
  ModelRouter,
} from "@swoosh-dev/router";

const textModel: ModelCapability = {
  providerId: "anthropic",
  providerName: "Anthropic",
  modelId: "claude-haiku-4-5",
  modelName: "Claude Haiku 4.5",
  inputModalities: ["text"],
  outputModalities: ["text"],
  features: ["structured_output"],
  limits: { contextTokens: 200_000 },
  pricing: { inputPerMillionTokens: 1, outputPerMillionTokens: 5 },
};

const imageModel: ModelCapability = {
  providerId: "imagegen",
  providerName: "ImageGen",
  modelId: "image-1",
  modelName: "Image One",
  inputModalities: ["text"],
  outputModalities: ["image"],
  features: [],
  limits: {},
  pricing: {},
};

const router = new ModelRouter({
  catalog: createStaticCapabilityCatalog([textModel, imageModel]),
  providers: [
    createCallbackProviderAdapter({
      providerId: "anthropic",
      generateText: () => "Crisp, calm, and a little playful.",
      generateObject: () => ({ tone: "warm", energy: "high" }),
    }),
    createCallbackProviderAdapter({
      providerId: "imagegen",
      generateImage: () => ({ base64: "iVBORw0KGgo=", mediaType: "image/png" }),
    }),
  ],
  defaultPreference: "cheapest",
});

// 1) text — no schema and no image modality
const text = await router.generate<string, string>({
  task: "brand.tagline",
  input: "an artisan bakery",
  inputModalities: ["text"],
  prompt: "Write a one-line tagline.",
});
console.log("text   ", text.output, `(via ${text.attempts.at(-1)?.providerId})`);

// 2) structured — a `schema` is present
const object = await router.generate<string, { tone: string; energy: string }>({
  task: "brand.voice",
  input: "an artisan bakery",
  inputModalities: ["text"],
  schema: { type: "object" },
});
console.log("object ", object.output, `(via ${object.attempts.at(-1)?.providerId})`);

// 3) image — outputModalities includes "image"
const image = await router.generate<string, GeneratedImage>({
  task: "brand.hero",
  input: "an artisan bakery",
  inputModalities: ["text"],
  outputModalities: ["image"],
  prompt: "A warm overhead shot of fresh sourdough.",
});
console.log(
  "image  ",
  `${image.output.mediaType}, ${image.output.base64.length} b64 chars`,
  `(via ${image.attempts.at(-1)?.providerId})`,
);
