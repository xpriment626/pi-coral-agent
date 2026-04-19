import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./debug.js";

describe("redactSecrets", () => {
  test("redacts exact env-provided secrets", () => {
    const out = redactSecrets({ key: "my-secret-value", other: "safe" }, ["my-secret-value"]);
    assert.deepEqual(out, { key: "[redacted]", other: "safe" });
  });

  test("redacts OpenAI-style sk- keys by pattern", () => {
    const out = redactSecrets({ key: "sk-abcdef0123456789abcd" }, []);
    assert.deepEqual(out, { key: "[redacted]" });
  });

  test("does NOT redact long base58-ish strings (Solana-specific pattern removed)", () => {
    const base58Like = "A".repeat(88);
    const out = redactSecrets({ key: base58Like }, []);
    assert.deepEqual(out, { key: base58Like });
  });

  test("recurses through arrays and nested objects", () => {
    const out = redactSecrets(
      { outer: { list: ["safe", "secret-A", { deeper: "secret-B" }] } },
      ["secret-A", "secret-B"]
    );
    assert.deepEqual(out, {
      outer: { list: ["safe", "[redacted]", { deeper: "[redacted]" }] },
    });
  });

  test("ignores empty-string entries in secretsFromEnv", () => {
    const out = redactSecrets({ key: "" }, [""]);
    assert.deepEqual(out, { key: "" });
  });
});
