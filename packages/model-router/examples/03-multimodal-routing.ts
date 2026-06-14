// Extract line items from a photographed receipt. Declaring image input
// automatically filters out text-only models — no manual model lists.
// Run from the repo root: bun packages/model-router/examples/03-multimodal-routing.ts
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  ModelRouter,
} from "@swoosh-dev/router";
import { exampleCatalog } from "./shared/catalog";
import { printPlan } from "./shared/print";

interface Receipt {
  merchant: string;
  totalCents: number;
  lineItems: { label: string; cents: number }[];
}

const router = new ModelRouter({
  catalog: createStaticCapabilityCatalog(exampleCatalog),
  providers: ["google", "anthropic", "openai", "mistral", "local"].map((providerId) =>
    createCallbackProviderAdapter({
      providerId,
      generateObject: () =>
        ({
          merchant: "Blue Bottle Coffee",
          totalCents: 1250,
          lineItems: [
            { label: "Latte", cents: 650 },
            { label: "Croissant", cents: 600 },
          ],
        }) satisfies Receipt,
    }),
  ),
});

const result = await router.run<{ imageBase64: string }, Receipt>({
  task: "receipt.extract",
  input: { imageBase64: "(receipt photo)" },
  prompt: "Extract the merchant, total, and line items from this receipt.",
  inputModalities: ["text", "image"],
  requiresFeatures: ["structured_output"],
  preference: "cheapest",
});

// mistral-large and llama-3.3-70b are rejected: text-only input.
printPlan(result.plan);
console.log("output     ", result.output);
