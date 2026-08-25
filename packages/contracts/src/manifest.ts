import { z } from "zod";
import { relPathSchema } from "./common.js";
import { agentRoleSchema, type AgentRole } from "./roles.js";
import {
  makeDenyByDefaultProfile,
  permissionProfileSchema,
  type PermissionProfile,
} from "./permissions.js";

export const capabilities = ["read", "edit", "bash", "net"] as const;
export const capabilitySchema = z.enum(capabilities);
export type Capability = (typeof capabilities)[number];

export const modelRefSchema = z
  .string()
  .regex(
    /^[a-z0-9_-]+\/[a-z0-9._-]+$/i,
    "expected provider/model-id (e.g. anthropic/claude-sonnet-4)",
  );

/**
 * Runtime-neutral agent definition. The runtime adapter compiles this into
 * whatever the target runtime understands (e.g. OpenCode markdown agents).
 */
export const agentManifestSchema = z.strictObject({
  role: agentRoleSchema,
  displayName: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  /** Workspace-relative path to the system prompt file. */
  systemPromptFile: relPathSchema,
  defaultModel: modelRefSchema.optional(),
  temperature: z.number().min(0).max(2).optional(),
  steps: z.number().int().min(1).max(200).optional(),
  capabilities: z.array(capabilitySchema).min(1),
  permissions: permissionProfileSchema,
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

/** Sensible baseline profiles for the four initial roles. */
export function baselineProfile(role: AgentRole): PermissionProfile {
  switch (role) {
    case "architect":
      return {};
    case "developer":
      return makeDenyByDefaultProfile({
        edit: "allow",
        bash: { action: "ask", patterns: ["git *", "npm test*", "npm run test*"] },
      });
    case "tester":
      return makeDenyByDefaultProfile({ bash: "allow" });
    case "reviewer":
      return {};
  }
}
