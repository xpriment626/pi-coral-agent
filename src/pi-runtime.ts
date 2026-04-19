import {
  runAgentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getModel, type KnownProvider } from "@mariozechner/pi-ai";

import { connectCoralMcp } from "./coral-mcp.js";
import { writeIterationArtifact } from "./debug.js";
import { readCoralEnv } from "./env.js";
import { buildSystemPrompt, buildUserTurn } from "./prompt.js";

export interface PreparedFirstTurnEnv {
  SYSTEM_PROMPT: string;
  EXTRA_SYSTEM_PROMPT: string;
}

export interface PreparedFirstTurnMcp {
  readResource: (uri: string) => Promise<string>;
  tools: AgentTool<any>[];
}

export interface PrepareFirstTurnConfig {
  mcp: PreparedFirstTurnMcp;
  env: PreparedFirstTurnEnv;
}

export interface PreparedFirstTurn {
  systemPrompt: string;
  instructionResource: string;
  stateResource: string;
  firstTurnTools: AgentTool<any>[];
}

// Fixture-1 headline finding: receive happens through the pre-loaded
// coral://state resource expanded into the system prompt, not through
// coral_wait_for_message. Attempt 1 surfaced the wait tools at iter-0 and the
// model latched on to a stale currentUnixTime, missing the seed permanently.
// The first turn therefore excludes every wait primitive.
const FIRST_TURN_TOOL_BLOCKLIST = new Set([
  "coral_wait_for_message",
  "coral_wait_for_mention",
  "coral_wait_for_agent",
]);

export async function prepareFirstTurn(
  config: PrepareFirstTurnConfig
): Promise<PreparedFirstTurn> {
  const [instructionResource, stateResource] = await Promise.all([
    config.mcp.readResource("coral://instruction"),
    config.mcp.readResource("coral://state"),
  ]);

  const systemPrompt = buildSystemPrompt({
    systemPrompt: config.env.SYSTEM_PROMPT,
    extraSystemPrompt: config.env.EXTRA_SYSTEM_PROMPT,
    instructionResource,
    stateResource,
  });

  const firstTurnTools = config.mcp.tools.filter(
    (t) => !FIRST_TURN_TOOL_BLOCKLIST.has(t.name)
  );

  return { systemPrompt, instructionResource, stateResource, firstTurnTools };
}

export interface IterationPayload {
  iteration: number;
  systemPrompt: string;
  event: unknown;
  ts: string;
}

export interface BuildIterationPayloadInput {
  iteration: number;
  /** Structural view of a pi-mono Agent; real Agent satisfies this. */
  agent: { state: { systemPrompt?: string } };
  event: unknown;
  /** Injectable clock — defaults to new Date().toISOString() */
  nowIso?: string;
}

/**
 * Build the per-turn_end debug-artifact payload. Captures the current system
 * prompt so a live run produces byte-diffable evidence against fixture-1's
 * trends-iter-0.json `systemPrompt` field. Predicate 1 is otherwise only
 * inferable from downstream behavior (tool choice + input token count).
 */
export function buildIterationPayload(
  input: BuildIterationPayloadInput
): IterationPayload {
  return {
    iteration: input.iteration,
    systemPrompt: input.agent.state.systemPrompt ?? "",
    event: input.event,
    ts: input.nowIso ?? new Date().toISOString(),
  };
}

// Matches the shape of pi-core's AgentContext where tools is an optional
// AgentTool<any>[]; the handler always writes a defined array when it runs.
export interface ToolReadmitContext {
  tools?: AgentTool<any>[];
}

export interface CreateToolReadmitHandlerInput {
  allTools: AgentTool<any>[];
  context: ToolReadmitContext;
}

/**
 * Returns a turn-event handler that re-admits the full tool list (including
 * the three coral_wait_* primitives filtered by FIRST_TURN_TOOL_BLOCKLIST)
 * into `context.tools` on the first `turn_end`. Subsequent turn_end events
 * are no-ops.
 *
 * The handler mutates the `context.tools` array IN PLACE (length reset +
 * push) rather than reassigning. This is deliberate: `runAgentLoop` begins
 * with `currentContext = { ...context, messages: [...] }`, which copies the
 * *reference* to the tools array into `currentContext.tools`. Reassigning
 * `context.tools = newArray` later updates our outer handle but leaves the
 * loop pointing at the original array — the LLM would never see the swap.
 * In-place mutation preserves reference identity so the loop's next
 * `streamAssistantResponse` picks up the full tool list at the LLM-call
 * boundary.
 *
 * Fixture-1 predicate 3 (peer atom correctly waits) requires wait tools at
 * iter-N>0. Attempt 2 achieved receive-GREEN by filtering wait tools on turn 1
 * to avoid attempt-1's stale-currentUnixTime failure mode, but left iter-N>0
 * peer-wait behavior blocked. This handler closes that gap without
 * re-introducing the first-turn failure mode.
 */
