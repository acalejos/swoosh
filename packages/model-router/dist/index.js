// src/types.ts
var ModelRouterError = class extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
    this.name = "ModelRouterError";
  }
  cause;
};
var SchemaValidationError = class extends ModelRouterError {
  constructor(modelId, issues) {
    super(
      `Structured output from "${modelId}" failed schema validation: ${issues.join("; ")}`
    );
    this.modelId = modelId;
    this.issues = issues;
    this.name = "SchemaValidationError";
  }
  modelId;
  issues;
};

// src/catalog.ts
var normalizeModality = (value) => value === "document" ? "pdf" : value === "attachment" ? "file" : value;
var StaticCapabilityCatalog = class {
  constructor(capabilities) {
    this.capabilities = capabilities;
  }
  capabilities;
  async listCapabilities() {
    return this.capabilities;
  }
};
var createStaticCapabilityCatalog = (capabilities) => new StaticCapabilityCatalog(capabilities);
var createCapabilityCatalog = (load) => ({
  listCapabilities: async () => {
    try {
      return await load();
    } catch (cause) {
      throw new ModelRouterError("Unable to load model capability catalog.", cause);
    }
  }
});
var filterCapabilityCatalog = (catalog, filter) => {
  const predicate = typeof filter === "function" ? filter : (() => {
    const allow = new Set(filter);
    return (capability) => allow.has(`${capability.providerId}/${capability.modelId}`) || allow.has(capability.modelId);
  })();
  return {
    listCapabilities: async () => (await catalog.listCapabilities()).filter(predicate)
  };
};
var mergeCapabilities = (base, overrides) => {
  const byKey = new Map(overrides.map((o) => [`${o.providerId}/${o.modelId}`, o]));
  return base.map((capability) => {
    const override = byKey.get(`${capability.providerId}/${capability.modelId}`);
    if (!override) return capability;
    return {
      ...capability,
      ...override,
      features: override.features ? [.../* @__PURE__ */ new Set([...capability.features, ...override.features])] : capability.features,
      limits: override.limits ? { ...capability.limits, ...override.limits } : capability.limits,
      pricing: override.pricing ? { ...capability.pricing, ...override.pricing } : capability.pricing,
      benchmarks: override.benchmarks ? { ...capability.benchmarks, ...override.benchmarks } : capability.benchmarks
    };
  });
};
var ModelsDevCapabilityCatalog = class {
  constructor(url = "https://models.dev/api.json", fetcher = fetch) {
    this.url = url;
    this.fetcher = fetcher;
  }
  url;
  fetcher;
  async listCapabilities() {
    try {
      const response = await this.fetcher(this.url);
      if (!response.ok) {
        throw new Error(`models.dev responded with ${response.status}`);
      }
      return normalizeModelsDevCatalog(await response.json());
    } catch (cause) {
      throw new ModelRouterError("Unable to load model capability catalog.", cause);
    }
  }
};
var normalizeModelsDevCatalog = (catalog) => {
  if (!catalog || typeof catalog !== "object") return [];
  const capabilities = [];
  for (const [providerKey, providerValue] of Object.entries(catalog)) {
    if (!providerValue || typeof providerValue !== "object") continue;
    const provider = providerValue;
    for (const [modelKey, modelValue] of Object.entries(provider.models ?? {})) {
      if (!modelValue || typeof modelValue !== "object") continue;
      const model = modelValue;
      const features = [];
      if (model.structured_output) features.push("structured_output");
      if (model.tool_call) features.push("tools");
      if (model.reasoning) features.push("reasoning");
      if (model.attachment) features.push("attachments");
      capabilities.push({
        providerId: provider.id ?? providerKey,
        providerName: provider.name ?? provider.id ?? providerKey,
        modelId: model.id ?? modelKey,
        modelName: model.name ?? model.id ?? modelKey,
        inputModalities: (model.modalities?.input ?? ["text"]).map(normalizeModality),
        outputModalities: (model.modalities?.output ?? ["text"]).map(normalizeModality),
        features,
        limits: {
          contextTokens: model.limit?.context,
          outputTokens: model.limit?.output
        },
        pricing: {
          inputPerMillionTokens: model.cost?.input,
          outputPerMillionTokens: model.cost?.output
        },
        releaseDate: model.release_date,
        lastUpdated: model.last_updated
      });
    }
  }
  return capabilities;
};

