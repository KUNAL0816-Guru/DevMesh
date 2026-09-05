import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselineProfile, makeTaskCard, newRunId } from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
import { GitService, WorkspaceService } from "@devmesh/workspace";
import { FakeRuntime, type AgentExecutionRequest } from "@devmesh/runtime";
import { createDefaultAgentRegistry } from "@devmesh/agents";
import { ApprovalGate } from "./approvals.js";
import { ExecutionService } from "./executions/service.js";
import { PermissionError, type ProfileProvider } from "./policy.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-perm-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

const DEVELOPER_DENY_READ: ProfileProvider = (role) =>
  role === "developer" ? { read: "deny", edit: "allow" } : baselineProfile(role);

const DEVELOPER_DENY_BASH: ProfileProvider = (role) =>
  role === "developer" ? { bash: "deny", edit: "allow" } : baselineProfile(role);

const DEVELOPER_ASK_BASH: ProfileProvider = (role) =>
  role === "developer" ? { bash: "ask", edit: "allow" } : baselineProfile(role);

function makeStack(
  overrides: Partial<{
    autoApprove: boolean;
    policyBaselines?: ProfileProvider;
    approvalGate?: ApprovalGate | null;
  }> = {},
) {
  const storage = createStorage({ path: join(dataRoot, `t-${crypto.randomUUID()}.db`) });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(dataRoot, "workspaces"),
  });
  const handle = workspaces.create("perm-test");
  const autoApproveSeen = new Map<string, boolean | undefined>();
  const startCalls: string[] = [];
  const runtime = new FakeRuntime((request: AgentExecutionRequest) => {
    startCalls.push(request.executionId);
    autoApproveSeen.set(request.executionId, request.autoApprove);
    return {
      steps: [],
      outcome: { status: "completed", sessionId: "ses_perm", finalText: "done" },
      stepDelayMs: 1,
    };
  });
  const approvalGate =
    (overrides.approvalGate === null ? null : overrides.approvalGate ?? new ApprovalGate(storage));
  const service = new ExecutionService({
    storage,
    workspaces,
    git: new GitService(),
    runtime,
    agents: createDefaultAgentRegistry(),
    autoApprove: overrides.autoApprove ?? false,
    ...(overrides.policyBaselines ? { policyBaselines: overrides.policyBaselines } : {}),
    ...(approvalGate ? { approvalGate } : {}),
  });
  return { storage, workspaces, handle, service, runtime, autoApproveSeen, startCalls, approvalGate };
}

