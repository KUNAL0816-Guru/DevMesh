import { z } from "zod";
import { projectIdSchema, runIdSchema } from "@devmesh/contracts";
import { McpToolError } from "../errors.js";
import type { McpToolDefinition } from "./definition.js";

export const getPipelineTool: McpToolDefinition = {
  name: "get_pipeline",
  description:
    "Fetch a single pipeline run by id. The run's persisted project is authoritative for " +
    "authorization; an optional caller-supplied projectId is rejected when it disagrees.",
  schema: z.strictObject({
    runId: runIdSchema,
    projectId: projectIdSchema.optional(),
  }),
  execute(args, ctx) {
    const runId = runIdSchema.parse(args.runId);
    const projectId = args.projectId === undefined ? undefined : projectIdSchema.parse(args.projectId);
    const resolved = ctx.authorize.authorizeRun(ctx.getPrincipal(), runId);
    if (!resolved) {
      throw new McpToolError("not-found", "pipeline/not-found", "not found: no such pipeline run");
    }
    if (projectId !== undefined && projectId !== resolved.projectId) {
      throw new McpToolError(
        "invalid",
        "request/invalid",
        "invalid request: projectId does not match the run's project",
      );
    }
    return { pipeline: resolved.run };
  },
};