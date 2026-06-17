import {
  createCallbackProviderAdapter,
  type ImagePart,
  type ProviderAdapter,
} from "@swoosh-dev/router";

export interface AiSdkProviderOptions {
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
    readonly images?: readonly ImagePart[];
    readonly metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  readonly generateText?: (request: {
    readonly model: unknown;
    readonly prompt?: string;
    readonly input?: unknown;
    readonly images?: readonly ImagePart[];
    readonly metadata?: Record<string, unknown>;
  }) => Promise<string>;
  /**
   * Generate an image. The router routes a request whose `outputModalities`
   * includes `"image"` here; return the bytes as base64 plus a media type
   * (e.g. via the AI SDK's `experimental_generateImage`).
   */
  readonly generateImage?: (request: {
    readonly model: unknown;
    readonly prompt?: string;
    readonly input?: unknown;
    readonly metadata?: Record<string, unknown>;
  }) => Promise<{ base64: string; mediaType: string }>;
}

const resolveModel = (models: AiSdkProviderOptions["models"], modelId: string): unknown =>
  typeof models === "function" ? models(modelId) : models[modelId];

/**
 * Wraps Vercel AI SDK calls as a swoosh provider adapter. The router selects a
 * `ModelCapability`; this resolves the matching AI SDK model from `models` by
 * `modelId` and forwards the request. Provide `generateText` too for `runText`.
 */
export const createAiSdkProviderAdapter = (options: AiSdkProviderOptions): ProviderAdapter =>
  createCallbackProviderAdapter({
    providerId: options.providerId,
    name: options.name,
    isAvailable: options.isAvailable,
    generateObject: async (request) => {
      const result = await options.generateObject({
        model: resolveModel(options.models, request.model.modelId),
        schema: request.schema,
        prompt: request.prompt,
        input: request.input,
        images: request.images,
        metadata: request.metadata,
      });
      return result && typeof result === "object" && "object" in result
        ? (result as { object: unknown }).object
        : result;
    },
    generateText: options.generateText
      ? (request) =>
          options.generateText!({
            model: resolveModel(options.models, request.model.modelId),
            prompt: request.prompt,
            input: request.input,
            images: request.images,
            metadata: request.metadata,
          })
      : undefined,
    generateImage: options.generateImage
      ? (request) =>
          options.generateImage!({
            model: resolveModel(options.models, request.model.modelId),
            prompt: request.prompt,
            input: request.input,
            metadata: request.metadata,
          })
      : undefined,
  });
