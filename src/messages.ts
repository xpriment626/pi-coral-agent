import { z } from "zod";

export const AtomRequestSchema = z.object({
  kind: z.literal("atom_request"),
  task_id: z.string(),
  from: z.string(),
  to: z.string(),
  capability: z.string(),
  input: z.record(z.unknown()).default({}),
});
export type AtomRequest = z.infer<typeof AtomRequestSchema>;

export const AtomResultSchema = z.object({
  kind: z.literal("atom_result"),
  task_id: z.string(),
  agent: z.string(),
  status: z.enum(["success", "partial", "error"]),
  result: z.record(z.unknown()).default({}),
  handoffs: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
});
export type AtomResult = z.infer<typeof AtomResultSchema>;

export type AtomMessagePayload = AtomRequest | AtomResult;

export function atomRequest(
  partial: Omit<AtomRequest, "kind">
): AtomRequest {
  return AtomRequestSchema.parse({ kind: "atom_request", ...partial });
}

export function atomResult(partial: Omit<AtomResult, "kind">): AtomResult {
  return AtomResultSchema.parse({ kind: "atom_result", ...partial });
}

