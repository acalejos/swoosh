import type {
  ProviderAdapter,
  ProviderGenerateObjectRequest,
  ProviderGenerateTextRequest,
} from "./types";

export interface CallbackProviderOptions {
  readonly providerId: string;
  readonly name?: string;
  readonly isAvailable?: () => boolean;
  readonly generateObject?: (request: ProviderGenerateObjectRequest) => unknown;
  readonly generateText?: (request: ProviderGenerateTextRequest) => Promise<string> | string;
}

export const createCallbackProviderAdapter = (
  options: CallbackProviderOptions,
): ProviderAdapter => ({
  providerId: options.providerId,
  name: options.name,
  isAvailable: options.isAvailable,
  generateObject: options.generateObject
    ? async (request) => (await options.generateObject!(request)) as never
    : undefined,
  generateText: options.generateText
    ? async (request) => options.generateText!(request)
    : undefined,
});
