import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  makeTaskCard,
  taskCardSchema,
  TASK_TRANSITIONS,
} from "./tasks.js";
import { newProjectId, newRunId } from "./ids.js";

describe("task transitions", () => {
  it("allow the happy path", () => {
    expect(canTransition("pending", "ready")).toBe(true);
    expect(canTransition("ready", "running")).toBe(true);
    expect(canTransition("running", "in_review")).toBe(true);
    expect(canTransition("in_review", "done")).toBe(true);
  });

  it("allow the revision loop and failure recovery", () => {
    expect(canTransition("in_review", "revising")).toBe(true);
    expect(canTransition("revising", "running")).toBe(true);
    expect(canTransition("failed", "ready")).toBe(true);
    expect(canTransition("blocked", "ready")).toBe(true);
    expect(canTransition("running", "failed")).toBe(true);
  });

  it("treat done and cancelled as terminal", () => {
    for (const to of Object.keys(TASK_TRANSITIONS)) {
      expect(canTransition("done", to as never)).toBe(false);
      expect(canTransition("cancelled", to as never)).toBe(false);
    }
  });

  it("reject skipping states", () => {
    expect(canTransition("pending", "running")).toBe(false);
    expect(canTransition("pending", "done")).toBe(false);
    expect(canTransition("ready", "done")).toBe(false);
  });

  it("assertTransition throws a typed error on illegal moves", () => {
    expect(() => assertTransition("pending", "done")).toThrow(IllegalTransitionError);
  });
});

describe("taskCardSchema / makeTaskCard", () => {
  const base = () => ({
    runId: newRunId(),
    projectId: newProjectId(),
    role: "developer" as const,
    title: "Implement login endpoint",
    detail: "POST /login with rate limiting",
    acceptanceCriteria: ["endpoint returns 200", "rate limit kicks in"],
    dependsOn: [],
    status: "pending" as const,
  });

  it("fills defaults via makeTaskCard", () => {
    const card = makeTaskCard(base());
    expect(card.attempts).toBe(0);
    expect(card.maxAttempts).toBe(3);
    expect(card.artifacts).toEqual([]);
    expect(card.createdAt).toBe(card.updatedAt);
    expect(card.id).toBeTruthy();
  });

  it("rejects empty acceptance criteria and bad roles", () => {
    expect(
      taskCardSchema.safeParse({ ...base(), acceptanceCriteria: [] }).success,
    ).toBe(false);
    expect(taskCardSchema.safeParse({ ...base(), role: "planner" }).success).toBe(false);
  });
});
