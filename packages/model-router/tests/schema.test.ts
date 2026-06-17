import { describe, expect, test } from "bun:test";
import { looksLikeJsonSchema, validateAgainstJsonSchema } from "@swoosh-dev/router";

const brand = {
  type: "object",
  properties: {
    product: { type: "string" },
    tagline: { type: "string" },
    colors: { type: "array", items: { type: "string" } },
  },
  required: ["product", "tagline", "colors"],
  additionalProperties: false,
} as const;

describe("validateAgainstJsonSchema", () => {
  test("accepts a conforming object", () => {
    expect(
      validateAgainstJsonSchema(
        { product: "Velvet Peak", tagline: "Crafted for the climb.", colors: ["#000"] },
        brand,
      ),
    ).toEqual([]);
  });

  test("flags missing required props AND wrong key names (the GLM case)", () => {
    // A model that returned product_name/brand_colors instead of product/colors.
    const issues = validateAgainstJsonSchema(
      { product_name: "Velvet Peak", tagline: "x", brand_colors: ["#000"] },
      brand,
    );
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.includes("product: required property missing"))).toBe(true);
    expect(issues.some((i) => i.includes("additional property not allowed"))).toBe(true);
  });

  test("flags a wrong scalar type", () => {
    const issues = validateAgainstJsonSchema(
      { product: 42, tagline: "x", colors: [] },
      brand,
    );
    expect(issues.some((i) => i.includes("product: expected type string"))).toBe(true);
  });

  test("validates array item types", () => {
    const issues = validateAgainstJsonSchema(
      { product: "p", tagline: "t", colors: ["#000", 7] },
      brand,
    );
    expect(issues.some((i) => i.includes("colors[1]"))).toBe(true);
  });

  test("enum / integer / nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        size: { enum: ["s", "m", "l"] },
        count: { type: "integer" },
        meta: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      },
      required: ["size", "count", "meta"],
    };
    expect(validateAgainstJsonSchema({ size: "m", count: 3, meta: { ok: true } }, schema)).toEqual([]);
    const bad = validateAgainstJsonSchema({ size: "xl", count: 3.5, meta: {} }, schema);
    expect(bad.some((i) => i.includes("size"))).toBe(true);
    expect(bad.some((i) => i.includes("count"))).toBe(true);
    expect(bad.some((i) => i.includes("meta.ok"))).toBe(true);
  });

  test("anyOf composition", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(validateAgainstJsonSchema("x", schema)).toEqual([]);
    expect(validateAgainstJsonSchema(5, schema)).toEqual([]);
    expect(validateAgainstJsonSchema(true, schema).length).toBeGreaterThan(0);
  });

  test("looksLikeJsonSchema only recognizes JSON-Schema shaped objects", () => {
    expect(looksLikeJsonSchema(brand)).toBe(true);
    expect(looksLikeJsonSchema({ type: "string" })).toBe(true);
    // Not JSON Schema (e.g. a Zod schema instance, or a plain value) → left alone.
    expect(looksLikeJsonSchema({ _def: {}, parse: () => {} })).toBe(false);
    expect(looksLikeJsonSchema(null)).toBe(false);
    expect(looksLikeJsonSchema("nope")).toBe(false);
  });
});
