import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface WriteArtifactInput {
  atomName: string;
  sessionId: string;
  iteration: number;
  payload: unknown;
  secretsFromEnv?: string[];
  rootDir?: string;
}

export async function writeIterationArtifact(
  input: WriteArtifactInput
): Promise<string> {
  const root = input.rootDir ?? ".coral-debug";
  const outPath = join(
    root,
    input.atomName,
    input.sessionId,
    `${input.iteration}.json`
  );
  await mkdir(dirname(outPath), { recursive: true });
  const redacted = redactSecrets(input.payload, input.secretsFromEnv ?? []);
  await writeFile(outPath, JSON.stringify(redacted, null, 2), "utf-8");
  return outPath;
}

const SECRET_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9\-_]{16,}$/, // OpenAI / generic sk- prefixed keys
];

export function redactSecrets<T>(value: T, secretsFromEnv: string[]): T {
  const secrets = new Set(secretsFromEnv.filter((s) => s && s.length > 0));
  return walk(value, secrets) as T;
}

function walk(value: unknown, secrets: Set<string>): unknown {
  if (typeof value === "string") {
    if (secrets.has(value)) return "[redacted]";
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) return "[redacted]";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, secrets));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, secrets);
    }
    return out;
  }
  return value;
}
