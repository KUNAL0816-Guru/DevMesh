import { z } from "zod";
import { projectIdSchema } from "@devmesh/contracts";
import { McpToolError } from "../errors.js";
import type { McpToolDefinition } from "./definition.js";

export const listPipelinesTool: McpToolDefinition = {
  name: "list_pipelines",
  description:
    "List pipeline runs for a project, oldest first. Requires ownership of the project.",
  schema: z.strictObject({ projectId: projectIdSchema }),
  execute(args, ctx) {
    const projectId = projectIdSchema.parse(args.projectId);
    ctx.authorize.authorizeProject(ctx.getPrincipal(), projectId);
    if (!ctx.storage.projects.get(projectId)) {
      throw new McpToolError("not-found", "workspace/not-found", "not found: no such project");
    }
    return { pipelines: ctx.storage.pipelineRuns.listByProject(projectId) };
  },
};