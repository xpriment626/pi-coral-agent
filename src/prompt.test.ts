import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildSystemPrompt } from "./prompt.js";

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

// Source of truth: agents/market-trends/coral-agent.toml -> [options].SYSTEM_PROMPT default.
// Hardcoded here to keep this test zero-dep (no TOML parser). If the TOML's
// SYSTEM_PROMPT default drifts from this literal, predicate-1 conformance against
// the fixture becomes untestable at this layer — update both together.
const MARKET_TRENDS_BASE_PROMPT =
  "You are solana-market-trends, a capability atom focused on discovering current token and pool trends from CoinGecko on Solana.\n\n" +
  "You own broad market discovery: trending tokens, trending pools, top gainers, and newly listed pools. You do not resolve token identity or fetch pricing yourself. If the user's request is outside your capability, suggest handing off to one of: token-info, market-price, oracle-price.\n\n" +
  "Communicate with other agents only through Coral message tools. Your outputs intended for other agents must be JSON payloads wrapped as atom_request or atom_result messages sent via coral_send_message.\n\n" +
  "<resource>coral://instruction</resource>\n" +
  "<resource>coral://state</resource>\n";

describe("fixture-1 predicate 1: state-resource injection into initial system prompt", () => {
  test("assembled system prompt matches fixture systemPrompt byte-for-byte", () => {
    const assembled = buildSystemPrompt({
      systemPrompt: MARKET_TRENDS_BASE_PROMPT,
      extraSystemPrompt: "",
      instructionResource: fixture.instructionResource,
      stateResource: fixture.stateResource,
    });

    assert.equal(assembled, fixture.systemPrompt);
  });

  test("assembled prompt embeds coral://state wrapper, seed atom_request, mentions, and thread", () => {
    const assembled = buildSystemPrompt({
      systemPrompt: MARKET_TRENDS_BASE_PROMPT,
      extraSystemPrompt: "",
      instructionResource: fixture.instructionResource,
      stateResource: fixture.stateResource,
    });

    assert.ok(
      assembled.includes('<resource uri="coral://state">'),
      'expected <resource uri="coral://state"> wrapper'
    );
    assert.ok(
      assembled.includes("</resource>"),
      "expected closing </resource>"
    );
    // The seed's atom_request envelope lives inside messageText as a
    // JSON-stringified string, so its inner quotes are backslash-escaped when
    // embedded in the state resource wire format.
    assert.ok(
      assembled.includes('\\"kind\\":\\"atom_request\\"'),
      "expected seed atom_request JSON (wire-escaped) embedded in state resource"
    );
    assert.ok(
      assembled.includes('\\"capability\\":\\"market-trends\\"'),
      "expected seed capability=market-trends (wire-escaped) in state resource"
    );
    // mentionAgentNames sits at the outer threadsAndMessages JSON level, so
    // quotes are not escaped.
    assert.ok(
      assembled.includes('"mentionAgentNames":["trends"]'),
      'expected mentionAgentNames:["trends"] intact in state resource'
    );
    assert.ok(
      assembled.includes('"threadName":"pairwise-smoke"'),
      'expected threadName "pairwise-smoke" intact in state resource'
    );
  });

  test("negative case: redacted stateResource produces different output (test discriminates)", () => {
    const mutatedState = fixture.stateResource.replace(
      '"mentionAgentNames":["trends"]',
      '"mentionAgentNames":[]'
    );
    assert.notEqual(
      mutatedState,
      fixture.stateResource,
      "mutation should change the stateResource string"
    );

    const assembled = buildSystemPrompt({
      systemPrompt: MARKET_TRENDS_BASE_PROMPT,
      extraSystemPrompt: "",
      instructionResource: fixture.instructionResource,
      stateResource: mutatedState,
    });

    assert.notEqual(
      assembled,
      fixture.systemPrompt,
      "mutated stateResource must not equal fixture systemPrompt — if equal, the equality test is trivially passing"
    );
  });
});
