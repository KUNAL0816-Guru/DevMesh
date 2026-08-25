import { z } from "zod";
import { globPatternSchema } from "./common.js";

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
export type PermissionResource = (typeof permissionResources)[number];

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
 * Build a deny-by-default profile: everything unspecified becomes "deny"
 * except `read`, which defaults to "allow". Explicit overrides win.
 */
export function makeDenyByDefaultProfile(
  overrides: PermissionProfile = {},
): Required<Record<PermissionResource, PermissionSetting>> {
  return {
    read: overrides.read ?? "allow",
    edit: overrides.edit ?? "deny",
    bash: overrides.bash ?? "deny",
    net: overrides.net ?? "deny",
    external_directory: overrides.external_directory ?? "deny",
    webfetch: overrides.webfetch ?? "deny",
  };
}
