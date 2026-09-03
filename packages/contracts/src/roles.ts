import { z } from "zod";

/**
 * Agents active in Phase 0-3 of DevMesh. The remaining roles (planner,
 * debugger, documenter, devops) join in Phase 11.
 */
export const INITIAL_AGENT_ROLES = [
  "architect",
  "developer",
  "tester",
  "reviewer",
] as const;

/** Roles introduced in Phase 11 (previously intent-only, now valid on the wire). */
export const PLANNED_AGENT_ROLES = [
  "planner",
  "debugger",
  "documenter",
  "devops",
] as const;

/** Canonical full set of valid agent roles. Source of truth for the schema. */
export const ALL_AGENT_ROLES = [
  ...INITIAL_AGENT_ROLES,
  ...PLANNED_AGENT_ROLES,
] as const;

export const agentRoleSchema = z.enum(ALL_AGENT_ROLES);
export type AgentRole = (typeof ALL_AGENT_ROLES)[number];

export const systemActorSchema = z.enum(["user", "system"]);
export const actorRoleSchema = z.union([agentRoleSchema, systemActorSchema]);
export type SystemActor = z.infer<typeof systemActorSchema>;
export type ActorRole = z.infer<typeof actorRoleSchema>;
