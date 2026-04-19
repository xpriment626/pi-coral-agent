export interface CoralEnv {
  CORAL_CONNECTION_URL: string;
  CORAL_AGENT_ID: string;
  CORAL_AGENT_SECRET: string;
  CORAL_SESSION_ID: string;
  CORAL_API_URL: string;
  CORAL_RUNTIME_ID: string;
  CORAL_PROMPT_SYSTEM?: string;

  // Prompt-surface options (Koog-parity). See the atom coral-agent.toml
  // [options] block for how these reach the process.
  SYSTEM_PROMPT: string;
  EXTRA_SYSTEM_PROMPT: string;
  EXTRA_INITIAL_USER_PROMPT: string;
  FOLLOWUP_USER_PROMPT: string;
}

const REQUIRED: Array<keyof CoralEnv> = [
  "CORAL_CONNECTION_URL",
  "CORAL_AGENT_ID",
  "CORAL_AGENT_SECRET",
  "CORAL_SESSION_ID",
  "CORAL_API_URL",
  "CORAL_RUNTIME_ID",
];

const KOOG_DEFAULT_FOLLOWUP =
  "[automated message] Continue fulfilling your responsibilities collaboratively to the best of your ability.";

export function readCoralEnv(): CoralEnv {
  const missing: string[] = [];
  const values: Partial<CoralEnv> = {};

  for (const key of REQUIRED) {
    const v = process.env[key];
    if (!v) {
      missing.push(key);
    } else {
      (values as Record<string, string>)[key] = v;
    }
  }

  const systemPrompt = process.env.SYSTEM_PROMPT;
  if (!systemPrompt) {
    missing.push("SYSTEM_PROMPT");
  } else {
    values.SYSTEM_PROMPT = systemPrompt;
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required Coral runtime environment variables: ${missing.join(", ")}. ` +
        `These are injected by Coral Server when it launches the executable runtime; ` +
        `set them explicitly when running the atom outside Coral.`
    );
  }

  const optional = process.env.CORAL_PROMPT_SYSTEM;
  if (optional !== undefined) {
    values.CORAL_PROMPT_SYSTEM = optional;
  }

  values.EXTRA_SYSTEM_PROMPT = process.env.EXTRA_SYSTEM_PROMPT ?? "";
  values.EXTRA_INITIAL_USER_PROMPT = process.env.EXTRA_INITIAL_USER_PROMPT ?? "";
  values.FOLLOWUP_USER_PROMPT =
    process.env.FOLLOWUP_USER_PROMPT ?? KOOG_DEFAULT_FOLLOWUP;

  return values as CoralEnv;
}
