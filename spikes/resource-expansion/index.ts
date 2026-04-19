import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main(): Promise<void> {
  const connectionUrl = process.env.CORAL_CONNECTION_URL;
  const agentId = process.env.CORAL_AGENT_ID ?? "resource-expansion-spike";
  const sessionId = process.env.CORAL_SESSION_ID ?? "nosession";
  const systemPrompt = process.env.SYSTEM_PROMPT ?? "(missing)";

  if (!connectionUrl) {
    throw new Error("CORAL_CONNECTION_URL missing — must be launched by Coral Server");
  }

  const transport = new StreamableHTTPClientTransport(new URL(connectionUrl));
  const client = new Client({ name: agentId, version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  const instructionRes = await client.readResource({ uri: "coral://instruction" });
  const stateRes = await client.readResource({ uri: "coral://state" });
  const toolList = await client.listTools();

  const artifact = {
    sessionId,
    agentId,
    systemPromptFromEnv: systemPrompt,
    instructionResourceBody: (instructionRes.contents?.[0] as any)?.text ?? "(no text)",
    stateResourceBody: (stateRes.contents?.[0] as any)?.text ?? "(no text)",
    toolNames: (toolList.tools ?? []).map((t: any) => t.name),
    envCoralPromptSystem: process.env.CORAL_PROMPT_SYSTEM ?? null,
    allCoralEnvKeys: Object.keys(process.env).filter((k) => k.startsWith("CORAL_")),
    allPromptRelatedEnvKeys: Object.keys(process.env).filter((k) =>
      /^(SYSTEM_PROMPT|EXTRA_|FOLLOWUP_|CORAL_PROMPT)/.test(k)
    ),
  };

  const outPath = `.spike-artifacts/${sessionId}.json`;
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(artifact, null, 2), "utf-8");

  await new Promise((r) => setTimeout(r, 2000));
  await client.close();
}

main().catch((err) => {
  console.error("[spike] fatal:", err);
  process.exit(1);
});
