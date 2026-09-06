import { z } from "zod";
import { contextNamespaceSchema, projectIdSchema } from "@devmesh/contracts";
import { McpToolError } from "../errors.js";
import type { McpToolDefinition } from "./definition.js";

export const getContextTool: McpToolDefinition = {
  name: "get_context",
  description:
    "Read the latest context entries for a project. Optionally filter to one namespace. " +
    "Entries are read through the project-scoped context repository only — global or " +
    "cross-project history is never queried.",
  schema: z.strictObject({
    projectId: projectIdSchema,
    namespace: contextNamespaceSchema.optional(),
  }),
  execute(args, ctx) {
    const projectId = projectIdSchema.parse(args.projectId);
    const namespace =
      args.namespace === undefined ? undefined : contextNamespaceSchema.parse(args.namespace);
    ctx.authorize.authorizeProject(ctx.getPrincipal(), projectId);
    if (!ctx.storage.projects.get(projectId)) {
      throw new McpToolError("not-found", "workspace/not-found", "not found: no such project");
    }
    const entries =
      namespace === undefined
        ? Array.from(ctx.storage.context.latestAllProject(projectId).values())
        : Array.from(ctx.storage.context.latestByKeyProject(namespace, projectId).values());
    return { context: entries };
  },
};