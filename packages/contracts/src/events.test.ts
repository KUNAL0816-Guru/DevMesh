import { describe, expect, it } from "vitest";
import { domainEventSchema, parseEvent, type DomainEventInput } from "./events.js";
import { newApprovalId, newProjectId, newRunId } from "./ids.js";
import { makeTaskCard } from "./tasks.js";

const base = {
  seq: 0,
  ts: new Date().toISOString(),
  runId: newRunId(),
};

describe("domainEventSchema", () => {
  it("accepts run.started", () => {
    const evt = parseEvent({ ...base, type: "run.started", goal: "build a todo CLI" });
    expect(evt.type).toBe("run.started");
    if (evt.type === "run.started") expect(evt.goal).toContain("todo");
  });

  it("accepts task.created with a full card", () => {
    const card = makeTaskCard({
      runId: newRunId(),
      projectId: newProjectId(),
      role: "tester",
      title: "Run integration tests",
      detail: "npm test",
      acceptanceCriteria: ["all green"],
      dependsOn: [],
      status: "pending",
    });
    const input = { ...base, type: "task.created", card } satisfies DomainEventInput;
    expect(parseEvent(input).type).toBe("task.created");
  });

  it("enforces legal transitions inside task.transitioned", () => {
    expect(
      domainEventSchema.safeParse({
        ...base,
        type: "task.transitioned",
        taskId: crypto.randomUUID(),
        from: "pending",
        to: "ready",
      }).success,
    ).toBe(true);
    expect(
      domainEventSchema.safeParse({
        ...base,
        type: "task.transitioned",
        taskId: crypto.randomUUID(),
        from: "done",
        to: "running",
      }).success,
    ).toBe(false);
  });

  it("accepts approval round-trip events", () => {
    const id = newApprovalId();
    expect(
      parseEvent({
        ...base,
        type: "approval.requested",
        approvalId: id,
        title: "Allow git push?",
        risk: "high",
      }).type,
    ).toBe("approval.requested");
    expect(
      parseEvent({
        ...base,
        type: "approval.resolved",
        approvalId: id,
        decision: "deny",
        decidedBy: "user",
      }).type,
    ).toBe("approval.resolved");
  });

  it("rejects unknown event types and negative sequence numbers", () => {
    expect(domainEventSchema.safeParse({ ...base, type: "agent.dance", v: 1 }).success).toBe(false);
    expect(
      domainEventSchema.safeParse({ ...base, type: "run.completed", seq: -1 }).success,
    ).toBe(false);
  });
});