export function createToolReadmitHandler(
  input: CreateToolReadmitHandlerInput
): (event: { type: string }) => void {
  let swapped = false;
  return (event) => {
    if (event.type !== "turn_end") return;
    if (swapped) return;
    const tools = input.context.tools;
    if (tools) {
      tools.length = 0;
      tools.push(...input.allTools);
    } else {
      input.context.tools = [...input.allTools];
    }
    swapped = true;
  };
}

export interface RunAtomConfig {
  atomName: string;
  localTools: AgentTool<any>[];
  /** Additional secret values to redact from debug artifacts. */
  secretsFromEnv?: string[];
}

/**
 * End-to-end atom runtime on pi-mono:
 *   1. reads Coral env
 *   2. connects to Coral MCP (streamable HTTP)
 *   3. pre-loads coral://instruction + coral://state into the system prompt
 *      via prepareFirstTurn (fixture-1 predicate 1 + 1.b)
 *   4. builds an AgentContext with first-turn tools (wait tools filtered) and
 *      drives `runAgentLoop` directly so we own the context across turns.
 *   5. on the first `turn_end`, swaps `context.tools` back to the full tool
 *      list via `createToolReadmitHandler` — from turn 2 onward the LLM sees
 *      coral_wait_for_message / _mention / _agent alongside everything else.
 *   6. writes per-turn_end debug artifacts via writeIterationArtifact.
 *
 * Using `runAgentLoop` rather than the `Agent` class is deliberate: `Agent`
 * snapshots `state.tools` once at `prompt()` time (`_state.tools.slice()`), so
 * mid-run mutation via `agent.state.tools = …` cannot reach the loop. The
 * loop-level context is the only handle that produces per-turn tool changes.
 */
export async function runAtom(config: RunAtomConfig): Promise<void> {
  const env = readCoralEnv();
  const modelApiKey = process.env.MODEL_API_KEY;
  if (!modelApiKey) {
    throw new Error(
      "Missing MODEL_API_KEY — required to instantiate the pi-mono Agent. " +
        "Set via coral-agent.toml [options] or the env."
    );
  }
  const modelProvider = (process.env.MODEL_PROVIDER ??
    "openai") as KnownProvider;
  const modelId = process.env.MODEL_ID ?? "gpt-4o-mini";

  const coral = await connectCoralMcp(
    env.CORAL_CONNECTION_URL,
    env.CORAL_AGENT_ID
  );

  try {
    const allTools = [...coral.tools, ...config.localTools];

    const prepared = await prepareFirstTurn({
      mcp: { readResource: coral.readResource, tools: allTools },
      env,
    });

    const model = getModel(modelProvider as any, modelId as any);

    const agentContext: AgentContext = {
      systemPrompt: prepared.systemPrompt,
      messages: [],
      tools: [...prepared.firstTurnTools],
    };

    const readmitHandler = createToolReadmitHandler({
      allTools,
      context: agentContext,
    });

    const secrets = [
      modelApiKey,
      env.CORAL_AGENT_SECRET,
      ...(config.secretsFromEnv ?? []),
    ].filter((s): s is string => typeof s === "string" && s.length > 0);

    let iteration = 0;
    const emit = async (ev: AgentEvent) => {
      if (ev.type !== "turn_end") return;
      iteration += 1;
      await writeIterationArtifact({
        atomName: config.atomName,
        sessionId: env.CORAL_SESSION_ID,
        iteration,
        secretsFromEnv: secrets,
        payload: buildIterationPayload({
          iteration,
          agent: { state: { systemPrompt: agentContext.systemPrompt } },
          event: {
            ...ev,
            toolNamesAvailable: (agentContext.tools ?? []).map((t) => t.name),
          },
        }),
      });
      readmitHandler(ev);
    };

    const initialUserTurn = buildUserTurn({
      iteration: 0,
      extraInitialUserPrompt: env.EXTRA_INITIAL_USER_PROMPT,
      followupUserPrompt: env.FOLLOWUP_USER_PROMPT,
    });

    const loopConfig: AgentLoopConfig = {
      model,
      convertToLlm: (messages) => messages as any,
      getApiKey: async () => modelApiKey,
    };

    await runAgentLoop(
      [
        {
          role: "user",
          content: [{ type: "text", text: initialUserTurn }],
          timestamp: Date.now(),
        },
      ],
      agentContext,
      loopConfig,
      emit
    );
  } finally {
    await coral.close();
  }
}
