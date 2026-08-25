import { z } from "zod";

/**
 * Agents active in Phase 0-3 of DevMesh.
 * The remaining roles (planner, debugger, documenter, devops) join in later
 * phases; extending this tuple is a breaking contract change by design so all
 * downstream switches are revisited.
 */
export const INITIAL_AGENT_ROLES = [
  "architect",
  "developer",
  "tester",
  "reviewer",
] as const;

/** Reserved for later phases (not yet valid on the wire). */
export const PLANNED_AGENT_ROLES = [
  "planner",
  "debugger",
  "documenter",
  "devops",
] as const;

export const agentRoleSchema = z.enum(INITIAL_AGENT_ROLES);
export type AgentRole = (typeof INITIAL_AGENT_ROLES)[number];

export const systemActorSchema = z.enum(["user", "system"]);
export const actorRoleSchema = z.union([agentRoleSchema, systemActorSchema]);
export type SystemActor = z.infer<typeof systemActorSchema>;
export type ActorRole = z.infer<typeof actorRoleSchema>;
