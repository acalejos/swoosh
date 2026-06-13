import {
  createStaticCapabilityCatalog,
  type CapabilityCatalog,
  type ModelCapability,
} from "@swoosh/router";
import snapshot from "./capabilities.generated.json";

export { defaultOverrides } from "./overrides";

/** When the bundled snapshot was generated, and from where. */
export const meta: { readonly source: string; readonly generatedAt: string; readonly count: number } = {
  source: snapshot.source,
  generatedAt: snapshot.generatedAt,
  count: snapshot.count,
};

/** The bundled, enriched capability dataset (models.dev ∪ curated overrides). */
export const capabilities = snapshot.models as unknown as readonly ModelCapability[];

/** A ready-to-use catalog backed by the bundled dataset — no network, no keys. */
export const defaultCatalog = (): CapabilityCatalog => createStaticCapabilityCatalog(capabilities);
