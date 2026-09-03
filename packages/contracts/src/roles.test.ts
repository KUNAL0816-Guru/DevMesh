import { describe, expect, it } from "vitest";
import {
  agentRoleSchema,
  ALL_AGENT_ROLES,
  INITIAL_AGENT_ROLES,
  PLANNED_AGENT_ROLES,
  actorRoleSchema,
  type AgentRole,
} from "./roles.js";
import { artifactProducerSchema } from "./artifacts.js";
import { makeTaskCard, taskCardSchema } from "./tasks.js";
import { newProjectId, newRunId } from "./ids.js";

const ORIGINAL_ROLES: readonly AgentRole[] = [
  "architect",
  "developer",
  "tester",
  "reviewer",
];

const NEW_ROLES: readonly AgentRole[] = [
  "planner",
  "debugger",
  "documenter",
  "devops",
];

describe("agentRoleSchema", () => {
  it("accepts all 8 canonical roles", () => {
    for (const role of ALL_AGENT_ROLES) {
      expect(agentRoleSchema.safeParse(role).success).toBe(true);
    }
  });

  it("accepts the 4 original roles", () => {
    for (const role of ORIGINAL_ROLES) {
      expect(agentRoleSchema.safeParse(role).success).toBe(true);
    }
  });

  it("accepts the 4 new roles (planner, debugger, documenter, devops)", () => {
    for (const role of NEW_ROLES) {
      expect(agentRoleSchema.safeParse(role).success).toBe(true);
    }
  });

  it("rejects unknown roles", () => {
    for (const role of ["ops", "qa", "Architect", "developer ", "", "release"]) {
      expect(agentRoleSchema.safeParse(role).success).toBe(false);
    }
  });

  it("ALL_AGENT_ROLES is the union of initial and planned", () => {
    expect(ALL_AGENT_ROLES).toEqual([...INITIAL_AGENT_ROLES, ...PLANNED_AGENT_ROLES]);
    expect(ALL_AGENT_ROLES).toHaveLength(8);
  });
});

describe("downstream schemas accept new roles", () => {
  it("actorRoleSchema accepts a planner system actor/agent", () => {
    expect(actorRoleSchema.safeParse("planner").success).toBe(true);
    expect(actorRoleSchema.safeParse("system").success).toBe(true);
    expect(actorRoleSchema.safeParse("bogus").success).toBe(false);
  });

  it("artifactProducerSchema accepts a new role", () => {
    expect(artifactProducerSchema.safeParse("debugger").success).toBe(true);
    expect(artifactProducerSchema.safeParse("system").success).toBe(true);
  });

  it("taskCardSchema accepts a new role", () => {
    const card = makeTaskCard({
      runId: newRunId(),
      projectId: newProjectId(),
      role: "planner",
      title: "Plan the work",
      detail: "Produce a task DAG",
      acceptanceCriteria: ["plan produced"],
      dependsOn: [],
      status: "pending",
    });
    expect(taskCardSchema.safeParse(card).success).toBe(true);
    expect(card.role).toBe("planner");
  });
});
