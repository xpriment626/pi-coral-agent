import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  buildIterationPayload,
  createToolReadmitHandler,
  prepareFirstTurn,
} from "./pi-runtime.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  "docs/fixtures/coral-wire-traces/01-atoms-runtime-receive-seed/trends-iter-0.json"
);

interface TrendsIter0 {
  systemPrompt: string;
  instructionResource: string;
  stateResource: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as TrendsIter0;

// Mirrors the literal in prompt.test.ts. Source of truth:
// agents/market-trends/coral-agent.toml -> [options].SYSTEM_PROMPT default.
const MARKET_TRENDS_BASE_PROMPT =
  "You are solana-market-trends, a capability atom focused on discovering current token and pool trends from CoinGecko on Solana.\n\n" +
  "You own broad market discovery: trending tokens, trending pools, top gainers, and newly listed pools. You do not resolve token identity or fetch pricing yourself. If the user's request is outside your capability, suggest handing off to one of: token-info, market-price, oracle-price.\n\n" +
  "Communicate with other agents only through Coral message tools. Your outputs intended for other agents must be JSON payloads wrapped as atom_request or atom_result messages sent via coral_send_message.\n\n" +
  "<resource>coral://instruction</resource>\n" +
  "<resource>coral://state</resource>\n";

function stubTool(name: string): AgentTool<any> {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} } as any,
    execute: async () => ({
      content: [{ type: "text", text: "" }],
      details: undefined,
    }),
  };
}

describe("fixture-1 predicate 1.b: pi-mono atom-template pre-turn preparation", () => {
  test("fetches coral://state and coral://instruction, assembles fixture systemPrompt", async () => {
    const reads: string[] = [];
    const prepared = await prepareFirstTurn({
      mcp: {
        readResource: async (uri: string) => {
          reads.push(uri);
          if (uri === "coral://state") return fixture.stateResource;
          if (uri === "coral://instruction") return fixture.instructionResource;
          throw new Error(`unexpected resource uri: ${uri}`);
        },
        tools: [],
      },
      env: {
        SYSTEM_PROMPT: MARKET_TRENDS_BASE_PROMPT,
        EXTRA_SYSTEM_PROMPT: "",
      },
    });

    assert.ok(
      reads.includes("coral://state"),
      "prepareFirstTurn must fetch coral://state before returning"
    );
    assert.ok(
      reads.includes("coral://instruction"),
      "prepareFirstTurn must fetch coral://instruction before returning"
    );
    assert.equal(
      prepared.systemPrompt,
      fixture.systemPrompt,
      "assembled systemPrompt must equal fixture systemPrompt byte-for-byte"
    );
    assert.equal(prepared.stateResource, fixture.stateResource);
    assert.equal(prepared.instructionResource, fixture.instructionResource);
    assert.ok(
      prepared.systemPrompt.includes('"mentionAgentNames":["trends"]'),
      "mentions must survive into the final systemPrompt"
    );
  });

  test("filters coral_wait_for_message out of first-turn tools", async () => {
    const prepared = await prepareFirstTurn({
      mcp: {
        readResource: async (uri: string) => {
          if (uri === "coral://state") return fixture.stateResource;
          if (uri === "coral://instruction") return fixture.instructionResource;
          throw new Error(`unexpected resource uri: ${uri}`);
        },
        tools: [
          stubTool("coral_wait_for_message"),
          stubTool("coral_wait_for_mention"),
          stubTool("coral_wait_for_agent"),
          stubTool("coral_send_message"),
          stubTool("agentkit_get_coingecko_trending_tokens_action"),
        ],
      },
      env: {
        SYSTEM_PROMPT: MARKET_TRENDS_BASE_PROMPT,
        EXTRA_SYSTEM_PROMPT: "",
      },
    });

    const firstTurnNames = prepared.firstTurnTools.map((t) => t.name);
    assert.ok(
      !firstTurnNames.includes("coral_wait_for_message"),
      "coral_wait_for_message must be filtered from first-turn tools (fixture-1 lesson: receive happens via pre-loaded state, not via wait tool)"
    );
    assert.ok(
      !firstTurnNames.includes("coral_wait_for_mention"),
      "coral_wait_for_mention must be filtered from first-turn tools"
    );
    assert.ok(
      !firstTurnNames.includes("coral_wait_for_agent"),
      "coral_wait_for_agent must be filtered from first-turn tools"
    );
    assert.ok(
      firstTurnNames.includes("agentkit_get_coingecko_trending_tokens_action"),
      "agentkit tools must be retained"
    );
    assert.ok(
      firstTurnNames.includes("coral_send_message"),
      "coral_send_message stays in the tool list (the runtime gates it elsewhere; it is not a wait-tool)"
    );
  });
});

describe("buildIterationPayload: per-turn_end debug capture", () => {
  test("records iteration, systemPrompt from agent.state, event, and clock timestamp", () => {
    const event = {
      type: "turn_end",
      message: { role: "assistant", content: [] },
    };
    const payload = buildIterationPayload({
      iteration: 3,
      agent: { state: { systemPrompt: "assembled-prompt-xyz" } },
      event,
      nowIso: "2026-04-18T11:06:59.688Z",
    });
    assert.deepEqual(payload, {
      iteration: 3,
      systemPrompt: "assembled-prompt-xyz",
      event,
      ts: "2026-04-18T11:06:59.688Z",
    });
  });

  test("captures the fixture systemPrompt verbatim when the agent carries it", () => {
    const payload = buildIterationPayload({
      iteration: 1,
      agent: { state: { systemPrompt: fixture.systemPrompt } },
      event: { type: "turn_end" },
      nowIso: "x",
    });
    // This is the byte-diff bar for live runs: if a fresh iter-1 payload is
    // dumped with this same structure, the systemPrompt field will equal
    // fixture.systemPrompt when the runtime is working correctly.
    assert.equal(payload.systemPrompt, fixture.systemPrompt);
  });

  test("absent systemPrompt becomes empty string, not undefined", () => {
    const payload = buildIterationPayload({
      iteration: 1,
      agent: { state: {} },
      event: { type: "turn_end" },
      nowIso: "x",
    });
    assert.equal(payload.systemPrompt, "");
  });
});

