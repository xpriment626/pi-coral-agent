import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildIterationPayload } from "./pi-runtime.js";

describe("buildIterationPayload", () => {
  test("captures systemPrompt, iteration, event, and timestamp", () => {
    const payload = buildIterationPayload({
      iteration: 3,
      agent: { state: { systemPrompt: "hello world" } },
      event: { type: "turn_end", tools: [] },
      nowIso: "2026-04-19T12:00:00.000Z",
    });

    assert.equal(payload.iteration, 3);
    assert.equal(payload.systemPrompt, "hello world");
    assert.equal(payload.ts, "2026-04-19T12:00:00.000Z");
    assert.deepEqual(payload.event, { type: "turn_end", tools: [] });
  });

  test("defaults systemPrompt to empty string when undefined", () => {
    const payload = buildIterationPayload({
      iteration: 0,
      agent: { state: {} },
      event: { type: "turn_end" },
      nowIso: "2026-04-19T12:00:00.000Z",
    });
    assert.equal(payload.systemPrompt, "");
  });

  test("defaults ts to a fresh ISO string when nowIso omitted", () => {
    const before = Date.now();
    const payload = buildIterationPayload({
      iteration: 0,
      agent: { state: { systemPrompt: "x" } },
      event: null,
    });
    const ts = Date.parse(payload.ts);
    assert.ok(ts >= before && ts <= Date.now() + 1000, `ts ${payload.ts} should be near-now`);
  });
});
