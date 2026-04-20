import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sanitizeJsonSchema } from "./coral-mcp.js";

describe("sanitizeJsonSchema — exclusive bound coercion", () => {
  test("converts draft-4 boolean exclusiveMinimum + minimum into 2020-12 numeric form", () => {
    const out = sanitizeJsonSchema({
      type: "number",
      exclusiveMinimum: true,
      minimum: 0,
      description: "a positive number",
    });
    assert.equal(out.exclusiveMinimum, 0);
    assert.equal(out.minimum, undefined);
    assert.equal(out.description, "a positive number");
  });

  test("converts draft-4 boolean exclusiveMaximum + maximum into 2020-12 numeric form", () => {
    const out = sanitizeJsonSchema({
      type: "integer",
      exclusiveMaximum: true,
      maximum: 100,
    });
    assert.equal(out.exclusiveMaximum, 100);
    assert.equal(out.maximum, undefined);
  });

  test("drops exclusiveMinimum=false (draft-4 'inclusive' marker) without touching minimum", () => {
    const out = sanitizeJsonSchema({
      type: "number",
      exclusiveMinimum: false,
      minimum: 5,
    });
    assert.equal(out.exclusiveMinimum, undefined);
    assert.equal(out.minimum, 5);
  });

  test("preserves 2020-12 numeric exclusiveMinimum unchanged", () => {
    const out = sanitizeJsonSchema({
      type: "number",
      exclusiveMinimum: 0,
    });
    assert.equal(out.exclusiveMinimum, 0);
    assert.equal(out.minimum, undefined);
  });

  test("recursively coerces inside object properties", () => {
    const out = sanitizeJsonSchema({
      type: "object",
      properties: {
        limit: { type: "number", exclusiveMinimum: true, minimum: 0 },
        name: { type: "string" },
      },
    });
    assert.equal(out.properties.limit.exclusiveMinimum, 0);
    assert.equal(out.properties.limit.minimum, undefined);
    assert.equal(out.properties.name.type, "string");
  });
});