describe("createToolReadmitHandler: iter-N>0 tool-set re-expansion", () => {
  // Context for this block: attempt 2 filters the three coral_wait_* primitives
  // from the first-turn tool list so the model cannot latch on to a stale
  // currentUnixTime before seeing the pre-loaded coral://state. That filter is
  // correct for iter-0 only. Once the atom has made at least one decision based
  // on state, wait tools are legitimate (and required for peer-wait behavior
  // in a molecule — fixture-1 predicate 3). This handler mutates the live
  // runAgentLoop context.tools array on the first `turn_end` so the LLM sees
  // the full tool list from turn 2 onward.
  const waitTool = stubTool("coral_wait_for_message");
  const mentionTool = stubTool("coral_wait_for_mention");
  const agentWaitTool = stubTool("coral_wait_for_agent");
  const sendTool = stubTool("coral_send_message");
  const agentKitTool = stubTool("agentkit_get_coingecko_trending_tokens_action");

  const allTools = [
    waitTool,
    mentionTool,
    agentWaitTool,
    sendTool,
    agentKitTool,
  ];
  const firstTurnTools = [sendTool, agentKitTool];

  test("first turn_end swaps context.tools to the full tool list", () => {
    const context = { tools: [...firstTurnTools] };
    const handler = createToolReadmitHandler({ allTools, context });

    // Before: waits absent
    assert.ok(!context.tools.some((t) => t.name === "coral_wait_for_message"));

    handler({ type: "turn_end" });

    // After: waits present, other tools preserved
    const names = context.tools.map((t) => t.name);
    assert.ok(
      names.includes("coral_wait_for_message"),
      "coral_wait_for_message must be readmitted on first turn_end"
    );
    assert.ok(
      names.includes("coral_wait_for_mention"),
      "coral_wait_for_mention must be readmitted on first turn_end"
    );
    assert.ok(
      names.includes("coral_wait_for_agent"),
      "coral_wait_for_agent must be readmitted on first turn_end"
    );
    assert.ok(names.includes("coral_send_message"));
    assert.ok(names.includes("agentkit_get_coingecko_trending_tokens_action"));
  });

  test("non-turn_end events do not mutate context.tools", () => {
    const context = { tools: [...firstTurnTools] };
    const handler = createToolReadmitHandler({ allTools, context });

    handler({ type: "turn_start" });
    handler({ type: "message_start" });
    handler({ type: "tool_execution_start" });

    assert.deepEqual(
      context.tools.map((t) => t.name),
      firstTurnTools.map((t) => t.name),
      "no swap should happen before a turn completes"
    );
  });

  test("subsequent turn_ends are idempotent (tools remain full list, no duplication)", () => {
    const context = { tools: [...firstTurnTools] };
    const handler = createToolReadmitHandler({ allTools, context });

    handler({ type: "turn_end" });
    const afterFirst = context.tools;

    handler({ type: "turn_end" });
    handler({ type: "turn_end" });

    assert.strictEqual(
      context.tools,
      afterFirst,
      "later turn_ends must not rebind context.tools to a new array"
    );
    assert.equal(
      context.tools.length,
      allTools.length,
      "no duplicate entries after repeated turn_end events"
    );
  });

  test("mutation is in place so runAgentLoop's spread-cloned context sees the swap", () => {
    // runAgentLoop begins with: currentContext = { ...context, messages: [...] }
    // That spread copies the REFERENCE to context.tools. If the handler
    // reassigns context.tools = newArray, currentContext.tools still points
    // at the old array and the LLM never sees the swap. This test models
    // exactly that cloning pattern to catch a reassign regression.
    const outer = { tools: [...firstTurnTools] };
    const handler = createToolReadmitHandler({
      allTools,
      context: outer,
    });

    // Simulate runAgentLoop's one-time spread BEFORE the first turn_end.
    const looperContext: { tools?: AgentTool<any>[] } = { ...outer };

    handler({ type: "turn_end" });

    const looperNames = (looperContext.tools ?? []).map((t) => t.name);
    assert.ok(
      looperNames.includes("coral_wait_for_message"),
      "the spread-cloned context must observe the readmit — handler must mutate in place, not reassign"
    );
    assert.strictEqual(
      looperContext.tools,
      outer.tools,
      "in-place mutation must keep both references pointing at the same array"
    );
  });

  test("independent handlers maintain independent swap state", () => {
    const ctxA = { tools: [...firstTurnTools] };
    const ctxB = { tools: [...firstTurnTools] };
    const handlerA = createToolReadmitHandler({
      allTools,
      context: ctxA,
    });
    const handlerB = createToolReadmitHandler({
      allTools,
      context: ctxB,
    });

    handlerA({ type: "turn_end" });

    assert.ok(ctxA.tools.some((t) => t.name === "coral_wait_for_message"));
    assert.ok(
      !ctxB.tools.some((t) => t.name === "coral_wait_for_message"),
      "handler B must not be affected by handler A's swap"
    );

    handlerB({ type: "turn_end" });
    assert.ok(ctxB.tools.some((t) => t.name === "coral_wait_for_message"));
  });
});