// src/policy.ts
var matchesId = (capability, id) => id.includes("/") ? `${capability.providerId}/${capability.modelId}` === id : capability.modelId === id;
var latencyWeight = {
  fast: 3,
  standard: 2,
  slow: 1
};
var byBenchmark = (source, options = {}) => {
  return async ({ candidates }) => {
    let score;
    if (typeof source === "string") {
      score = (capability) => capability.benchmarks?.[source];
    } else if (typeof source === "function") {
      score = source;
    } else {
      const map = await source.resolve();
      score = (capability) => map[`${capability.providerId}/${capability.modelId}`] ?? map[capability.modelId];
    }
    const scored = candidates.map((candidate) => ({ candidate, value: score(candidate.capability) }));
    const kept = options.minimum !== void 0 ? scored.filter((s) => s.value !== void 0 && s.value >= options.minimum) : scored;
    return [...kept].sort((a, b) => (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY)).map((s) => s.candidate);
  };
};
var pin = (ids, base) => {
  const wanted = typeof ids === "string" ? [ids] : ids;
  return async (context) => {
    const pinned = [];
    for (const id of wanted) {
      const found = context.candidates.find(
        (c) => matchesId(c.capability, id) && !pinned.includes(c)
      );
      if (found) pinned.push(found);
    }
    const rest = context.candidates.filter((c) => !pinned.includes(c));
    const tail = base ? await base({ ...context, candidates: rest }) : rest;
    return [...pinned, ...tail];
  };
};
var qualityCap = (max, base) => {
  return async (context) => {
    const under = context.candidates.filter((c) => qualityScore(c.capability) <= max);
    const pool = under.length > 0 ? under : context.candidates;
    if (base) return base({ ...context, candidates: pool });
    return [...pool].sort((a, b) => qualityScore(b.capability) - qualityScore(a.capability));
  };
};
var estimatedCostUsd = (capability, inputTokens, outputTokens) => {
  const input = capability.pricing.inputPerMillionTokens;
  const output = capability.pricing.outputPerMillionTokens;
  if (input === void 0 && output === void 0) return void 0;
  return ((input ?? 0) * inputTokens + (output ?? 0) * outputTokens) / 1e6;
};
var qualityScore = (capability) => capability.qualityScore ?? [
  capability.features.includes("structured_output") ? 2 : 0,
  capability.features.includes("reasoning") ? 1 : 0,
  capability.features.includes("tools") ? 0.5 : 0,
  capability.features.includes("attachments") ? 0.5 : 0,
  Math.min((capability.limits.contextTokens ?? 0) / 25e4, 2)
].reduce((sum, value) => sum + value, 0);
var namedPolicy = (preference, preferredProviderIds = []) => ({ candidates }) => {
  const preferred = new Set(preferredProviderIds);
  return [...candidates].sort((left, right) => {
    const leftPreferred = preferred.has(left.capability.providerId) ? 1 : 0;
    const rightPreferred = preferred.has(right.capability.providerId) ? 1 : 0;
    if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
    if (preference === "cheapest") {
      return (left.estimatedCostUsd ?? Number.POSITIVE_INFINITY) - (right.estimatedCostUsd ?? Number.POSITIVE_INFINITY);
    }
    if (preference === "fastest") {
      return latencyWeight[right.capability.latencyClass ?? "standard"] - latencyWeight[left.capability.latencyClass ?? "standard"] || (left.estimatedCostUsd ?? Number.POSITIVE_INFINITY) - (right.estimatedCostUsd ?? Number.POSITIVE_INFINITY);
    }
    if (preference === "best_quality") {
      return qualityScore(right.capability) - qualityScore(left.capability);
    }
    return right.score - left.score || (left.estimatedCostUsd ?? Number.POSITIVE_INFINITY) - (right.estimatedCostUsd ?? Number.POSITIVE_INFINITY);
  });
};
var explainCandidate = (capability, preference) => {
  const modalities = capability.inputModalities.join("+");
  if (preference === "cheapest") return `Lowest estimated cost among ${modalities} candidates.`;
  if (preference === "fastest") return `Fastest available ${modalities} candidate.`;
  if (preference === "best_quality") return `Highest quality ${modalities} candidate.`;
  return `Balanced cost, capability, and availability for ${modalities}.`;
};

