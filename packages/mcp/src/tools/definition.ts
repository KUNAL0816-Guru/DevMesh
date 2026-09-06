import type { z } from "zod";
import type { McpToolContext } from "../context.js";

/**
 * A read-only MCP tool. `schema` is the zod input schema (re-parsed by the
 * server wrapper before the handler runs); `null` = zero-argument tool.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny | null;
  execute(args: Record<string, unknown>, ctx: McpToolContext): Promise<unknown> | unknown;
}