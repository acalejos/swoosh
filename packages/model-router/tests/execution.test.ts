import { test, expect } from "bun:test";
import {
  ModelRouter,
  createCallbackProviderAdapter,
  createStaticCapabilityCatalog,
  type ModelCapability,
} from "../src/index.ts";

const cap = (id: string, q: number): ModelCapability => {
  const [providerId, modelId] = id.split("/") as [string, string];
  return {
    providerId, providerName: providerId, modelId, modelName: modelId,
    inputModalities: ["text"], outputModalities: ["text"], features: [], limits: {}, pricing: {}, qualityScore: q,
  };
};

const req = (extra: object = {}) => ({
  task: "t", input: "x", prompt: "hi", inputModalities: ["text"] as const, preference: "best_quality" as const, ...extra,
});

test("retry succeeds on the same route after transient failures", async () => {
  let n = 0;
  const router = new ModelRouter({
    catalog: createStaticCapabilityCatalog([cap("p/a", 0.9)]),
    providers: [createCallbackProviderAdapter({ providerId: "p", generateText: () => { if (++n < 3) throw new Error("503"); return "ok"; } })],
  });
  const res = await router.runText(req({ retry: { attempts: 3 } }));
  expect(res.output).toBe("ok");
  expect(res.attempts.length).toBe(3); // 2 fail + 1 ok, same route
  expect(res.attempts.filter((a) => !a.ok)).toHaveLength(2);
});

test("retry exhausts, then falls through to the next route", async () => {
  const router = new ModelRouter({
    catalog: createStaticCapabilityCatalog([cap("p/a", 0.9), cap("q/b", 0.7)]),
    providers: [
      createCallbackProviderAdapter({ providerId: "p", generateText: () => { throw new Error("down"); } }),
      createCallbackProviderAdapter({ providerId: "q", generateText: () => "recovered" }),
    ],
  });
  const res = await router.runText(req({ retry: { attempts: 2 } }));
  expect(res.output).toBe("recovered");
  expect(res.attempts.map((a) => a.providerId)).toEqual(["p", "p", "q"]); // a retried twice, then b
});

test("timeout fails a slow route and falls through", async () => {
  const router = new ModelRouter({
    catalog: createStaticCapabilityCatalog([cap("p/a", 0.9), cap("q/b", 0.7)]),
    providers: [
      createCallbackProviderAdapter({ providerId: "p", generateText: () => new Promise<string>(() => {}) }), // hangs
      createCallbackProviderAdapter({ providerId: "q", generateText: () => "fast" }),
    ],
  });
  const res = await router.runText(req({ timeout: 50 }));
  expect(res.output).toBe("fast");
  expect(res.attempts[0]!.ok).toBe(false);
  expect(res.attempts[0]!.error).toContain("Timed out");
});

test("retryOn skips non-retryable errors (straight to fallback)", async () => {
  let n = 0;
  const router = new ModelRouter({
    catalog: createStaticCapabilityCatalog([cap("p/a", 0.9), cap("q/b", 0.7)]),
    providers: [
      createCallbackProviderAdapter({ providerId: "p", generateText: () => { n++; throw new Error("fatal"); } }),
      createCallbackProviderAdapter({ providerId: "q", generateText: () => "b" }),
    ],
  });
  const res = await router.runText(req({ retry: { attempts: 3, retryOn: (e: unknown) => !(e as Error).message.includes("fatal") } }));
  expect(res.output).toBe("b");
  expect(n).toBe(1); // not retried — fell straight through
});