// src/balance.ts
var resolveBase = async (base, context) => typeof base === "function" ? base(context) : namedPolicy(base, context.request.constraints?.preferredProviderIds)(context);
var loadBalance = (base, options = {}) => {
  const { across = Number.POSITIVE_INFINITY, strategy = "round-robin" } = options;
  let cursor = 0;
  return async (context) => {
    const ranked = [...await resolveBase(base, context)];
    const n = Math.min(across, ranked.length);
    if (n <= 1) return ranked;
    const offset = strategy === "random" ? Math.floor(Math.random() * n) : cursor % n;
    if (strategy !== "random") cursor = (cursor + 1) % n;
    const group = ranked.slice(0, n);
    return [...group.slice(offset), ...group.slice(0, offset), ...ranked.slice(n)];
  };
};
var roundRobin = (items) => {
  if (items.length === 0) throw new Error("roundRobin requires at least one item.");
  let index = 0;
  return () => {
    const item = items[index];
    index = (index + 1) % items.length;
    return item;
  };
};

// src/schema.ts
var isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var typeOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};
var matchesType = (value, type) => {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
};
var looksLikeJsonSchema = (schema) => {
  if (!isPlainObject(schema)) return false;
  return "type" in schema || "properties" in schema || "items" in schema || "enum" in schema || "const" in schema || "required" in schema || "anyOf" in schema || "oneOf" in schema || "allOf" in schema;
};
var validateAgainstJsonSchema = (value, schema) => {
  const issues = [];
  const label = (path) => path || "(root)";
  const walk = (val, sch, path) => {
    if (!isPlainObject(sch)) return;
    if (Array.isArray(sch.anyOf)) {
      const ok = sch.anyOf.some(
        (sub) => validateAgainstJsonSchema(val, sub).length === 0
      );
      if (!ok) issues.push(`${label(path)}: does not match any of anyOf`);
    }
    if (Array.isArray(sch.oneOf)) {
      const matched = sch.oneOf.filter(
        (sub) => validateAgainstJsonSchema(val, sub).length === 0
      ).length;
      if (matched !== 1) {
        issues.push(`${label(path)}: matched ${matched} of oneOf (expected 1)`);
      }
    }
    if (Array.isArray(sch.allOf)) {
      for (const sub of sch.allOf) walk(val, sub, path);
    }
    if ("const" in sch && JSON.stringify(val) !== JSON.stringify(sch.const)) {
      issues.push(`${label(path)}: must equal ${JSON.stringify(sch.const)}`);
    }
    if (Array.isArray(sch.enum) && !sch.enum.some((member) => JSON.stringify(member) === JSON.stringify(val))) {
      issues.push(`${label(path)}: must be one of ${JSON.stringify(sch.enum)}`);
    }
    const types = sch.type === void 0 ? [] : Array.isArray(sch.type) ? sch.type : [sch.type];
    if (types.length > 0 && !types.some((t) => matchesType(val, String(t)))) {
      issues.push(
        `${label(path)}: expected type ${types.join("|")}, got ${typeOf(val)}`
      );
      return;
    }
    if (isPlainObject(val)) {
      const props = isPlainObject(sch.properties) ? sch.properties : void 0;
      const prefix = path ? `${path}.` : "";
      if (Array.isArray(sch.required)) {
        for (const key of sch.required) {
          if (typeof key === "string" && !(key in val)) {
            issues.push(`${prefix}${key}: required property missing`);
          }
        }
      }
      if (props) {
        for (const [key, sub] of Object.entries(props)) {
          if (key in val) walk(val[key], sub, `${prefix}${key}`);
        }
      }
      if (sch.additionalProperties === false) {
        const allowed = props ? Object.keys(props) : [];
        for (const key of Object.keys(val)) {
          if (!allowed.includes(key)) {
            issues.push(`${prefix}${key}: additional property not allowed`);
          }
        }
      }
    }
    if (Array.isArray(val) && isPlainObject(sch.items)) {
      val.forEach((item, index) => walk(item, sch.items, `${path}[${index}]`));
    }
  };
  walk(value, schema, "");
  return issues;
};

