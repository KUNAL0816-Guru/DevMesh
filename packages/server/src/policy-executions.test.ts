import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { baselineProfile, makeTaskCard, newProjectId, newRunId } from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
import { GitService, WorkspaceService } from "@devmesh/workspace";
import { FakeRuntime, type AgentExecutionRequest, type FakeScript } from "@devmesh/runtime";
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

// Phase 14D tool-level baselines: patterned rules are target-scoped ONLY — they
// never gate a run (`evaluateSetting` skips them at run level) but they DO
// dispose individual tool calls, so a run starts without a START approval and
// the ask/deny is enforced on the tool invocation itself.
const DEVELOPER_READ_ONLY: ProfileProvider = (role) =>
  role === "developer" ? { read: "allow" } : baselineProfile(role);

const DEVELOPER_TOOL_ASK_BASH: ProfileProvider = (role) =>
  role === "developer"
    ? { read: "allow", bash: { action: "ask", patterns: ["**"] } }
    : baselineProfile(role);

const DEVELOPER_TOOL_DENY_BASH: ProfileProvider = (role) =>
  role === "developer"
    ? { read: "allow", bash: { action: "deny", patterns: ["**"] } }
    : baselineProfile(role);

function makeStack(
  overrides: Partial<{
    autoApprove: boolean;
    policyBaselines?: ProfileProvider;
    approvalGate?: ApprovalGate | null;
    runtimeScript?: FakeScript;
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
    return (
      overrides.runtimeScript ?? {
        steps: [],
        outcome: { status: "completed", sessionId: "ses_perm", finalText: "done" },
        stepDelayMs: 1,
      }
    );
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

async function waitForExecution(
  storage: Storage,
  executionId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = storage.executions.get(executionId);
    if (!rec || rec.status !== "running") return;
    if (Date.now() > deadline) {
      throw new Error(`execution ${executionId} still running after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function waitForApprovalCount(
  storage: Storage,
  runId: string,
  count: number,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (storage.approvals.listByRun(runId).length >= count) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`never reached ${count} approvals for run ${runId}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function approvalsOldestFirst(storage: Storage, runId: string) {
  return [...storage.approvals.listByRun(runId)].sort((a, b) =>
    a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : 0,
  );
}

describe("ExecutionService live per-tool permission (Phase 14D)", () => {
  const READ_ASK: FakeScript = {
    steps: [
      {
        toolAsks: [{ resource: "read", tool: "read", target: "src/a.ts" }],
        events: [{ kind: "text", text: "inspecting" }],
      },
    ],
    outcome: { status: "completed", sessionId: "ses_perm", finalText: "inspected" },
    stepDelayMs: 1,
  };

  const EDIT_ASK: FakeScript = {
    steps: [
      {
        toolAsks: [{ resource: "edit", tool: "edit", target: "src/a.ts" }],
        events: [{ kind: "text", text: "writing" }],
      },
    ],
    outcome: { status: "completed", sessionId: "ses_perm", finalText: "written" },
    stepDelayMs: 1,
  };

  const BASH_ASK: FakeScript = {
    steps: [
      {
        toolAsks: [{ resource: "bash", tool: "bash", target: "git status" }],
        events: [{ kind: "text", text: "running" }],
      },
    ],
    outcome: { status: "completed", sessionId: "ses_perm", finalText: "ran" },
    stepDelayMs: 5,
  };

  it("attaches onToolPermission to every request and allows the read ask under the default posture", async () => {
    const stack = makeStack({ runtimeScript: READ_ASK });
    const rec = await stack.service.start({
      projectId: stack.handle.projectId,
      instruction: "inspect",
    });
    await waitForExecution(stack.storage, rec.id);

    expect(stack.runtime.toolDecision(rec.id, "read")).toMatchObject({
      decision: "allow",
    });
    const events = [...stack.storage.events.listAfter(0)];
    expect(
      events.some((e) => e.type === "permission.resolved" && e.decision === "allow"),
    ).toBe(true);
    // An allow is answered immediately — no approval, no request event.
    expect(events.some((e) => e.type === "permission.requested")).toBe(false);
    expect(stack.storage.executions.get(rec.id)!.status).toBe("completed");
  });

  it("denies a non-read tool with no authored policy (fail closed), without failing the run", async () => {
    const stack = makeStack({ runtimeScript: EDIT_ASK, policyBaselines: DEVELOPER_READ_ONLY });
    const rec = await stack.service.start({
      projectId: stack.handle.projectId,
      instruction: "write a change",
    });
    await waitForExecution(stack.storage, rec.id);

    expect(stack.runtime.toolDecision(rec.id, "edit")).toMatchObject({ decision: "deny" });
    const events = [...stack.storage.events.listAfter(0)];
    expect(
      events.some(
        (e) => e.type === "permission.resolved" && e.decision === "deny",
      ),
    ).toBe(true);
    expect(stack.storage.executions.get(rec.id)!.status).toBe("completed");
  });

  it("bridges an ASK tool to the approval gate and allows the tool after approval", async () => {
    const stack = makeStack({
      policyBaselines: DEVELOPER_TOOL_ASK_BASH,
      runtimeScript: BASH_ASK,
    });
    const gate = stack.approvalGate!;
    const projectId = stack.handle.projectId;

    const rec = await stack.service.start({ projectId, instruction: "run a script" });

    const approvalId = await waitForApprovalGate(stack.storage, projectId);
    const approval = stack.storage.approvals.get(approvalId)!;
    expect(approval.kind).toBe("permission");
    expect(approval.title).toContain("git status");
    expect(approval.status).toBe("pending");

    const requested = [...stack.storage.events.listAfter(0)].filter(
      (e) => e.type === "permission.requested",
    );
    expect(requested.length).toBe(1);
    expect(requested[0]).toMatchObject({ tool: "bash", sessionId: rec.id });
    expect(String(requested[0]!.permissionId)).toContain("tool:");

    gate.resolve(approvalId, "allow");
    await waitForExecution(stack.storage, rec.id);

    expect(stack.runtime.toolDecision(rec.id, "bash")).toMatchObject({ decision: "allow" });
    const events = [...stack.storage.events.listAfter(0)];
    expect(
      events.some((e) => e.type === "permission.resolved" && e.decision === "allow" && e.runId === rec.runId),
    ).toBe(true);
    expect(stack.storage.executions.get(rec.id)!.status).toBe("completed");
  });

  it("denies the tool when a human denies the tool approval", async () => {
    const stack = makeStack({
      policyBaselines: DEVELOPER_TOOL_ASK_BASH,
      runtimeScript: BASH_ASK,
    });
    const gate = stack.approvalGate!;
    const projectId = stack.handle.projectId;

    const rec = await stack.service.start({ projectId, instruction: "run a script" });
    const approvalId = await waitForApprovalGate(stack.storage, projectId);
    gate.resolve(approvalId, "deny");
    await waitForExecution(stack.storage, rec.id);

    expect(stack.runtime.toolDecision(rec.id, "bash")).toMatchObject({ decision: "deny" });
    const events = [...stack.storage.events.listAfter(0)];
    expect(
      events.some((e) => e.type === "permission.resolved" && e.decision === "deny"),
    ).toBe(true);
    // A denied TOOL is not a failed run — the agent adapts and completes.
    expect(stack.storage.executions.get(rec.id)!.status).toBe("completed");
  });

  it("fails closed when an ASK tool has no configured approval gate", async () => {
    const stack = makeStack({
      policyBaselines: DEVELOPER_TOOL_ASK_BASH,
      approvalGate: null,
      runtimeScript: BASH_ASK,
    });
    const rec = await stack.service.start({
      projectId: stack.handle.projectId,
      instruction: "run a script",
    });
    await waitForExecution(stack.storage, rec.id);

    expect(stack.runtime.toolDecision(rec.id, "bash")).toMatchObject({ decision: "deny" });
    const events = [...stack.storage.events.listAfter(0)];
    expect(
      events.some((e) => e.type === "permission.resolved" && e.decision === "deny"),
    ).toBe(true);
    expect(stack.storage.executions.get(rec.id)!.status).toBe("completed");
  });

  it("fails the tool ask closed when the execution is cancelled while awaiting approval", async () => {
    const stack = makeStack({
      policyBaselines: DEVELOPER_TOOL_ASK_BASH,
      runtimeScript: BASH_ASK,
    });
    const projectId = stack.handle.projectId;

    const rec = await stack.service.start({ projectId, instruction: "run a script" });
    const approvalId = await waitForApprovalGate(stack.storage, projectId);
    expect(stack.storage.approvals.get(approvalId)!.status).toBe("pending");

    await stack.service.cancel(rec.id, "operator cancelled");
    await waitForExecution(stack.storage, rec.id);

    expect(stack.storage.executions.get(rec.id)!.status).toBe("cancelled");
    // The cancelled tool ask must fail closed: never allow, never hang.
    expect(stack.runtime.toolDecision(rec.id, "bash")).toMatchObject({ decision: "deny" });
  });

  it("never allows a tool after its request was rejected", async () => {
    const stack = makeStack({ policyBaselines: DEVELOPER_TOOL_DENY_BASH, runtimeScript: BASH_ASK });
    const rec = await stack.service.start({
      projectId: stack.handle.projectId,
      instruction: "run a script",
    });
    await waitForExecution(stack.storage, rec.id);

    expect(stack.runtime.toolDecision(rec.id, "bash")).toMatchObject({ decision: "deny" });
    // An authored deny never flips to allow at tool level regardless of target.
    expect(
      [...stack.storage.events.listAfter(0)].some(
        (e) => e.type === "permission.resolved" && e.decision === "allow",
      ),
    ).toBe(false);
  });
});

describe("Phase 14D corrective: per-request tool approval identity", () => {
  const TWO_BASH_ASKS: FakeScript = {
    steps: [
      { toolAsks: [{ resource: "bash", tool: "bash", target: "git status" }] },
      { toolAsks: [{ resource: "bash", tool: "bash", target: "git push" }] },
    ],
    outcome: { status: "completed", sessionId: "ses_two", finalText: "done" },
    stepDelayMs: 1,
  };

  const resolvedDecisions = (storage: Storage, runId: string): string[] =>
    [...storage.events.listAfter(0)]
      .filter(
        (e): e is Extract<typeof e, { type: "permission.resolved" }> =>
          e.type === "permission.resolved" && e.runId === runId,
      )
      .map((e) => e.decision as string);

  // TEST A — two successive ASKs create two INDEPENDENT approvals: deciding one
  // must never release the other.
  it("A: successive tool ASKs each mint their own approval", async () => {
    const stack = makeStack({
      policyBaselines: DEVELOPER_TOOL_ASK_BASH,
      runtimeScript: TWO_BASH_ASKS,
    });
    const gate = stack.approvalGate!;
    const projectId = stack.handle.projectId;

    const rec = await stack.service.start({ projectId, instruction: "run two scripts" });
    const firstId = await waitForApprovalGate(stack.storage, projectId);
    gate.resolve(firstId, "allow");

    await waitForApprovalCount(stack.storage, rec.runId, 2);
    const approvals = approvalsOldestFirst(stack.storage, rec.runId);
    expect(approvals).toHaveLength(2);
    expect(approvals[0]!.id).toBe(firstId);
    // The second ask is STILL PENDING — the first approval's decision did not
    // release it (the pre-fix behavior shared one approval for both asks).
    expect(approvals[1]!.status).toBe("pending");
    expect(approvals[1]!.id).not.toBe(firstId);

    gate.resolve(approvals[1]!.id, "allow");
    await waitForExecution(stack.storage, rec.id);
    expect(stack.storage.executions.get(rec.id)!.status).toBe("completed");
    const after = approvalsOldestFirst(stack.storage, rec.runId);
    expect(after[0]!.status).toBe("approved");
    expect(after[1]!.status).toBe("approved");
  });

  // TEST B — an approved run-level/START approval must NOT release a later tool
  // ASK: the tool call still needs its own human decision.
  it("B: an approved START approval never releases a tool ask", async () => {
    const stack = makeStack({
      policyBaselines: DEVELOPER_ASK_BASH,
      runtimeScript: {
        steps: [{ toolAsks: [{ resource: "bash", tool: "bash", target: "git status" }] }],
        outcome: { status: "completed", sessionId: "ses_b", finalText: "done" },
        stepDelayMs: 1,
      },
    });
    const gate = stack.approvalGate!;
    const projectId = stack.handle.projectId;
    // start() blocks until the run-level START ask is decided, so resolve it
    // through the gate between issuing the start and awaiting it.
    const started = stack.service.start({ projectId, instruction: "run a script" });
    // First approval is the run-level START ask.
    const startApprovalId = await waitForApprovalGate(stack.storage, projectId);
    expect(stack.storage.approvals.get(startApprovalId)!.title).toContain("Permission request");
    gate.resolve(startApprovalId, "allow");
    const rec = await started;

    // The tool ask then arrives and must NOT reuse the approved START approval.
    await waitForApprovalCount(stack.storage, rec.runId, 2);
    const approvals = approvalsOldestFirst(stack.storage, rec.runId);
    expect(approvals).toHaveLength(2);
    expect(approvals[1]!.id).not.toBe(startApprovalId);
    expect(approvals[1]!.title).toContain("Tool permission");
    expect(approvals[1]!.status).toBe("pending");

    gate.resolve(approvals[1]!.id, "allow");
    await waitForExecution(stack.storage, rec.id);
    expect(stack.storage.executions.get(rec.id)!.status).toBe("completed");
  });

  // TEST C — denying one tool ask does not poison the next: a fresh ask still
  // gets its own pending approval and can be approved.
  it("C: a denied tool ask does not poison the following one", async () => {
    const stack = makeStack({
      policyBaselines: DEVELOPER_TOOL_ASK_BASH,
      runtimeScript: TWO_BASH_ASKS,
    });
    const gate = stack.approvalGate!;
    const projectId = stack.handle.projectId;

    const rec = await stack.service.start({ projectId, instruction: "run two scripts" });
    const firstId = await waitForApprovalGate(stack.storage, projectId);
    gate.resolve(firstId, "deny");

    await waitForApprovalCount(stack.storage, rec.runId, 2);
    const approvals = approvalsOldestFirst(stack.storage, rec.runId);
    expect(approvals).toHaveLength(2);
    expect(approvals[1]!.status).toBe("pending");

    gate.resolve(approvals[1]!.id, "allow");
    await waitForExecution(stack.storage, rec.id);
    expect(stack.storage.executions.get(rec.id)!.status).toBe("completed");
    expect(resolvedDecisions(stack.storage, rec.runId).sort()).toEqual(["allow", "deny"]);
  });

  // TEST D — a vendor `requestId` correlates EXACTLY one approval: two distinct
  // request ids never share an approval, and a re-issued ask with the SAME id
  // reuses its own pre-existing approved approval (no duplicate row, no second
  // permission.requested event).
  it("D: requestId correlation — distinct ids stay distinct, re-issues reuse", async () => {
    const stack = makeStack({
      policyBaselines: DEVELOPER_TOOL_ASK_BASH,
      runtimeScript: {
        steps: [
          { toolAsks: [{ resource: "bash", tool: "bash", target: "a", requestId: "pe_alpha" }] },
          { toolAsks: [{ resource: "bash", tool: "bash", target: "b", requestId: "pe_beta" }] },
          // Same request id re-issued: must reuse the existing approved approval.
          {
            toolAsks: [
              { resource: "bash", tool: "bash", target: "a again", requestId: "pe_alpha" },
            ],
          },
        ],
        outcome: { status: "completed", sessionId: "ses_d", finalText: "done" },
        stepDelayMs: 1,
      },
    });
    const gate = stack.approvalGate!;
    const projectId = stack.handle.projectId;

    const rec = await stack.service.start({ projectId, instruction: "correlated asks" });
    const alphaId = await waitForApprovalGate(stack.storage, projectId);
    expect(stack.storage.approvals.get(alphaId)!.requestId).toBe("pe_alpha");
    gate.resolve(alphaId, "allow");

    await waitForApprovalCount(stack.storage, rec.runId, 2);
    const approvals = approvalsOldestFirst(stack.storage, rec.runId);
    expect(approvals).toHaveLength(2);
    expect(approvals[1]!.requestId).toBe("pe_beta");
    expect(approvals[1]!.status).toBe("pending");
    gate.resolve(approvals[1]!.id, "deny");

    // Re-issued pe_alpha resolves against its OWN (already approved) approval.
    await waitForExecution(stack.storage, rec.id);
    expect(stack.storage.executions.get(rec.id)!.status).toBe("completed");
    // Still exactly two approval rows for the run — no third approval.
    expect(stack.storage.approvals.listByRun(rec.runId)).toHaveLength(2);
    const requested = [...stack.storage.events.listAfter(0)].filter(
      (e) => e.type === "permission.requested" && e.runId === rec.runId,
    );
    // pe_alpha requested once at creation; pe_beta once. The re-issue adds none.
    expect(requested).toHaveLength(2);
    expect(resolvedDecisions(stack.storage, rec.runId).sort()).toEqual([
      "allow",
      "allow",
      "deny",
    ]);
  });
});

describe("ApprovalGate per-request identity (Phase 14D corrective)", () => {
  it("deduplicates STRICTLY by (runId, requestId) when requestId is present", () => {
    const storage = createStorage({ path: join(dataRoot, `t-${crypto.randomUUID()}.db`) });
    const gate = new ApprovalGate(storage);
    const projectId = newProjectId();
    storage.projects.insert({
      id: projectId,
      name: "gate-unit",
      rootPath: join(dataRoot, "gate-unit"),
      createdAt: new Date().toISOString(),
      ownerPrincipalId: null,
    });
    const runId = newRunId();
    const spec = {
      kind: "permission",
      title: "Tool permission: bash",
      detail: "role developer",
      risk: "high" as const,
    };

    const first = gate.request({
      projectId,
      runId,
      taskId: null,
      requestId: "pe_1",
      spec,
    });
    // Same (runId, requestId): the SAME approval is returned (resume of a
    // redelivered ask), no duplicate row.
    const redelivered = gate.request({
      projectId,
      runId,
      taskId: null,
      requestId: "pe_1",
      spec: { ...spec, title: "Tool permission: bash (redelivered)" },
    });
    expect(redelivered.id).toBe(first.id);
    expect(storage.approvals.listByRun(runId)).toHaveLength(1);

    // A DISTINCT requestId in the same run is a DIFFERENT approval.
    const second = gate.request({
      projectId,
      runId,
      taskId: null,
      requestId: "pe_2",
      spec,
    });
    expect(second.id).not.toBe(first.id);
    expect(storage.approvals.listByRun(runId)).toHaveLength(2);

    // A requestId NEVER falls back to an existing (runId, taskId) approval.
    const taskId = makeTaskCard({
      runId,
      projectId,
      role: "developer",
      title: "task t",
      detail: "d",
      acceptanceCriteria: ["ok"],
      dependsOn: [],
      status: "pending",
    }).id;
    // No requestId => legacy resume deduction: it reuses an existing run-level
// approval of the same kind rather than minting a new row.
    const bare = gate.request({ projectId, runId, taskId, spec });
    expect([first.id, second.id]).toContain(bare.id);
    expect(storage.approvals.listByRun(runId)).toHaveLength(2);
    // WITH a requestId the same (runId, taskId) can never touch that approval.
    const withReq = gate.request({ projectId, runId, taskId, requestId: "pe_task", spec });
    expect(withReq.id).not.toBe(first.id);
    expect(withReq.id).not.toBe(second.id);
    expect(withReq.requestId).toBe("pe_task");
    expect(storage.approvals.listByRun(runId)).toHaveLength(3);
    // Strict (runId, requestId) dedup holds for the request-identified rows.
    const retryPeTask = gate.request({ projectId, runId, taskId, requestId: "pe_task", spec });
    expect(retryPeTask.id).toBe(withReq.id);
    expect(storage.approvals.listByRun(runId)).toHaveLength(3);
    expect(
      storage.approvals.listByRun(runId).every((a) => a.requestId !== null),
    ).toBe(true);
  });
});

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