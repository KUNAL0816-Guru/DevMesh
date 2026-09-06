import { z } from "zod";
import { projectIdSchema } from "@devmesh/contracts";
import { McpToolError } from "../errors.js";
import type { McpToolDefinition } from "./definition.js";

export const listApprovalsTool: McpToolDefinition = {
  name: "list_approvals",
  description:
    "List approval requests still awaiting a decision for a project, oldest first. " +
    "Read-only: resolved requests and approval mutations are out of scope for MCP.",
  schema: z.strictObject({ projectId: projectIdSchema }),
  execute(args, ctx) {
    const projectId = projectIdSchema.parse(args.projectId);
    ctx.authorize.authorizeProject(ctx.getPrincipal(), projectId);
    if (!ctx.storage.projects.get(projectId)) {
      throw new McpToolError("not-found", "workspace/not-found", "not found: no such project");
    }
    return { approvals: ctx.storage.approvals.listPending(projectId) };
  },
};