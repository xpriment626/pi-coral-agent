// Prompt composers for the atom runtime. Mirrors Koog's buildSystemPrompt,
// buildInitialUserMessage, and injectedWithMcpResources. Reference:
// coral-koog-agent/src/main/kotlin/.../fullexample/util/coral/CoralMCPUtils.kt

export interface BuildSystemPromptInput {
  systemPrompt: string;
  extraSystemPrompt: string;
  instructionResource: string;
  stateResource: string;
}

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  let combined = input.systemPrompt;
  if (input.extraSystemPrompt.trim().length > 0) {
    combined = `${combined}\n\n${input.extraSystemPrompt}`;
  }
  return injectResources(combined, {
    "coral://instruction": input.instructionResource,
    "coral://state": input.stateResource,
  });
}

function injectResources(
  text: string,
  resources: Record<string, string>
): string {
  let out = text;
  for (const [uri, body] of Object.entries(resources)) {
    const tag = `<resource>${uri}</resource>`;
    const replacement = `<resource uri="${uri}">\n${body}\n</resource>`;
    out = out.split(tag).join(replacement);
  }
  return out;
}

export interface BuildUserTurnInput {
  iteration: number;
  extraInitialUserPrompt: string;
  followupUserPrompt: string;
}

const INITIAL_PREAMBLE =
  "[automated message] You are an autonomous agent designed to assist users by collaborating with other agents. " +
  "Your task requires iterative execution, where you may need to revisit each tool multiple times, in a variety of configurations, " +
  "until the task is complete and you have all of the information required to send a result as a message using the Coral message tools.";

const INITIAL_NOT_USER_REMINDER =
  "Remember: I am not the user. You should not reply to me. I am the server that hosts your tools and coordinates your collaboration with other agents.";

export function buildUserTurn(input: BuildUserTurnInput): string {
  if (input.iteration > 0) {
    return input.followupUserPrompt;
  }
  const parts: string[] = [INITIAL_PREAMBLE];
  if (input.extraInitialUserPrompt.trim().length > 0) {
    parts.push("Here are some additional instructions to guide your behavior:");
    parts.push(
      `<specific instructions>\n${input.extraInitialUserPrompt}\n</specific instructions>`
    );
  }
  parts.push(INITIAL_NOT_USER_REMINDER);
  return parts.join("\n\n");
}
