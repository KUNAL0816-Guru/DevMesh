import type { McpToolDefinition } from "./definition.js";

export const listProjectsTool: McpToolDefinition = {
  name: "list_projects",
  description:
    "List projects the authenticated principal owns (all projects in single-user mode). " +
    "Returns metadata only (id, name, createdAt) — workspace paths, plugin tokens, and " +
    "owner identities are never exposed.",
  schema: null,
  execute(_args, ctx) {
    const principal = ctx.getPrincipal();
    const projects = principal
      ? ctx.storage.projects.listByOwner(principal.id)
      : ctx.storage.projects.list();
    return {
      projects: projects.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt })),
    };
  },
};