// src/router.ts
var DEFAULT_INPUT_TOKENS = 8e3;
var DEFAULT_OUTPUT_TOKENS = 2e3;
var defaultOutputModalities = ["text"];
var hasEvery = (available, required) => required.every((value) => available.includes(value));
var providerAvailable = (adapter) => Boolean(adapter) && (adapter?.isAvailable ? adapter.isAvailable() : true);
var reject = (rejected, capability, reason) => {
  rejected.push({ providerId: capability.providerId, modelId: capability.modelId, reason });
};
var ModelRouter = class {
  constructor(options) {
    this.options = options;
    this.providers = new Map(options.providers.map((provider) => [provider.providerId, provider]));
  }
  options;
  providers;
  async plan(request) {
    const capabilities = await this.options.catalog.listCapabilities();
    const rejected = [];
    const inputTokens = request.estimatedInputTokens ?? DEFAULT_INPUT_TOKENS;
    const outputTokens = request.estimatedOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
    const outputModalities = request.outputModalities ?? defaultOutputModalities;
    const requiredFeatures = request.requiresFeatures ?? [];
    const denied = new Set(request.constraints?.deniedProviderIds ?? []);
    const allowed = request.constraints?.allowedProviderIds ? new Set(request.constraints.allowedProviderIds) : void 0;
    const maxLatencyClass = request.constraints?.maxLatencyClass;
    const candidates = [];
    for (const capability of capabilities) {
      const adapter = this.providers.get(capability.providerId);
      if (!providerAvailable(adapter)) {
        reject(rejected, capability, "No available provider adapter.");
        continue;
      }
      if (allowed && !allowed.has(capability.providerId)) {
        reject(rejected, capability, "Provider is not allowed by policy.");
        continue;
      }
      if (denied.has(capability.providerId)) {
        reject(rejected, capability, "Provider is denied by policy.");
        continue;
      }
      if (!hasEvery(capability.inputModalities, request.inputModalities)) {
        reject(rejected, capability, "Model does not support the required input modalities.");
        continue;
      }
      if (!hasEvery(capability.outputModalities, outputModalities)) {
        reject(rejected, capability, "Model does not support the required output modalities.");
        continue;
      }
      const missingFeature = requiredFeatures.find(
        (feature) => !capability.features.includes(feature)
      );
      if (missingFeature) {
        reject(rejected, capability, `Missing required feature: ${missingFeature}.`);
        continue;
      }
      if (capability.limits.contextTokens && capability.limits.contextTokens < inputTokens) {
        reject(rejected, capability, "Estimated input exceeds context window.");
        continue;
      }
      if (capability.limits.outputTokens && capability.limits.outputTokens < outputTokens) {
        reject(rejected, capability, "Estimated output exceeds output limit.");
        continue;
      }
      if (maxLatencyClass && latencyWeight[capability.latencyClass ?? "standard"] < latencyWeight[maxLatencyClass]) {
        reject(rejected, capability, "Model is slower than the latency policy allows.");
        continue;
      }
      const cost = estimatedCostUsd(capability, inputTokens, outputTokens);
      if (cost !== void 0 && request.constraints?.maxCostUsd !== void 0) {
        if (cost > request.constraints.maxCostUsd) {
          reject(rejected, capability, "Estimated cost exceeds policy.");
          continue;
        }
      }
      const latency = latencyWeight[capability.latencyClass ?? "standard"];
      const score = qualityScore(capability) + latency - (cost ?? 0) * 20;
      candidates.push({
        capability,
        score,
        estimatedCostUsd: cost,
        reason: explainCandidate(
          capability,
          typeof request.preference === "string" ? request.preference : this.options.defaultPreference ?? "balanced"
        )
      });
    }
    return this.finalizePlan(request, candidates, rejected, inputTokens, outputTokens);
  }
  /** Shared tail of {@link plan} / {@link planRerank}: rank the surviving
   *  candidates by preference (or a custom policy) and assemble the RoutePlan. */
  async finalizePlan(request, candidates, rejected, inputTokens, outputTokens) {
    if (candidates.length === 0) {
      throw new ModelRouterError(
        `No model supports task "${request.task}" with the requested constraints.`
      );
    }
    const preference = typeof request.preference === "function" ? "custom" : request.preference ?? this.options.defaultPreference ?? "balanced";
    const namedPreference = typeof request.preference === "string" ? request.preference : this.options.defaultPreference ?? "balanced";
    const policy = typeof request.preference === "function" ? request.preference : namedPolicy(namedPreference, request.constraints?.preferredProviderIds);
    const ranked = await policy({ request, candidates });
    const [selected, ...fallbacks] = ranked;
    if (!selected) {
      throw new ModelRouterError("Routing policy returned no candidates.");
    }
    return {
      task: request.task,
      preference,
      selected,
      fallbacks: request.constraints?.allowFallbacks === false ? [] : fallbacks,
      rejected,
      estimate: {
        inputTokens,
        outputTokens,
        costUsd: selected.estimatedCostUsd
      }
    };
  }
  /**
   * Plan a rerank: filter the catalog to reranker models (a `rerank` capability
   * + an adapter that implements `rerank`) satisfying `requiresFeatures` (e.g.
   * `["explanations"]`) and constraints, then rank by preference. Inspectable
   * like {@link plan} — every rejected model carries a reason.
   */
  async planRerank(request) {
    const capabilities = await this.options.catalog.listCapabilities();
    const rejected = [];
    const inputTokens = request.estimatedInputTokens ?? DEFAULT_INPUT_TOKENS;
    const outputTokens = request.estimatedOutputTokens ?? 0;
    const requiredFeatures = request.requiresFeatures ?? [];
    const denied = new Set(request.constraints?.deniedProviderIds ?? []);
    const allowed = request.constraints?.allowedProviderIds ? new Set(request.constraints.allowedProviderIds) : void 0;
    const named = typeof request.preference === "string" ? request.preference : this.options.defaultPreference ?? "balanced";
    const candidates = [];
    for (const capability of capabilities) {
      const adapter = this.providers.get(capability.providerId);
      if (!providerAvailable(adapter)) {
        reject(rejected, capability, "No available provider adapter.");
        continue;
      }
      if (!capability.rerank) {
        reject(rejected, capability, "Model is not a reranker.");
        continue;
      }
      if (!adapter?.rerank) {
        reject(rejected, capability, "Provider adapter cannot rerank.");
        continue;
      }
      if (allowed && !allowed.has(capability.providerId)) {
        reject(rejected, capability, "Provider is not allowed by policy.");
        continue;
      }
      if (denied.has(capability.providerId)) {
        reject(rejected, capability, "Provider is denied by policy.");
        continue;
      }
      const missingFeature = requiredFeatures.find(
        (feature) => !capability.features.includes(feature)
      );
      if (missingFeature) {
        reject(rejected, capability, `Missing required feature: ${missingFeature}.`);
        continue;
      }
      const maxDocuments = capability.rerank.maxDocuments;
      if (maxDocuments !== void 0 && request.documents.length > maxDocuments) {
        reject(
          rejected,
          capability,
          `Too many documents (${request.documents.length} > ${maxDocuments}).`
        );
        continue;
      }
      const cost = capability.rerank.pricePerSearchUsd ?? estimatedCostUsd(capability, inputTokens, outputTokens);
      if (cost !== void 0 && request.constraints?.maxCostUsd !== void 0 && cost > request.constraints.maxCostUsd) {
        reject(rejected, capability, "Estimated cost exceeds policy.");
        continue;
      }
      const latency = latencyWeight[capability.latencyClass ?? "standard"];
      const score = qualityScore(capability) + latency - (cost ?? 0) * 20;
      candidates.push({
        capability,
        score,
        estimatedCostUsd: cost,
        reason: explainCandidate(capability, named)
      });
    }
    const policyRequest = {
      task: request.task,
      input: request.input ?? request.query,
      inputModalities: ["text"],
      requiresFeatures: request.requiresFeatures,
      preference: request.preference,
      constraints: request.constraints,
      estimatedInputTokens: request.estimatedInputTokens,
      estimatedOutputTokens: request.estimatedOutputTokens
    };
    return this.finalizePlan(policyRequest, candidates, rejected, inputTokens, outputTokens);
  }
  /**
   * Rerank `request.documents` by relevance to `request.query`, routing to the
   * best reranker and falling back automatically. The result's documents are
   * sorted by descending score and capped at `topK`; `reason` is populated only
   * when the chosen reranker supports `"explanations"`.
   */
  async rerank(request) {
    const plan = await this.planRerank(request);
    const topK = request.topK ?? request.documents.length;
    const run = await this.executePlan(
      plan,
      request.task,
      (adapter, capability) => adapter.rerank ? adapter.rerank({ ...request, model: capability }).then(
        (scored) => [...scored].filter((s) => s.index >= 0 && s.index < request.documents.length).map(
          (s) => ({
            index: s.index,
            document: request.documents[s.index],
            score: s.score,
            reason: s.reason
          })
        ).sort((a, b) => b.score - a.score).slice(0, topK)
      ) : void 0,
      "Provider adapter cannot rerank."
    );
    const winner = run.attempts[run.attempts.length - 1];
    const model = [plan.selected, ...plan.fallbacks].find(
      (route) => route.capability.providerId === winner?.providerId && route.capability.modelId === winner?.modelId
    )?.capability ?? plan.selected.capability;
    return {
      results: run.output,
      model,
      plan: run.plan,
      attempts: run.attempts
    };
  }
  /**
   * Generate from the best-routed model. The kind of output is inferred from
   * the request, not the method name:
   *
   *   • `outputModalities` includes `"image"` → an image (set `Output` to
   *     `GeneratedImage`); routes to the adapter's `generateImage`
   *   • a `schema` is present → a schema-validated object; routes to
   *     `generateObject`
   *   • otherwise → free text (set `Output` to `string`); routes to
   *     `generateText`
   *
   * A model is only eligible if its catalog entry supports the requested
   * modalities/features AND its adapter implements the matching method; if not,
   * the router falls through to the next route.
   */
  async generate(request) {
    const plan = await this.plan(request);
    const wantsImage = (request.outputModalities ?? defaultOutputModalities).includes(
      "image"
    );
    if (wantsImage) {
      return this.executePlan(
        plan,
        request.task,
        (adapter, capability) => adapter.generateImage ? adapter.generateImage({
          ...request,
          model: capability
        }) : void 0,
        "Provider adapter cannot generate images."
      );
    }
    if (request.schema !== void 0) {
      return this.executePlan(
        plan,
        request.task,
        (adapter, capability) => adapter.generateObject ? this.generateValidatedObject(adapter, capability, request) : void 0,
        "Provider adapter cannot generate objects."
      );
    }
    return this.executePlan(
      plan,
      request.task,
      (adapter, capability) => adapter.generateText ? adapter.generateText({
        ...request,
        prompt: request.prompt ?? "",
        model: capability
      }) : void 0,
      "Provider adapter cannot generate text."
    );
  }
  /**
   * Call an adapter's `generateObject` and, unless disabled, validate the
   * result against the request's JSON Schema. A non-conforming object throws a
   * {@link SchemaValidationError}, which `executePlan` records as a failed
   * attempt — so the router falls through to the next routed model.
   */
  async generateValidatedObject(adapter, capability, request) {
    const output = await adapter.generateObject({
      ...request,
      model: capability
    });
    if (this.options.validateStructuredOutput !== false && looksLikeJsonSchema(request.schema)) {
      const issues = validateAgainstJsonSchema(output, request.schema);
      if (issues.length > 0) {
        throw new SchemaValidationError(capability.modelId, issues);
      }
    }
    return output;
  }
  /** @deprecated Use {@link generate} — it infers structured output from a
   *  `schema` in the request. `run` remains as a thin alias. */
  async run(request) {
    const plan = await this.plan(request);
    return this.executePlan(
      plan,
      request.task,
      (adapter, capability) => adapter.generateObject ? this.generateValidatedObject(adapter, capability, request) : void 0,
      "Provider adapter cannot generate objects."
    );
  }
  /** @deprecated Use {@link generate} — text is the default when no `schema`
   *  or image modality is requested. */
  async runText(request) {
    const plan = await this.plan(request);
    return this.executePlan(
      plan,
      request.task,
      (adapter, capability) => adapter.generateText ? adapter.generateText({ ...request, model: capability }) : void 0,
      "Provider adapter cannot generate text."
    );
  }
  /** @deprecated Use `(await generate(req)).output`. */
  async generateObject(request) {
    return (await this.run(request)).output;
  }
  /** @deprecated Use `(await generate(req)).output`. */
  async generateText(request) {
    return (await this.runText(request)).output;
  }
  async executePlan(plan, task, invoke, unsupportedReason) {
    const routes = [plan.selected, ...plan.fallbacks];
    const attempts = [];
    for (const route of routes) {
      const adapter = this.providers.get(route.capability.providerId);
      const pending = adapter ? invoke(adapter, route.capability) : void 0;
      if (!pending) {
        attempts.push({
          providerId: route.capability.providerId,
          modelId: route.capability.modelId,
          ok: false,
          error: unsupportedReason
        });
        continue;
      }
      try {
        const output = await pending;
        attempts.push({
          providerId: route.capability.providerId,
          modelId: route.capability.modelId,
          ok: true
        });
        return { output, plan, attempts };
      } catch (cause) {
        attempts.push({
          providerId: route.capability.providerId,
          modelId: route.capability.modelId,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause)
        });
      }
    }
    throw new ModelRouterError(`All model routes failed for task "${task}".`);
  }
};

