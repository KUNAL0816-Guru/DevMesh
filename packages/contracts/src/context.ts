import { z } from "zod";
import { isoTimestampSchema, jsonValueSchema } from "./common.js";
import { contextEntryIdSchema, newContextEntryId } from "./ids.js";
import { actorRoleSchema, type ActorRole } from "./roles.js";

/**
 * Namespaced blackboard entries. The context store keeps project-level facts
 * (specs, decisions, conventions, findings, reports) that agents read via
 * prompt digests or MCP tools; every write is attributable and versionable.
 */
export const contextNamespaces = [
  "spec",
  "decision",
  "convention",
  "finding",
  "report",
] as const;
export const contextNamespaceSchema = z.enum(contextNamespaces);
export type ContextNamespace = z.infer<typeof contextNamespaceSchema>;

export const contextEntrySchema = z.strictObject({
  id: contextEntryIdSchema,
  namespace: contextNamespaceSchema,
  key: z.string().min(1).max(200),
  value: jsonValueSchema,
  createdBy: actorRoleSchema,
  createdAt: isoTimestampSchema,
  /** When set, this entry supersedes an earlier entry with the same key. */
  supersedes: contextEntryIdSchema.optional(),
});
export type ContextEntry = z.infer<typeof contextEntrySchema>;

export function makeContextEntry(input: {
  namespace: ContextNamespace;
  key: string;
  value: unknown;
  createdBy: ActorRole;
  supersedes?: ReturnType<typeof contextEntryIdSchema.parse>;
}): ContextEntry {
  return contextEntrySchema.parse({
    id: newContextEntryId(),
    createdAt: new Date().toISOString(),
    ...input,
    value: input.value ?? null,
  });
}
