import { z } from "zod";
import { globPatternSchema } from "./common.js";
import type { AgentRole } from "./roles.js";

export const permissionActions = ["allow", "ask", "deny"] as const;
export const permissionActionSchema = z.enum(permissionActions);
export type PermissionAction = z.infer<typeof permissionActionSchema>;

export const permissionResources = [
  "read",
  "edit",
  "bash",
  "net",
  "external_directory",
  "webfetch",
] as const;
export const permissionResourceSchema = z.enum(permissionResources);
export type PermissionResource = (typeof permissionResources)[number];

/**
 * A resolved policy decision for one resource. This is the canonical,
 * wire-validated shape the "permission.requested"/"permission.resolved"
 * events describe; `reason` always explains why the decision was made.
 */
export const policyDecisionSchema = z.object({
  action: permissionActionSchema,
  resource: permissionResourceSchema,
  reason: z.string().min(1).max(512),
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

/**
 * Everything a policy evaluator needs to decide a permission for a single
 * context. `target` is the concrete glob target being authorized (repository
 * path, command line, URL): when present, pattern-scoped settings are applied
 * to it. The remaining fields identify the request for event emission.
 */
export interface PermissionRequestContext {
  role: AgentRole;
  resource: PermissionResource;
  target?: string;
  principalId?: string;
  projectId?: string;
  runId?: string;
  taskId?: string;
}

export const permissionRuleSchema = z.object({
  action: permissionActionSchema,
  /** Optional glob patterns the action applies to (e.g. bash command globs). */
  patterns: z.array(globPatternSchema).min(1).max(64).optional(),
});
export type PermissionRule = z.infer<typeof permissionRuleSchema>;

/** Shorthand action or a pattern-scoped rule. */
export const permissionSettingSchema = z.union([
  permissionActionSchema,
  permissionRuleSchema,
]);
export type PermissionSetting = z.infer<typeof permissionSettingSchema>;

export const permissionProfileSchema = z.object({
  read: permissionSettingSchema.optional(),
  edit: permissionSettingSchema.optional(),
  bash: permissionSettingSchema.optional(),
  net: permissionSettingSchema.optional(),
  external_directory: permissionSettingSchema.optional(),
  webfetch: permissionSettingSchema.optional(),
});
export type PermissionProfile = z.infer<typeof permissionProfileSchema>;

/**
 * Build a deny-by-default profile POSTURE. Only the `read` posture is
 * explicitly represented ("allow": the workspace is inspectable). Non-read
 * resources carry NO explicit posture entry — their run-level disposition is
 * derived from absence (non-blocking; enforced at the target layer in Phase
 * 14D). This matters for policy authoring: an explicitly authored non-read
 * shorthand "deny" is therefore structurally distinguishable from a derived
 * default and is evaluated as a real DENY. Explicit overrides win.
 */
export function makeDenyByDefaultProfile(
  overrides: PermissionProfile = {},
): PermissionProfile {
  const { read, edit, bash, net, external_directory, webfetch } = overrides;
  return {
    read: read ?? "allow",
    ...(edit !== undefined ? { edit } : {}),
    ...(bash !== undefined ? { bash } : {}),
    ...(net !== undefined ? { net } : {}),
    ...(external_directory !== undefined ? { external_directory } : {}),
    ...(webfetch !== undefined ? { webfetch } : {}),
  };
}