// src/rerank.ts
var defaultPrompt = (query, documents, explanations) => [
  "Rank the documents by how well they answer the query, most relevant first.",
  "Only include documents that are actually relevant; omit the rest.",
  explanations ? "For each, give a one-sentence reason." : "",
  "",
  `Query: ${query}`,
  "",
  "Documents:",
  ...documents.map((doc, index) => `[${index}] ${doc}`)
].filter(Boolean).join("\n");
var rankingSchema = (explanations) => ({
  type: "object",
  properties: {
    ranking: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "number" }, reason: { type: "string" } },
        required: explanations ? ["index", "reason"] : ["index"],
        additionalProperties: false
      }
    }
  },
  required: ["ranking"],
  additionalProperties: false
});
var extractRanking = (raw) => {
  const obj = raw && typeof raw === "object" && "object" in raw ? raw.object : raw;
  const ranking = obj?.ranking;
  if (!Array.isArray(ranking)) return [];
  return ranking.filter(
    (r) => !!r && typeof r === "object" && typeof r.index === "number"
  ).map((r) => ({ index: r.index, reason: typeof r.reason === "string" ? r.reason : void 0 }));
};
var llmReranker = (options) => async (request) => {
  const explanations = options.explanations !== false;
  const prompt = options.prompt ? options.prompt(request.query, request.documents) : defaultPrompt(request.query, request.documents, explanations);
  const raw = await options.generateObject({ prompt, schema: rankingSchema(explanations) });
  const ranking = extractRanking(raw);
  const byIndex = /* @__PURE__ */ new Map();
  ranking.forEach((entry, position) => {
    if (entry.index >= 0 && entry.index < request.documents.length && !byIndex.has(entry.index)) {
      byIndex.set(entry.index, {
        index: entry.index,
        score: ranking.length - position,
        reason: entry.reason
      });
    }
  });
  return request.documents.map((_, index) => byIndex.get(index) ?? { index, score: 0 });
};

