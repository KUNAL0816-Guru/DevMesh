import { z } from "zod";
import { runIdSchema } from "@devmesh/contracts";
import { summarizeRunUsage } from "@devmesh/storage";
import { McpToolError } from "../errors.js";
import type { McpToolDefinition } from "./definition.js";

export const getRunUsageTool: McpToolDefinition = {
  name: "get_run_usage",
  description:
    "Aggregate token and cost usage for a pipeline run, with a per-task breakdown. " +
    "Unknown usage values are reported as null — nothing is ever fabricated.",
  schema: z.strictObject({ runId: runIdSchema }),
  execute(args, ctx) {
    const runId = runIdSchema.parse(args.runId);
    const resolved = ctx.authorize.authorizeRun(ctx.getPrincipal(), runId);
    if (!resolved) {
      throw new McpToolError("not-found", "pipeline/not-found", "not found: no such pipeline run");
    }
    const summary = summarizeRunUsage(ctx.storage.db, runId);
    if (!summary) {
      throw new McpToolError("not-found", "pipeline/not-found", "not found: no such pipeline run");
    }
    return { usage: summary };
  },
};