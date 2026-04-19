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
import { readCoralEnv, type CoralEnv } from "./env.js";
import { buildSystemPrompt, buildUserTurn } from "./prompt.js";

export interface IterationPayload {
  iteration: number;
  systemPrompt: string;
  event: unknown;
  ts: string;
}

export interface BuildIterationPayloadInput {
  iteration: number;
  agent: { state: { systemPrompt?: string } };
  event: unknown;
  nowIso?: string;
}

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

export interface RunAtomConfig {
  /** Override for env.SYSTEM_PROMPT. */
  systemPrompt?: string;
  /** Atom-specific tools merged with coral_* tools. */
  tools?: AgentTool<any>[];
  /** Extra strings to redact from debug artifacts. */
  secretsFromEnv?: string[];
}

/**
 * Tier 1 atom runtime: MCP connect, systemPrompt resolve, tools merge, pi-mono loop.
 * No tool gating, no outer loop, no state machine. Loop exits when the model stops
 * calling tools or the MCP connection drops.
 */
export async function runAtom(config: RunAtomConfig = {}): Promise<void> {
  const env = readCoralEnv();
  const modelApiKey = process.env.MODEL_API_KEY;
  if (!modelApiKey) {
    throw new Error(
      "Missing MODEL_API_KEY — set via coral-agent.toml [options] or the env."
    );
  }
  const modelProvider = (process.env.MODEL_PROVIDER ?? "openai") as KnownProvider;
  const modelId = process.env.MODEL_ID ?? "gpt-4o-mini";

  const coral = await connectCoralMcp(env.CORAL_CONNECTION_URL, env.CORAL_AGENT_ID);

  try {
    const tools: AgentTool<any>[] = [...coral.tools, ...(config.tools ?? [])];
    const systemPrompt = await resolveSystemPrompt(config.systemPrompt, env, coral.readResource);

    const agentContext: AgentContext = {
      systemPrompt,
      messages: [],
      tools,
    };

    const model = getModel(modelProvider as any, modelId as any);
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
        atomName: env.CORAL_AGENT_ID,
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

async function resolveSystemPrompt(
  override: string | undefined,
  env: CoralEnv,
  readResource: (uri: string) => Promise<string>
): Promise<string> {
  const raw = override ?? env.SYSTEM_PROMPT;
  if (!raw.includes("<resource")) {
    return raw;
  }
  // Spike 2026-04-19 (docs/spikes/resource-expansion-result.md): executable-runtime
  // agents receive SYSTEM_PROMPT verbatim with literal <resource/> tags; expansion
  // is the agent's job.
  const [instruction, state] = await Promise.all([
    readResource("coral://instruction").catch(() => ""),
    readResource("coral://state").catch(() => ""),
  ]);
  return buildSystemPrompt({
    systemPrompt: raw,
    extraSystemPrompt: env.EXTRA_SYSTEM_PROMPT,
    instructionResource: instruction,
    stateResource: state,
  });
}
