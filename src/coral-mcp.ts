import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type AgentToolContent = TextContent | ImageContent;

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

export function sanitizeJsonSchema(schema: any): any {
  if (schema == null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeJsonSchema);
  const out: any = { ...schema };
  if (out.type === "integer" || out.type === "number") {
    // Coerce JSON Schema draft-4 boolean exclusiveMinimum/Maximum into 2020-12
    // numeric form. zod-to-json-schema (and some upstream libs like
    // solana-agent-kit) emit `{exclusiveMinimum: true, minimum: N}` which
    // OpenAI strict mode rejects with "True is not of type 'number'".
    if (out.exclusiveMinimum === true && typeof out.minimum === "number") {
      out.exclusiveMinimum = out.minimum;
      delete out.minimum;
    } else if (out.exclusiveMinimum === false) {
      delete out.exclusiveMinimum;
    }
    if (out.exclusiveMaximum === true && typeof out.maximum === "number") {
      out.exclusiveMaximum = out.maximum;
      delete out.maximum;
    } else if (out.exclusiveMaximum === false) {
      delete out.exclusiveMaximum;
    }
    if (typeof out.maximum === "number" && (out.maximum > INT32_MAX || out.maximum < INT32_MIN)) {
      delete out.maximum;
    }
    if (typeof out.minimum === "number" && (out.minimum > INT32_MAX || out.minimum < INT32_MIN)) {
      delete out.minimum;
    }
  }
  for (const key of ["properties", "items", "additionalProperties", "patternProperties"]) {
    if (out[key] != null && typeof out[key] === "object") {
      if (key === "properties" || key === "patternProperties") {
        out[key] = Object.fromEntries(Object.entries(out[key]).map(([k, v]) => [k, sanitizeJsonSchema(v)]));
      } else {
        out[key] = sanitizeJsonSchema(out[key]);
      }
    }
  }
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map(sanitizeJsonSchema);
  if (Array.isArray(out.oneOf)) out.oneOf = out.oneOf.map(sanitizeJsonSchema);
  if (Array.isArray(out.allOf)) out.allOf = out.allOf.map(sanitizeJsonSchema);
  return out;
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function remapToolName(original: string, map?: Map<string, string>): string {
  if (NAME_RE.test(original)) {
    if (map && !map.has(original)) map.set(original, original);
    return original;
  }
  const remapped = original.replace(/\./g, "_");
  if (!NAME_RE.test(remapped)) {
    throw new Error(`Cannot remap tool name "${original}" to an OpenAI-safe identifier`);
  }
  if (map) map.set(remapped, original);
  return remapped;
}

export function restoreToolName(remapped: string, map: Map<string, string>): string {
  return map.get(remapped) ?? remapped;
}

export interface McpToolLike {
  name: string;
  description?: string;
  inputSchema: any;
}

export type McpCallTool = (
  originalName: string,
  args: Record<string, unknown>,
) => Promise<{ content: AgentToolContent[]; isError?: boolean }>;

export function mcpToolsToAgentTools(
  mcpTools: McpToolLike[],
  callTool: McpCallTool,
  nameMap: Map<string, string>,
): AgentTool<any>[] {
  return mcpTools.map((mt) => {
    const remapped = remapToolName(mt.name, nameMap);
    const sanitized = sanitizeJsonSchema(mt.inputSchema ?? { type: "object", properties: {} });
    const tool: AgentTool<any> = {
      name: remapped,
      label: mt.name,
      description: mt.description ?? mt.name,
      parameters: sanitized as any,
      execute: async (_toolCallId, params) => {
        const original = restoreToolName(remapped, nameMap);
        const res = await callTool(original, params as Record<string, unknown>);
        return { content: res.content, details: undefined };
      },
    };
    return tool;
  });
}

export interface CoralMcpClient {
  tools: AgentTool<any>[];
  nameMap: Map<string, string>;
  callTool: McpCallTool;
  readResource: (uri: string) => Promise<string>;
  close: () => Promise<void>;
}

export async function connectCoralMcp(connectionUrl: string, agentId: string): Promise<CoralMcpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(connectionUrl));
  const client = new Client({ name: agentId, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);

  const listed = await client.listTools();
  const nameMap = new Map<string, string>();
  const callTool: McpCallTool = async (originalName, args) => {
    const res = await client.callTool({ name: originalName, arguments: args });
    const raw = (res.content ?? []) as Array<Record<string, unknown>>;
    const content: AgentToolContent[] = raw.map((item) => {
      if (item.type === "text" && typeof item.text === "string") {
        return { type: "text", text: item.text };
      }
      if (
        item.type === "image" &&
        typeof item.data === "string" &&
        typeof item.mimeType === "string"
      ) {
        return { type: "image", data: item.data, mimeType: item.mimeType };
      }
      // Unknown MCP content kind (resource, audio, etc.) — fall back to a
      // text representation so the LLM at least sees something instead of
      // dropping the chunk entirely.
      return { type: "text", text: JSON.stringify(item) };
    });
    return {
      content,
      isError: (res as any).isError,
    };
  };
  const tools = mcpToolsToAgentTools(listed.tools as McpToolLike[], callTool, nameMap);
  const readResource = async (uri: string): Promise<string> => {
    const res = await client.readResource({ uri });
    const first = res.contents?.[0];
    if (!first) throw new Error(`resource ${uri} returned no contents`);
    if ("text" in first && typeof first.text === "string") return first.text;
    throw new Error(`resource ${uri} returned non-text contents`);
  };

  return {
    tools,
    nameMap,
    callTool,
    readResource,
    close: async () => {
      await client.close();
    },
  };
}