// src/adapters.ts
var createCallbackProviderAdapter = (options) => ({
  providerId: options.providerId,
  name: options.name,
  isAvailable: options.isAvailable,
  generateObject: options.generateObject ? async (request) => await options.generateObject(request) : void 0,
  generateText: options.generateText ? async (request) => options.generateText(request) : void 0,
  generateImage: options.generateImage ? async (request) => options.generateImage(request) : void 0,
  rerank: options.rerank ? async (request) => options.rerank(request) : void 0
});

// src/env.ts
var apiKeyEnvVars = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"],
  "google-vertex": ["GOOGLE_VERTEX_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
  xai: ["XAI_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  cohere: ["COHERE_API_KEY", "CO_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  togetherai: ["TOGETHER_AI_API_KEY", "TOGETHER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  azure: ["AZURE_API_KEY", "AZURE_OPENAI_API_KEY"]
};
var defaultEnv = () => typeof process !== "undefined" && process.env ? process.env : {};
var apiKeyEnvVarsFor = (providerId) => apiKeyEnvVars[providerId] ?? [`${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`];
var hasApiKey = (providerId, options = {}) => {
  const env = options.env ?? defaultEnv();
  const vars = options.vars ?? apiKeyEnvVarsFor(providerId);
  return vars.some((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
};

export { ModelRouter, ModelRouterError, ModelsDevCapabilityCatalog, SchemaValidationError, StaticCapabilityCatalog, apiKeyEnvVars, apiKeyEnvVarsFor, byBenchmark, createCallbackProviderAdapter, createCapabilityCatalog, createStaticCapabilityCatalog, estimatedCostUsd, filterCapabilityCatalog, hasApiKey, llmReranker, loadBalance, looksLikeJsonSchema, mergeCapabilities, namedPolicy, normalizeModelsDevCatalog, pin, qualityCap, qualityScore, roundRobin, validateAgainstJsonSchema };