function waitForApprovalGate(storage: Storage, projectId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = (): void => {
      const list = storage.approvals.listPending(projectId);
      if (list.length >= 1) {
        resolve(list[0]!.id);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("never saw a pending policy approval"));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

describe("ExecutionService permission policy (Phase 14C)", () => {
  it("allows a start under the default baselines and applies config autoApprove", async () => {
    const stack = makeStack({ autoApprove: true });
    const rec = await stack.service.start({
      projectId: stack.handle.projectId,
      instruction: "make a change",
    });
    expect(rec.status).toBe("running");
    expect(stack.autoApproveSeen.get(rec.id)).toBe(true);

    await new Promise((r) => setTimeout(r, 30));
    const events = [...stack.storage.events.listAfter(0)];
    expect(events.some((e) => e.type === "permission.requested")).toBe(false);
    expect(events.some((e) => e.type === "permission.resolved")).toBe(false);
  });

  it("does not pass --auto under an ALLOW decision when config disables it", async () => {
    const stack = makeStack({});
    const rec = await stack.service.start({
      projectId: stack.handle.projectId,
      instruction: "make a change",
    });
    expect(stack.autoApproveSeen.get(rec.id)).toBe(false);
  });

  it("denies a start: no execution row, no runtime call, resolved(deny) event", async () => {
    const stack = makeStack({ policyBaselines: DEVELOPER_DENY_READ });
    const projectId = stack.handle.projectId;

    await expect(
      stack.service.start({ projectId, instruction: "touch the repo" }),
    ).rejects.toBeInstanceOf(PermissionError);
    await expect(
      stack.service.start({ projectId, instruction: "touch the repo" }),
    ).rejects.toMatchObject({ code: "permission/denied" });

    expect(stack.storage.executions.listByProject(projectId)).toHaveLength(0);
    expect(stack.startCalls).toHaveLength(0);

    const events = [...stack.storage.events.listAfter(0)];
    const resolved = events.filter((e) => e.type === "permission.resolved");
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    expect(resolved[0]).toMatchObject({ decision: "deny" });
    expect(resolved[0]!.runId).toBeTypeOf("string");
  });

  it("denies a start for a task card and leaves the card untouched", async () => {
    const stack = makeStack({ policyBaselines: DEVELOPER_DENY_READ });
    const card = makeTaskCard({
      runId: newRunId(),
      projectId: stack.handle.projectId,
      role: "developer",
      title: "denied task",
      detail: "write code",
      acceptanceCriteria: ["works"],
      dependsOn: [],
      status: "pending",
    });
    stack.storage.tasks.insert(card);

    await expect(
      stack.service.start({
        projectId: stack.handle.projectId,
        instruction: "write code",
        taskId: card.id,
      }),
    ).rejects.toMatchObject({ code: "permission/denied" });

    const after = stack.storage.tasks.get(card.id)!;
    expect(after.status).toBe("pending");
    expect(after.attempts).toBe(0);
    expect(stack.storage.executions.listByProject(stack.handle.projectId)).toHaveLength(0);
  });

  it("denies a start on an authored shorthand bash deny (no row, no runtime)", async () => {
    const stack = makeStack({ policyBaselines: DEVELOPER_DENY_BASH });
    const projectId = stack.handle.projectId;

    await expect(
      stack.service.start({ projectId, instruction: "run a script" }),
    ).rejects.toMatchObject({ code: "permission/denied" });

    expect(stack.storage.executions.listByProject(projectId)).toHaveLength(0);
    expect(stack.startCalls).toHaveLength(0);
  });

  it("asks for approval and proceeds with autoApprove=false on approval", async () => {
    const stack = makeStack({
      policyBaselines: DEVELOPER_ASK_BASH,
      autoApprove: true,
    });
    const gate = stack.approvalGate!;
    const projectId = stack.handle.projectId;

    const pending = stack.service.start({ projectId, instruction: "run a script" });

    const approvalId = await waitForApprovalGate(stack.storage, projectId);
    const approval = stack.storage.approvals.get(approvalId)!;
    expect(approval.kind).toBe("permission");
    expect(approval.title).toContain("bash");
    expect(approval.status).toBe("pending");

    const requested = [...stack.storage.events.listAfter(0)]
      .filter((e) => e.type === "permission.requested");
    expect(requested.length).toBe(1);
    expect(requested[0]).toMatchObject({ tool: "bash" });
    expect(String(requested[0]!.permissionId)).toContain("policy:");

    gate.resolve(approvalId, "allow");

    const rec = await pending;
    expect(rec.status).toBe("running");
    expect(stack.autoApproveSeen.get(rec.id)).toBe(false);

    const events = [...stack.storage.events.listAfter(0)];
    expect(events.some((e) => e.type === "permission.resolved" && e.decision === "allow")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "approval.resolved" && e.decision === "allow")).toBe(
      true,
    );
  });

  it("denies an ASK start when a human denies the approval", async () => {
    const stack = makeStack({ policyBaselines: DEVELOPER_ASK_BASH });
    const gate = stack.approvalGate!;
    const projectId = stack.handle.projectId;

    const pending = stack.service.start({ projectId, instruction: "run a script" });
    const approvalId = await waitForApprovalGate(stack.storage, projectId);
    gate.resolve(approvalId, "deny");

    await expect(pending).rejects.toMatchObject({ code: "approval/denied" });
    expect(stack.storage.executions.listByProject(projectId)).toHaveLength(0);
    const events = [...stack.storage.events.listAfter(0)];
    expect(events.some((e) => e.type === "permission.resolved" && e.decision === "deny")).toBe(
      true,
    );
  });

  it("fails closed when an ASK has no configured approval gate", async () => {
    const stack = makeStack({
      policyBaselines: DEVELOPER_ASK_BASH,
      approvalGate: null,
    });
    await expect(
      stack.service.start({ projectId: stack.handle.projectId, instruction: "hi" }),
    ).rejects.toMatchObject({ code: "permission/denied" });
    expect(stack.storage.executions.listByProject(stack.handle.projectId)).toHaveLength(0);
  });

  it("cancels an ASK start when the caller flips isCancelled", async () => {
    const stack = makeStack({ policyBaselines: DEVELOPER_ASK_BASH });
    const projectId = stack.handle.projectId;

    let cancelled = false;
    const pending = stack.service.start({
      projectId,
      instruction: "run a script",
      isCancelled: () => cancelled,
    });
    await waitForApprovalGate(stack.storage, projectId);
    cancelled = true;

    await expect(pending).rejects.toMatchObject({ code: "permission/cancelled" });
    expect(stack.storage.executions.listByProject(projectId)).toHaveLength(0);
  });

  it("tags permission events with the pipeline run id and execution session id", async () => {
    const stack = makeStack({ policyBaselines: DEVELOPER_ASK_BASH });
    const gate = stack.approvalGate!;
    const card = makeTaskCard({
      runId: newRunId(),
      projectId: stack.handle.projectId,
      role: "developer",
      title: "gated task",
      detail: "write code",
      acceptanceCriteria: ["works"],
      dependsOn: [],
      status: "pending",
    });
    stack.storage.tasks.insert(card);

    const pending = stack.service.start({
      projectId: stack.handle.projectId,
      instruction: "write code",
      taskId: card.id,
    });
    const approvalId = await waitForApprovalGate(stack.storage, stack.handle.projectId);
    gate.resolve(approvalId, "allow");

    const rec = await pending;
    expect(rec.taskId).toBe(card.id);

    const events = [...stack.storage.events.listAfter(0)];
    const requested = events.filter((e) => e.type === "permission.requested");
    const resolved = events.filter((e) => e.type === "permission.resolved");
    expect(requested.length).toBe(1);
    expect(requested[0]!.runId).toBe(card.runId);
    expect(requested[0]!.sessionId).toBe(rec.id);
    expect(resolved[0]!.runId).toBe(card.runId);
  });

  it("does not re-request an already-approved permission on the same task", async () => {
    const stack = makeStack({ policyBaselines: DEVELOPER_ASK_BASH });
    const gate = stack.approvalGate!;
    const card = makeTaskCard({
      runId: newRunId(),
      projectId: stack.handle.projectId,
      role: "developer",
      title: "resume task",
      detail: "write code",
      acceptanceCriteria: ["works"],
      dependsOn: [],
      status: "pending",
    });
    stack.storage.tasks.insert(card);

    const first = stack.service.start({
      projectId: stack.handle.projectId,
      instruction: "write code",
      taskId: card.id,
    });
    const approvalId = await waitForApprovalGate(stack.storage, stack.handle.projectId);
    gate.resolve(approvalId, "allow");
    const rec1 = await first;

    // Wait for the first execution to reach a terminal state so the project
    // lock (this.active) is released before the resumed start below.
    for (let i = 0; i < 100; i += 1) {
      const s = stack.storage.executions.get(rec1.id)!.status;
      if (s !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(stack.storage.executions.get(rec1.id)!.status).not.toBe("running");

    const requestedCount = (): number =>
      [...stack.storage.events.listAfter(0)].filter((e) => e.type === "permission.requested")
        .length;
    const approvalsBefore = stack.storage.approvals.listByRun(card.runId).length;
    // Exactly one permission.requested so far (from the first start).
    expect(requestedCount()).toBe(1);

    const second = stack.service.start({
      projectId: stack.handle.projectId,
      instruction: "write code",
      taskId: card.id,
      isCancelled: () => false,
    });
    await second;
    expect(stack.storage.approvals.listByRun(card.runId)).toHaveLength(approvalsBefore);
    // The resumed start reuses the already-approved approval instead of asking
    // again: no duplicate approval row and no second permission.requested.
    expect(requestedCount()).toBe(1);
  });
});