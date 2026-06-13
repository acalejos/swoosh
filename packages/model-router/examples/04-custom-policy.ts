// Routing policies are plain functions. This one keeps traffic inside
// EU-hosted providers for data-residency reasons, then picks the cheapest.
// Run from the repo root: bun packages/model-router/examples/04-custom-policy.ts
import {
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  ModelRouter,
  type RoutingPolicy,
} from "swoosh-router";
import { exampleCatalog } from "./shared/catalog";
import { printPlan } from "./shared/print";

const EU_HOSTED = new Set(["mistral", "local"]);

const euResidencyThenCheapest: RoutingPolicy = ({ candidates }) =>
  candidates
    .filter((candidate) => EU_HOSTED.has(candidate.capability.providerId))
    .sort(
      (left, right) =>
        (left.estimatedCostUsd ?? Number.POSITIVE_INFINITY) -
        (right.estimatedCostUsd ?? Number.POSITIVE_INFINITY),
    );

const router = new ModelRouter({
  catalog: createStaticCapabilityCatalog(exampleCatalog),
  providers: ["google", "anthropic", "openai", "mistral", "local"].map((providerId) =>
    createCallbackProviderAdapter({ providerId }),
  ),
});

const plan = await router.plan({
  task: "contract.redline",
  input: "(an employment contract)",
  inputModalities: ["text"],
  preference: euResidencyThenCheapest,
});

// llama-3.3-70b wins on price; mistral-large is the fallback.
// US-hosted candidates never make it into the route list.
printPlan(plan);
