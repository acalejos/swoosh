/**
 * A tiny, dependency-free validator for the common subset of JSON Schema that
 * structured-output requests use. It is intentionally NOT a full JSON Schema
 * implementation — it covers what models are actually constrained to produce
 * (types, properties, required, enums, items, composition) so the router can
 * honor its "schema-validated object" contract without pulling in a heavy
 * dependency or coupling to any one schema library.
 *
 * Anything it doesn't recognize is treated permissively (no false negatives):
 * unknown keywords, boolean sub-schemas, and non-JSON-Schema values (e.g. a Zod
 * schema, which the adapter validates itself) simply pass.
 */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const matchesType = (value: unknown, type: string): boolean => {
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
      // Unknown type keyword — don't fail on something we don't model.
      return true;
  }
};

/**
 * Does `schema` look like a JSON Schema we can validate against? Used so the
 * router only enforces validation when given an actual JSON Schema, leaving
 * other schema representations (Zod, etc.) to the adapter.
 */
export const looksLikeJsonSchema = (
  schema: unknown,
): schema is Record<string, unknown> => {
  if (!isPlainObject(schema)) return false;
  return (
    "type" in schema ||
    "properties" in schema ||
    "items" in schema ||
    "enum" in schema ||
    "const" in schema ||
    "required" in schema ||
    "anyOf" in schema ||
    "oneOf" in schema ||
    "allOf" in schema
  );
};

/**
 * Validate `value` against a JSON Schema. Returns a list of human-readable
 * issues (with dotted paths); an empty array means the value conforms.
 */
export const validateAgainstJsonSchema = (
  value: unknown,
  schema: unknown,
): string[] => {
  const issues: string[] = [];

  const label = (path: string): string => path || "(root)";

  const walk = (val: unknown, sch: unknown, path: string): void => {
    // Boolean schemas / non-objects: nothing to enforce.
    if (!isPlainObject(sch)) return;

    // Composition keywords.
    if (Array.isArray(sch.anyOf)) {
      const ok = sch.anyOf.some(
        (sub) => validateAgainstJsonSchema(val, sub).length === 0,
      );
      if (!ok) issues.push(`${label(path)}: does not match any of anyOf`);
    }
    if (Array.isArray(sch.oneOf)) {
      const matched = sch.oneOf.filter(
        (sub) => validateAgainstJsonSchema(val, sub).length === 0,
      ).length;
      if (matched !== 1) {
        issues.push(`${label(path)}: matched ${matched} of oneOf (expected 1)`);
      }
    }
    if (Array.isArray(sch.allOf)) {
      for (const sub of sch.allOf) walk(val, sub, path);
    }

    // const / enum.
    if ("const" in sch && JSON.stringify(val) !== JSON.stringify(sch.const)) {
      issues.push(`${label(path)}: must equal ${JSON.stringify(sch.const)}`);
    }
    if (
      Array.isArray(sch.enum) &&
      !sch.enum.some((member) => JSON.stringify(member) === JSON.stringify(val))
    ) {
      issues.push(`${label(path)}: must be one of ${JSON.stringify(sch.enum)}`);
    }

    // type.
    const types =
      sch.type === undefined ? [] : Array.isArray(sch.type) ? sch.type : [sch.type];
    if (types.length > 0 && !types.some((t) => matchesType(val, String(t)))) {
      issues.push(
        `${label(path)}: expected type ${types.join("|")}, got ${typeOf(val)}`,
      );
      // A type mismatch makes deeper structural checks meaningless.
      return;
    }

    // Object constraints.
    if (isPlainObject(val)) {
      const props = isPlainObject(sch.properties) ? sch.properties : undefined;
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

    // Array items.
    if (Array.isArray(val) && isPlainObject(sch.items)) {
      val.forEach((item, index) => walk(item, sch.items, `${path}[${index}]`));
    }
  };

  walk(value, schema, "");
  return issues;
};
