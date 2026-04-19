// Entry point
export { runAtom, buildIterationPayload } from "./pi-runtime.js";
export type {
  RunAtomConfig,
  IterationPayload,
  BuildIterationPayloadInput,
} from "./pi-runtime.js";

// Env
export { readCoralEnv } from "./env.js";
export type { CoralEnv } from "./env.js";

// Prompt helpers (optional for consumers)
export { buildUserTurn, buildSystemPrompt } from "./prompt.js";
export type {
  BuildUserTurnInput,
  BuildSystemPromptInput,
} from "./prompt.js";

// MCP primitives (advanced consumers that bypass runAtom)
export {
  connectCoralMcp,
  mcpToolsToAgentTools,
  sanitizeJsonSchema,
  remapToolName,
  restoreToolName,
} from "./coral-mcp.js";
export type {
  CoralMcpClient,
  McpToolLike,
  McpCallTool,
  AgentToolContent,
} from "./coral-mcp.js";

// Debug
export { writeIterationArtifact, redactSecrets } from "./debug.js";
export type { WriteArtifactInput } from "./debug.js";
