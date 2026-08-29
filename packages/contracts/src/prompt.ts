import { z } from "zod";
import { jsonValueSchema } from "./common.js";
import { sessionIdSchema } from "./ids.js";
import { agentRoleSchema } from "./roles.js";
import { modelRefSchema } from "./manifest.js";
import { tokenUsageSchema } from "./usage.js";

// ---------------------------------------------------------------------------
// Runtime-neutral prompt/reply types. The runtime adapter translates these
// into runtime-specific calls (e.g. OpenCode session.prompt).
// ---------------------------------------------------------------------------

const textPartSchema = z.strictObject({ type: z.literal("text"), text: z.string().min(1) });

/** JSON Schema carrier for structured outputs (validated downstream). */
const outputFormatSchema = z.strictObject({
  type: z.literal("json_schema"),
  name: z.string().min(1).max(80),
  schema: z.record(z.string(), jsonValueSchema),
  retryCount: z.number().int().min(0).max(5).optional(),
});

export const promptRequestSchema = z.strictObject({
  /** Addressed agent role; adapter maps this to the runtime's agent handle. */
  role: agentRoleSchema.optional(),
  model: modelRefSchema.optional(),
  systemAppend: z.string().max(8000).optional(),
  parts: z.array(textPartSchema).min(1).max(50),
  /** When present the runtime must return schema-validated structured data. */
  outputFormat: outputFormatSchema.optional(),
});
export type PromptRequest = z.infer<typeof promptRequestSchema>;
export type OutputFormat = z.infer<typeof outputFormatSchema>;

export const agentReplySchema = z.strictObject({
  sessionId: sessionIdSchema,
  role: agentRoleSchema,
  text: z.string(),
  /** Present when the request carried an outputFormat and it validated. */
  structured: jsonValueSchema.optional(),
  stopReason: z.enum(["completed", "aborted", "error", "timeout"]),
  usage: tokenUsageSchema.optional(),
});
export type AgentReply = z.infer<typeof agentReplySchema>;
