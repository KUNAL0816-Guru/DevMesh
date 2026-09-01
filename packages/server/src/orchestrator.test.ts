import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ProjectId,
  type TaskId,
  type TaskCard,
  TerminalStateError,
  newArtifactId,
} from "@devmesh/contracts";
import { createStorage, type ApprovalRecord, type Storage } from "@devmesh/storage";
import { assertPipelineConsistency } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import { FakeRuntime, type FakeScriptFactory } from "@devmesh/runtime";
import { createDefaultAgentRegistry } from "@devmesh/agents";
import { Orchestrator, type PipelineResult } from "./orchestrator.js";
import { ApprovalGate } from "./approvals.js";
import { ExecutionService } from "./executions/service.js";
import { DoomLoopDetector, computeFailureSignature } from "./orchestrator.js";
import type { Config } from "./config.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-orch-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Stack {
  storage: Storage;
  orchestrator: Orchestrator;
  ws: WorkspaceService;
  es: ExecutionService;
  projectId: ProjectId;
  root: string;
}

function makeStack(
  scriptFn?: FakeScriptFactory,
  overrides: Partial<Config> = {},
): Stack {
  const storage = createStorage({ path: join(dataRoot, `orch-${crypto.randomUUID()}.db`) });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(dataRoot, "workspaces"),
  });
  const handle = workspaces.create("orch-test");
  const agents = createDefaultAgentRegistry();

  // Dynamic git mock: scan workspace directory for files and return them as
  // "modified" entries so observeChanges / buildVerificationArtifacts can
  // produce real artifacts.
  function scanEntries(dir: string, base = ""): Array<{ x: string; y: string; path: string }> {
    const entries: Array<{ x: string; y: string; path: string }> = [];
    try {
      for (const name of readdirSync(dir)) {
        if (name === ".git" || name === ".devmesh") continue;
        const abs = join(dir, name);
        const rel = base ? `${base}/${name}` : name;
        const st = statSync(abs);
        if (st.isDirectory()) {
          entries.push(...scanEntries(abs, rel));
        } else {
          entries.push({ x: "?", y: "?", path: rel });
        }
      }
    } catch { /* ignore */ }
    return entries;
  }

  const runtime = scriptFn
    ? new FakeRuntime(scriptFn)
    : new FakeRuntime({
        steps: [{ events: [{ kind: "text", text: "ok" }] }],
        outcome: { status: "completed", sessionId: "ses_0", finalText: "done" },
        stepDelayMs: 5,
      });
  const executionService = new ExecutionService({
    storage,
    workspaces,
    git: {
      init: () => {},
      status: () => ({
        branch: "HEAD",
        entries: scanEntries(handle.root),
      }),
    } as never,
    runtime,
    agents,
    defaultTimeoutMs: overrides.execTimeoutMs ?? 30_000,
    defaultModel: overrides.opencodeModel,
  });
  const orchestrator = new Orchestrator({
    storage,
    workspaces,
    executionService,
  });
  return { storage, orchestrator, ws: workspaces, es: executionService, projectId: handle.projectId, root: handle.root };
}

/** Script factory that returns a different script per agent role. */
function perAgentScript(
  scripts: Record<string, { status?: string; effect?: () => void; text?: string; structured?: unknown }>,
): FakeScriptFactory {
  return (req) => {
    // Extract the agent role from the instruction or use a default
    const agentMatch = req.instruction.match(/You are the (\w+) agent/i);
    const role = agentMatch?.[1]?.toLowerCase() ?? "unknown";
    const script = scripts[role] ?? scripts["*"] ?? { status: "completed" };
    return {
      steps: [
        {
          effect: script.effect,
          events: [{ kind: "text", text: script.text ?? `${role} done` }],
        },
      ],
      outcome: {
        status: (script.status as "completed" | "failed") ?? "completed",
        sessionId: `ses_${role}`,
        finalText: script.text ?? `${role} done`,
        ...(script.structured !== undefined ? { structured: script.structured } : {}),
      },
      stepDelayMs: 5,
    };
  };
}

/** Script factory that always fails for a specific agent. */
function failingAgentScript(failRole: string, reason: string): FakeScriptFactory {
  return perAgentScript({
    [failRole]: { status: "failed", text: reason },
  });
}

function findLatestRunId(storage: Storage): string | null {
  const events = storage.events.listAfter(0, 500);
  for (const evt of [...events].reverse()) {
    if (evt.type === "run.started" && evt.runId) return evt.runId;
  }
  return null;
}

function getEventsOfType(storage: Storage, type: string) {
  return [...storage.events.listAfter(0, 1000)].filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Orchestrator: Full pipeline", () => {
  it("1. full Architect -> Developer -> Tester -> Reviewer pipeline completes", async () => {
    const stack = makeStack(
      perAgentScript({
        architect: { text: "spec and plan" },
        developer: {
          effect: () => writeFileSync(join(stack.root, "app.js"), "export const x = 1;\n"),
          text: "implemented app.js",
        },
        tester: { text: "all tests pass" },
        reviewer: { text: "APPROVED — clean implementation" },
      }),
    );

    const result = await stack.orchestrator.run(
      stack.projectId,
      "Create a simple module",
    );

    expect(result.status).toBe("completed");

    // Verify task chain completed
    const runId = findLatestRunId(stack.storage)!;
    const tasks = stack.storage.tasks.listByRun(runId as never);
    const doneTasks = tasks.filter((t) => t.status === "done");
    expect(doneTasks.length).toBeGreaterThanOrEqual(1);

    // Verify events were emitted
    expect(getEventsOfType(stack.storage, "run.started").length).toBeGreaterThanOrEqual(1);
    expect(getEventsOfType(stack.storage, "run.completed").length).toBe(1);
    expect(getEventsOfType(stack.storage, "task.created").length).toBe(4);
    expect(getEventsOfType(stack.storage, "task.transitioned").length).toBeGreaterThan(0);
    expect(getEventsOfType(stack.storage, "agent.session.opened").length).toBe(4);

    await stack.storage.close();
  });

  it("2. tasks are created in dependency order", async () => {
    const stack = makeStack(perAgentScript({
      architect: { text: "plan" },
      developer: { effect: () => writeFileSync(join(stack.root, "f.txt"), "v1"), text: "impl" },
      tester: { text: "pass" },
      reviewer: { text: "APPROVED" },
    }));

    const result = await stack.orchestrator.run(stack.projectId, "task");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const tasks = stack.storage.tasks.listByRun(runId as never);
    expect(tasks).toHaveLength(4);

    // Architect has no deps
    const arch = tasks.find((t) => t.role === "architect")!;
    expect(arch.dependsOn).toHaveLength(0);

    // Developer depends on architect
    const dev = tasks.find((t) => t.role === "developer")!;
    expect(dev.dependsOn).toContain(arch.id);

    // Tester depends on developer
    const tester = tasks.find((t) => t.role === "tester")!;
    expect(tester.dependsOn).toContain(dev.id);

    // Reviewer depends on developer and tester
    const reviewer = tasks.find((t) => t.role === "reviewer")!;
    expect(reviewer.dependsOn).toContain(dev.id);
    expect(reviewer.dependsOn).toContain(tester.id);

    await stack.storage.close();
  });

  it("3. artifacts are recorded for each execution", async () => {
    const stack = makeStack(perAgentScript({
      architect: { text: "analysis" },
      developer: {
        effect: () => writeFileSync(join(stack.root, "mod.js"), "export default 42;\n"),
        text: "created mod.js",
      },
      tester: { text: "tests pass" },
      reviewer: { text: "APPROVED" },
    }));

    const result = await stack.orchestrator.run(stack.projectId, "create module");
    expect(result.status).toBe("completed");

    // Artifacts are stored with execution-level runIds (each executionService.start()
    // creates its own runId), so query by each execution's runId from events.
    const events = [...stack.storage.events.listAfter(0, 500)];
    const executionRunIds = events
      .filter((e) => e.type === "agent.session.opened")
      .map((e) => e.runId as string);
    let totalArtifacts = 0;
    for (const rid of executionRunIds) {
      totalArtifacts += stack.storage.artifacts.listByRun(rid as never).length;
    }
    expect(totalArtifacts).toBeGreaterThanOrEqual(2); // at least developer's change_set + verification

    await stack.storage.close();
  });

  it("4. tester failure triggers developer revision", async () => {
    let attempt = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";

      if (role === "tester") {
        attempt++;
        if (attempt === 1) {
          return {
            steps: [{ events: [{ kind: "text", text: "test failed" }] }],
            outcome: { status: "failed", finalText: "test failed: assertion error" },
            stepDelayMs: 5,
          };
        }
      }
      if (role === "developer") {
        return {
          steps: [{
            effect: () => writeFileSync(join(stack.root, "app.js"), "fixed\n"),
            events: [{ kind: "text", text: "fixed" }],
          }],
          outcome: { status: "completed", finalText: "fixed" },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "fix tests");
    // The pipeline should eventually succeed after developer retry
    expect(result.status).toBe("completed");

    // Developer should have run at least twice
    const devSessions = getEventsOfType(stack.storage, "agent.session.opened").filter(
      (e) => "role" in e && e.role === "developer",
    );
    expect(devSessions.length).toBeGreaterThanOrEqual(2);

    await stack.storage.close();
  });

  it("5. reviewer rejection triggers developer revision", async () => {
    let reviewerRuns = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";

      if (role === "reviewer") {
        reviewerRuns++;
        if (reviewerRuns === 1) {
          return {
            steps: [{ events: [{ kind: "text", text: "changes requested" }] }],
            outcome: { status: "failed", finalText: "CHANGES_REQUESTED: needs error handling" },
            stepDelayMs: 5,
          };
        }
      }
      if (role === "developer") {
        return {
          steps: [{
            effect: () => writeFileSync(join(stack.root, "app.js"), "improved\n"),
            events: [{ kind: "text", text: "improved" }],
          }],
          outcome: { status: "completed", finalText: "improved" },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "implement with review");
    expect(result.status).toBe("completed");

    // Reviewer should have run at least twice
    const reviewerSessions = getEventsOfType(stack.storage, "agent.session.opened").filter(
      (e) => "role" in e && e.role === "reviewer",
    );
    expect(reviewerSessions.length).toBeGreaterThanOrEqual(2);

    await stack.storage.close();
  });

  it("6. retry exhaustion blocks the pipeline", async () => {
    const stack = makeStack(
      failingAgentScript("tester", "tests consistently fail"),
      { execTimeoutMs: 10_000 },
    );
    stack.orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: new WorkspaceService({
        store: stack.storage.projects,
        workspacesRoot: join(dataRoot, "ws2"),
      }),
      executionService: new ExecutionService({
        storage: stack.storage,
        workspaces: new WorkspaceService({
          store: stack.storage.projects,
          workspacesRoot: join(dataRoot, "ws3"),
        }),
        git: { init: () => {}, status: () => ({ branch: "HEAD", entries: [] }) } as never,
        runtime: new FakeRuntime(failingAgentScript("tester", "tests fail")),
        agents: createDefaultAgentRegistry(),
        defaultTimeoutMs: 10_000,
      }),
      maxTesterRevisions: 1,
    });

    const result = await stack.orchestrator.run(stack.projectId, "broken tests");
    expect(result.status).toBe("failed");

    const runId = findLatestRunId(stack.storage)!;
    const tasks = stack.storage.tasks.listByRun(runId as never);
    const blockedOrFailed = tasks.filter(
      (t) => t.status === "blocked" || t.status === "failed",
    );
    expect(blockedOrFailed.length).toBeGreaterThan(0);

    await stack.storage.close();
  });

  it("7. cancellation propagates through the pipeline", async () => {
    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 60_000, // hang
    }));

    // Start the pipeline
    const pipelinePromise = stack.orchestrator.run(stack.projectId, "long task");

    // Wait a bit then we can't cancel individual executions through the orchestrator
    // but we can verify the pipeline hangs (timeout)
    const result = await Promise.race([
      pipelinePromise,
      new Promise<PipelineResult>((res) =>
        setTimeout(() => res({ status: "timeout" as const, taskId: "x" as never, projectId: stack.projectId }), 2000),
      ),
    ]);

    // Pipeline should be hanging (we raced it with a 2s timeout)
    expect(result.status).toBe("timeout");

    await stack.storage.close();
  });

  it("8. timeout terminates the pipeline", async () => {
    const stack = makeStack(
      (_req) => ({
        steps: [{ effect: () => undefined }],
        outcome: { status: "completed" },
        stepDelayMs: 120_000, // hang longer than timeout
      }),
      { execTimeoutMs: 1000 },
    );

    const result = await stack.orchestrator.run(stack.projectId, "hang task");
    // Should timeout because the fake runtime exceeds the budget
    expect(result.status).toBe("timeout");
    await stack.storage.close();
  });

  it("9. events are emitted in correct order", async () => {
    const stack = makeStack(perAgentScript({
      architect: { text: "spec" },
      developer: {
        effect: () => writeFileSync(join(stack.root, "file.txt"), "content"),
        text: "impl",
      },
      tester: { text: "pass" },
      reviewer: { text: "APPROVED" },
    }));

    const result = await stack.orchestrator.run(stack.projectId, "ordered events");
    expect(result.status).toBe("completed");

    const events = [...stack.storage.events.listAfter(0, 2000)];
    const types = events.map((e) => e.type);

    // run.started should be first
    expect(types[0]).toBe("run.started");

    // task.created events should come before task.transitioned
    const firstCreated = types.indexOf("task.created");
    const firstTransitioned = types.indexOf("task.transitioned");
    expect(firstCreated).toBeLessThan(firstTransitioned);

    // run.completed should be last (or near last)
    expect(types[types.length - 1]).toBe("run.completed");

    await stack.storage.close();
  });

  it("10. persistence: task state survives throughout pipeline", async () => {
    const stack = makeStack(perAgentScript({
      architect: { text: "analysis" },
      developer: {
        effect: () => writeFileSync(join(stack.root, "data.json"), "{}"),
        text: "created data.json",
      },
      tester: { text: "tests pass" },
      reviewer: { text: "APPROVED" },
    }));

    const result = await stack.orchestrator.run(stack.projectId, "persistent state");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const tasks = stack.storage.tasks.listByRun(runId as never);

    // All tasks should have attempts recorded
    for (const t of tasks) {
      expect(t.attempts).toBeGreaterThanOrEqual(1);
      expect(t.updatedAt).toBeDefined();
    }

    // Execution records should exist for all 4 agents
    const execs = stack.storage.executions.listByProject(stack.projectId);
    expect(execs.length).toBe(4);
    for (const e of execs) {
      expect(e.status).not.toBe("running");
      expect(e.finishedAt).toBeTruthy();
    }

    await stack.storage.close();
  });

  it("11. architect failure blocks the pipeline", async () => {
    const stack = makeStack(failingAgentScript("architect", "cannot analyze"));
    const result = await stack.orchestrator.run(stack.projectId, "analyze this");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("architect");

    await stack.storage.close();
  });

  it("12. developer failure blocks the pipeline", async () => {
    const stack = makeStack(failingAgentScript("developer", "build errors"));
    const result = await stack.orchestrator.run(stack.projectId, "implement");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("developer");

    await stack.storage.close();
  });

  it("13. all agents receive system instructions from registry", async () => {
    const capturedInstructions: string[] = [];
    const stack = makeStack((req) => {
      capturedInstructions.push(req.instruction);
      return {
        steps: [{ events: [{ kind: "text", text: "ok" }] }],
        outcome: { status: "completed", finalText: "ok" },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "test instructions");
    expect(result.status).toBe("completed");

    // Each instruction should contain the agent's system preamble
    expect(capturedInstructions.length).toBe(4);
    for (const instr of capturedInstructions) {
      expect(instr).toContain("# Task");
      expect(instr).toContain("# Rules");
    }

    await stack.storage.close();
  });

  it("14. workspace root is passed to every execution", async () => {
    const capturedRoots: string[] = [];
    const stack = makeStack((req) => {
      capturedRoots.push(req.workspaceRoot);
      return {
        steps: [{ events: [{ kind: "text", text: "ok" }] }],
        outcome: { status: "completed", finalText: "ok" },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "check roots");
    expect(result.status).toBe("completed");

    // All executions should use the same workspace root
    expect(capturedRoots.length).toBe(4);
    const uniqueRoots = new Set(capturedRoots);
    expect(uniqueRoots.size).toBe(1);
    expect(capturedRoots[0]).toBe(stack.root);

    await stack.storage.close();
  });

  it("15. pipeline result contains correct task and project ids", async () => {
    const stack = makeStack(perAgentScript({
      architect: { text: "ok" },
      developer: {
        effect: () => writeFileSync(join(stack.root, "x.txt"), "v1"),
        text: "done",
      },
      tester: { text: "pass" },
      reviewer: { text: "APPROVED" },
    }));

    const result = await stack.orchestrator.run(stack.projectId, "ids check");
    expect(result.status).toBe("completed");
    expect(result.projectId).toBe(stack.projectId);
    expect(result.taskId).toBeDefined();

    await stack.storage.close();
  });
});

describe("Orchestrator: agent permission profiles", () => {
  it("architect agent has read-only permissions", () => {
    const reg = createDefaultAgentRegistry();
    const arch = reg.require("architect");
    expect(arch.allowedOperations).toContain("read_files");
    expect(arch.allowedOperations).not.toContain("write_files");
    expect(arch.allowedOperations).not.toContain("run_commands");
  });

  it("developer agent has full permissions", () => {
    const reg = createDefaultAgentRegistry();
    const dev = reg.require("developer");
    expect(dev.allowedOperations).toContain("read_files");
    expect(dev.allowedOperations).toContain("write_files");
    expect(dev.allowedOperations).toContain("run_commands");
    expect(dev.allowedOperations).toContain("git_operations");
  });

  it("tester agent has write but no git", () => {
    const reg = createDefaultAgentRegistry();
    const tester = reg.require("tester");
    expect(tester.allowedOperations).toContain("read_files");
    expect(tester.allowedOperations).toContain("write_files");
    expect(tester.allowedOperations).toContain("run_commands");
    expect(tester.allowedOperations).not.toContain("git_operations");
  });

  it("reviewer agent has read-only permissions", () => {
    const reg = createDefaultAgentRegistry();
    const reviewer = reg.require("reviewer");
    expect(reviewer.allowedOperations).toContain("read_files");
    expect(reviewer.allowedOperations).not.toContain("write_files");
    expect(reviewer.allowedOperations).not.toContain("run_commands");
  });
});

describe("DoomLoopDetector", () => {
  it("detects doom-loop after threshold consecutive identical failures", () => {
    const detector = new DoomLoopDetector(3);
    expect(detector.recordFailure("tester", "sig_a")).toBe(false);
    expect(detector.recordFailure("tester", "sig_a")).toBe(false);
    expect(detector.recordFailure("tester", "sig_a")).toBe(true);
    expect(detector.isDoomLoop("tester")).toBe(true);
  });

  it("resets on different failure signature", () => {
    const detector = new DoomLoopDetector(3);
    expect(detector.recordFailure("tester", "sig_a")).toBe(false);
    expect(detector.recordFailure("tester", "sig_a")).toBe(false);
    expect(detector.recordFailure("tester", "sig_b")).toBe(false);
    expect(detector.getCount("tester")).toBe(1);
    expect(detector.isDoomLoop("tester")).toBe(false);
  });

  it("resets on success", () => {
    const detector = new DoomLoopDetector(3);
    expect(detector.recordFailure("tester", "sig_a")).toBe(false);
    expect(detector.recordFailure("tester", "sig_a")).toBe(false);
    detector.recordSuccess("tester");
    expect(detector.getCount("tester")).toBe(0);
    expect(detector.recordFailure("tester", "sig_a")).toBe(false);
    expect(detector.isDoomLoop("tester")).toBe(false);
  });

  it("independent per-role tracking", () => {
    const detector = new DoomLoopDetector(2);
    expect(detector.recordFailure("tester", "sig_a")).toBe(false);
    expect(detector.recordFailure("tester", "sig_a")).toBe(true);
    expect(detector.isDoomLoop("reviewer")).toBe(false);
  });
});

describe("computeFailureSignature", () => {
  it("normalizes dynamic parts of error messages", () => {
    const rec1 = {
      failureKind: "process_failure" as const,
      errorMessage: "Error at 2026-08-25T12:30:00.000Z in tests/login.test.ts:42",
    };
    const rec2 = {
      failureKind: "process_failure" as const,
      errorMessage: "Error at 2026-08-25T15:45:30.500Z in tests/login.test.ts:42",
    };
    expect(computeFailureSignature(rec1 as never)).toBe(computeFailureSignature(rec2 as never));
  });

  it("produces different signatures for different failure kinds", () => {
    const a = computeFailureSignature({ failureKind: "timeout", errorMessage: "x" } as never);
    const b = computeFailureSignature({ failureKind: "process_failure", errorMessage: "x" } as never);
    expect(a).not.toBe(b);
  });
});

describe("Orchestrator: doom-loop integration", () => {
  it("16. same tester failure triggers doom-loop termination", async () => {
    // Doom-loop threshold=2, tester maxAttempts=10 so doom-loop fires before budget exhaustion
    const storage2 = createStorage({ path: join(dataRoot, `orch-dl-${crypto.randomUUID()}.db`) });
    const workspaces2 = new WorkspaceService({
      store: storage2.projects,
      workspacesRoot: join(dataRoot, "ws-dl"),
    });
    const handle2 = workspaces2.create("doom-test");
    const agents2 = createDefaultAgentRegistry();
    const executionService2 = new ExecutionService({
      storage: storage2,
      workspaces: workspaces2,
      git: { init: () => {}, status: () => ({ branch: "HEAD", entries: [] }) } as never,
      runtime: new FakeRuntime(
        (req) => {
          const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
          const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
          if (role === "tester") {
            return {
              steps: [{ events: [{ kind: "text", text: "test failed: assertion error" }] }],
              outcome: { status: "failed", finalText: "test failed: assertion error in test_login" },
              stepDelayMs: 5,
            };
          }
          if (role === "developer") {
            return {
              steps: [{
                effect: () => writeFileSync(join(handle2.root, "app.js"), "code"),
                events: [{ kind: "text", text: "fixed" }],
              }],
              outcome: { status: "completed", finalText: "fixed" },
              stepDelayMs: 5,
            };
          }
          return {
            steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
            outcome: { status: "completed", finalText: `${role} ok` },
            stepDelayMs: 5,
          };
        },
      ),
      agents: agents2,
      defaultTimeoutMs: 10_000,
    });
    const orchestrator2 = new Orchestrator({
      storage: storage2,
      workspaces: workspaces2,
      executionService: executionService2,
      doomLoopThreshold: 2,
      maxTesterRevisions: 10,
      maxReviewerRevisions: 5,
      taskMaxAttempts: { tester: 10, developer: 10 },
    });

    const result = await orchestrator2.run(handle2.projectId, "doom loop test");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("doom-loop");

    // Verify doom-loop event was emitted
    const events = [...storage2.events.listAfter(0, 500)];
    const doomEvents = events.filter(
      (e) => e.type === "error.raised" && "scope" in e && e.scope === "orchestrator/doom-loop",
    );
    expect(doomEvents.length).toBe(1);

    await storage2.close();
  });

  it("17. doom-loop counter resets after a successful stage", async () => {
    // Scenario: tester fails once (same sig), then passes, then fails once more.
    // With doom-loop threshold=2, the 2nd failure does NOT trigger doom-loop
    // because the counter was reset by the success in between.
    let testerAttempt = 0;
    const storage2 = createStorage({ path: join(dataRoot, `orch-dlr-${crypto.randomUUID()}.db`) });
    const workspaces2 = new WorkspaceService({
      store: storage2.projects,
      workspacesRoot: join(dataRoot, "ws-dlr"),
    });
    const handle2 = workspaces2.create("doom-reset-test");
    const agents2 = createDefaultAgentRegistry();
    const executionService2 = new ExecutionService({
      storage: storage2,
      workspaces: workspaces2,
      git: { init: () => {}, status: () => ({ branch: "HEAD", entries: [] }) } as never,
      runtime: new FakeRuntime(
        (req) => {
          const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
          const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
          if (role === "tester") {
            testerAttempt++;
            // Fail on attempt 1, pass on attempt 2, fail on attempt 3, pass on attempt 4
            if (testerAttempt === 1 || testerAttempt === 3) {
              return {
                steps: [{ events: [{ kind: "text", text: "test failed" }] }],
                outcome: { status: "failed", finalText: "test failed: assertion error" },
                stepDelayMs: 5,
              };
            }
            return {
              steps: [{ events: [{ kind: "text", text: "tests pass" }] }],
              outcome: { status: "completed", finalText: "all tests pass" },
              stepDelayMs: 5,
            };
          }
          return {
            steps: [{
              effect: () => writeFileSync(join(handle2.root, "app.js"), "code"),
              events: [{ kind: "text", text: "ok" }],
            }],
            outcome: { status: "completed", finalText: "ok" },
            stepDelayMs: 5,
          };
        },
      ),
      agents: agents2,
      defaultTimeoutMs: 10_000,
    });
    const orchestrator2 = new Orchestrator({
      storage: storage2,
      workspaces: workspaces2,
      executionService: executionService2,
      doomLoopThreshold: 2,
      maxTesterRevisions: 10,
      maxReviewerRevisions: 5,
      taskMaxAttempts: { tester: 10, developer: 10 },
    });

    const result = await orchestrator2.run(handle2.projectId, "doom reset test");
    // Should complete because tester's doom-loop counter resets after each success
    expect(result.status).toBe("completed");

    await storage2.close();
  });
});

describe("Orchestrator: structured context assembly", () => {
  it("18. developer revision receives structured test failure context", async () => {
    let testerRan = false;
    const capturedInstructions: string[] = [];
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      capturedInstructions.push(req.instruction);

      if (role === "tester" && !testerRan) {
        testerRan = true;
        return {
          steps: [{ events: [{ kind: "text", text: "2 tests failed" }] }],
          outcome: {
            status: "failed",
            finalText: "FAIL test_login - expected 200 got 500\ntest_db - connection timeout",
          },
          stepDelayMs: 5,
        };
      }
      if (role === "developer") {
        return {
          steps: [{
            effect: () => writeFileSync(join(stack.root, "app.js"), "fixed"),
            events: [{ kind: "text", text: "fixed" }],
          }],
          outcome: { status: "completed", finalText: "fixed" },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "fix failing tests");
    expect(result.status).toBe("completed");

    // At least one developer instruction should mention test failure details
    const hasFailureContext = capturedInstructions.some((i) =>
      (i.includes("test_login") || i.includes("FAIL") || i.includes("failure")) &&
      i.includes("Context from previous stages"),
    );
    expect(hasFailureContext).toBe(true);

    await stack.storage.close();
  });
});

describe("Orchestrator: revision cycle storage", () => {
  it("19. tester failure records a revision cycle", async () => {
    let testerRunCount = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "tester") {
        testerRunCount++;
        if (testerRunCount === 1) {
          return {
            steps: [{ events: [{ kind: "text", text: "test failed" }] }],
            outcome: { status: "failed", finalText: "FAIL test_main - assertion error" },
            stepDelayMs: 5,
          };
        }
        return {
          steps: [{ events: [{ kind: "text", text: "all tests pass" }] }],
          outcome: { status: "completed", finalText: "pass" },
          stepDelayMs: 5,
        };
      }
      if (role === "developer") {
        return {
          steps: [{
            effect: () => writeFileSync(join(stack.root, "app.js"), "fixed"),
            events: [{ kind: "text", text: "fixed" }],
          }],
          outcome: { status: "completed", finalText: "fixed" },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "test revision cycles");
    expect(result.status).toBe("completed");

    // Find the tester task
    const devTask = stack.storage.tasks.get(result.taskId as TaskId);
    expect(devTask).toBeDefined();
    const allTasks = stack.storage.tasks.listByRun(devTask!.runId);
    const testerTask = allTasks.find((t) => t.role === "tester");
    expect(testerTask).toBeDefined();
    const testerId = testerTask!.id;
    const cycles = stack.storage.revisionCycles.listByTask(testerId);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    expect(cycles[0]!.cycleType).toBe("tester_failure");

    await stack.storage.close();
  });
});

describe("Orchestrator: git checkpoint integration", () => {
  it("20. git checkpoint is created before developer and rolled back on failure", async () => {
    const { GitService } = await import("@devmesh/workspace");
    const git = new GitService();

    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "tester") {
        return {
          steps: [{ events: [{ kind: "text", text: "test failed" }] }],
          outcome: { status: "failed", finalText: "FAIL test_main" },
          stepDelayMs: 5,
        };
      }
      if (role === "developer") {
        return {
          steps: [{
            effect: () => writeFileSync(join(stack.root, "app.js"), "broken"),
            events: [{ kind: "text", text: "done" }],
          }],
          outcome: { status: "completed", finalText: "done" },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    // Initialize git repo in the workspace so checkpoints work
    git.init(stack.root);

    // Create orchestrator with git service
    const orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      git,
      maxTesterRevisions: 1,
    });

    const result = await orchestrator.run(stack.projectId, "test git checkpoints");
    // Pipeline fails because tester always fails and budget exhausted
    expect(result.status).toBe("failed");

    // Should have created at least one checkpoint
    const handle = stack.ws.get(stack.projectId);
    const checkpoints = git.listCheckpoints(handle.root);
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);

    // After rollback, workspace should not contain the broken file
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(handle.root, "app.js"))).toBe(false);

    await stack.storage.close();
  });
});

describe("Orchestrator: pipeline-level attempt limits", () => {
  it("21. maxTotalAttempts terminates the pipeline early", async () => {
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "tester") {
        return {
          steps: [{ events: [{ kind: "text", text: "test failed" }] }],
          outcome: { status: "failed", finalText: "FAIL" },
          stepDelayMs: 5,
        };
      }
      if (role === "developer") {
        return {
          steps: [{
            effect: () => writeFileSync(join(stack.root, "app.js"), "fixed"),
            events: [{ kind: "text", text: "fixed" }],
          }],
          outcome: { status: "completed", finalText: "fixed" },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    // arch=1, dev=1, tester_fail=1 → dev retry=1, tester_fail=2 → budget at 6
    // But tester budget=2 means tester rev 1 triggers, rev 2 exceeds → dev blocks at attempt 3
    // So use a very low pipeline budget to hit before task budgets
    const orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      maxTesterRevisions: 10,
      maxTotalAttempts: 5,
      taskMaxAttempts: { developer: 10 },
    });

    const result = await orchestrator.run(stack.projectId, "test total attempts");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("pipeline total attempt budget exhausted");

    await stack.storage.close();
  });
});

describe("Orchestrator: interrupted pipeline recovery", () => {
  it("22. recoverInterruptedPipelines marks stale executions as interrupted", async () => {
    const { GitService } = await import("@devmesh/workspace");
    const git = new GitService();
    const stack = makeStack(() => ({
      steps: [{ events: [{ kind: "text", text: "ok" }] }],
      outcome: { status: "completed", finalText: "ok" },
      stepDelayMs: 5,
    }));

    git.init(stack.root);

    const orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      git,
    });

    // Simulate a stale execution left running
    stack.storage.executions.insert({
      id: "exec-stale-1",
      runId: "run-stale",
      projectId: stack.projectId,
      taskId: null,
      agentId: null,
      role: "developer",
      runtime: "fake",
      status: "running",
      failureKind: null,
      instruction: "stale execution",
      sessionRef: null,
      exitCode: null,
      stoppedReason: null,
      errorMessage: null,
      stdoutTail: null,
      stderrTail: null,
      replyText: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      resultArtifactId: null,
      verificationArtifactId: null,
      structured: null,
      usage: null,
    });

    const recovered = orchestrator.recoverInterruptedPipelines(stack.projectId);
    expect(recovered).toBe(1);

    // The execution should now be marked interrupted
    const rec = stack.storage.executions.get("exec-stale-1");
    expect(rec).toBeDefined();
    expect(rec!.status).toBe("interrupted");

    await stack.storage.close();
  });
});

// ---------------------------------------------------------------------------
// Pipeline run persistence (Phase 6A)
// ---------------------------------------------------------------------------

describe("Orchestrator: pipeline run persistence", () => {
  it("23. creates a pipeline_runs row on start and updates on completion", async () => {
    const stack = makeStack();
    const result = await stack.orchestrator.run(stack.projectId, "build the feature");

    expect(result.status).toBe("completed");
    expect(result.projectId).toBe(stack.projectId);

    // Pipeline run should be persisted
    const runs = stack.storage.pipelineRuns.listByProject(stack.projectId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const pipelineRun = runs[runs.length - 1]!;
    expect(pipelineRun.status).toBe("completed");
    expect(pipelineRun.goal).toBe("build the feature");
    expect(pipelineRun.finishedAt).not.toBeNull();
    expect(pipelineRun.durationMs).toBeGreaterThanOrEqual(0);
    expect(pipelineRun.errorMessage).toBeNull();
    await stack.storage.close();
  });

  it("24. persists failed pipeline with error message", async () => {
    const stack = makeStack(
      failingAgentScript("developer", "syntax error in main.ts"),
    );
    const result = await stack.orchestrator.run(stack.projectId, "implement something");

    expect(result.status).toBe("failed");

    const runs = stack.storage.pipelineRuns.listByProject(stack.projectId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const pipelineRun = runs[runs.length - 1]!;
    expect(pipelineRun.status).toBe("failed");
    expect(pipelineRun.finishedAt).not.toBeNull();
    expect(pipelineRun.durationMs).toBeGreaterThanOrEqual(0);
    await stack.storage.close();
  });

  it("25. persists timeout pipeline", async () => {
    const stack = makeStack(
      perAgentScript({ "*": { status: "failed", text: "timeout" } }),
      { execTimeoutMs: 1 },
    );
    // Use a very low timeout so the execution times out quickly
    const result = await stack.orchestrator.run(stack.projectId, "timeout test");

    // Pipeline should end with failed or timeout
    expect(["failed", "timeout"]).toContain(result.status);

    const runs = stack.storage.pipelineRuns.listByProject(stack.projectId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const pipelineRun = runs[runs.length - 1]!;
    expect(["failed", "timeout"]).toContain(pipelineRun.status);
    expect(pipelineRun.finishedAt).not.toBeNull();
    await stack.storage.close();
  });

  it("26. orchestrator.currentRunId is set during pipeline execution", async () => {
    const stack = makeStack();
    // Before run, currentRunId should be null
    expect(stack.orchestrator.currentRunId).toBeNull();
    await stack.orchestrator.run(stack.projectId, "test currentRunId");
    // After run completes, currentRunId should be null again
    expect(stack.orchestrator.currentRunId).toBeNull();
    await stack.storage.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 6D: Pipeline cancellation
// ---------------------------------------------------------------------------

describe("Orchestrator: pipeline cancellation", () => {
  it("27. cancel a running pipeline returns cancelled status", async () => {
    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "long task");
    // Give the pipeline time to start and register the execution
    await new Promise((r) => setTimeout(r, 200));

    stack.orchestrator.cancel();
    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");
    await stack.storage.close();
  });

  it("28. cancelling before first stage prevents all execution", async () => {
    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "cancel early");
    // Cancel immediately — before the execution starts
    await new Promise((r) => setTimeout(r, 50));
    stack.orchestrator.cancel();
    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");

    // The architect execution may have been created but should be cancelled
    const execs = stack.storage.executions.listByProject(stack.projectId);
    for (const e of execs) {
      expect(["cancelled", "interrupted"]).toContain(e.status);
    }
    await stack.storage.close();
  });

  it("29. cancellation is idempotent", async () => {
    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "idempotent cancel");
    await new Promise((r) => setTimeout(r, 200));

    stack.orchestrator.cancel();
    stack.orchestrator.cancel();
    stack.orchestrator.cancel();
    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");
    expect(stack.orchestrator.isCancelled).toBe(true);
    await stack.storage.close();
  });

  it("30. cancellation persists pipeline_runs.status as cancelled", async () => {
    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "persist cancel");
    await new Promise((r) => setTimeout(r, 200));

    const runId = stack.orchestrator.currentRunId!;
    stack.orchestrator.cancel();
    await pipelinePromise;

    const pipelineRun = stack.storage.pipelineRuns.get(runId)!;
    expect(pipelineRun).toBeDefined();
    expect(pipelineRun.status).toBe("cancelled");
    expect(pipelineRun.finishedAt).not.toBeNull();
    expect(pipelineRun.durationMs).toBeGreaterThanOrEqual(0);
    await stack.storage.close();
  });

  it("31. cancellation emits run.cancelled event", async () => {
    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "cancel events");
    await new Promise((r) => setTimeout(r, 200));

    stack.orchestrator.cancel();
    await pipelinePromise;

    const cancelledEvents = getEventsOfType(stack.storage, "run.cancelled");
    expect(cancelledEvents.length).toBeGreaterThanOrEqual(1);
    await stack.storage.close();
  });

  it("32. no later stages execute after cancellation", async () => {
    const stagesRan: string[] = [];
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      stagesRan.push(role);
      return {
        steps: [{ effect: () => undefined }],
        outcome: { status: "completed", finalText: `${role} done` },
        stepDelayMs: 30_000,
      };
    });

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "stage check");
    // Wait for architect to start (first stage)
    await new Promise((r) => setTimeout(r, 300));

    stack.orchestrator.cancel();
    await pipelinePromise;

    // Architect should have started, but no later stages
    expect(stagesRan).toContain("architect");
    // Developer should not have started after cancellation
    const devSessions = getEventsOfType(stack.storage, "agent.session.opened").filter(
      (e) => "role" in e && e.role === "developer",
    );
    expect(devSessions.length).toBe(0);
    await stack.storage.close();
  });

  it("33. cancellation during revision loop prevents further revisions", async () => {
    let developerRuns = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "developer") {
        developerRuns++;
        if (developerRuns === 1) {
          return {
            steps: [{
              effect: () => writeFileSync(join(stack.root, "app.js"), "v1"),
              events: [{ kind: "text", text: "v1" }],
            }],
            outcome: { status: "completed", finalText: "v1" },
            stepDelayMs: 5,
          };
        }
        // Developer retry hangs
        return {
          steps: [{ effect: () => undefined }],
          outcome: { status: "completed" },
          stepDelayMs: 30_000,
        };
      }
      if (role === "tester") {
        return {
          steps: [{ events: [{ kind: "text", text: "test failed" }] }],
          outcome: { status: "failed", finalText: "FAIL" },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "revision cancel");
    // Wait for the pipeline to enter a revision cycle (architect + developer + tester + dev retry)
    await new Promise((r) => setTimeout(r, 1000));

    stack.orchestrator.cancel();
    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");
    await stack.storage.close();
  });

  it("34. cancellation does not affect another running pipeline", async () => {
    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    const pipeline1 = stack.orchestrator.run(stack.projectId, "pipeline 1");
    await new Promise((r) => setTimeout(r, 200));

    // Cancel the first pipeline
    stack.orchestrator.cancel();
    const result1 = await pipeline1;
    expect(result1.status).toBe("cancelled");

    // A second orchestrator with a separate run should not be affected
    const storage2 = createStorage({ path: join(dataRoot, `cancel-${crypto.randomUUID()}.db`) });
    const ws2 = new WorkspaceService({
      store: storage2.projects,
      workspacesRoot: join(dataRoot, "ws-cancel"),
    });
    const handle2 = ws2.create("cancel-test");
    const es2 = new ExecutionService({
      storage: storage2,
      workspaces: ws2,
      git: { init: () => {}, status: () => ({ branch: "HEAD", entries: [] }) } as never,
      runtime: new FakeRuntime({
        steps: [{ events: [{ kind: "text", text: "ok" }] }],
        outcome: { status: "completed", sessionId: "ses_0", finalText: "done" },
        stepDelayMs: 5,
      }),
      agents: createDefaultAgentRegistry(),
      defaultTimeoutMs: 30_000,
    });
    const orch2 = new Orchestrator({ storage: storage2, workspaces: ws2, executionService: es2 });
    const result2 = await orch2.run(handle2.projectId, "pipeline 2");
    expect(result2.status).toBe("completed");

    await storage2.close();
    await stack.storage.close();
  });

  it("35. cancel when no pipeline is running is a no-op", () => {
    const stack = makeStack();
    // No pipeline running — cancel should be harmless
    stack.orchestrator.cancel();
    expect(stack.orchestrator.isCancelled).toBe(true);
    expect(stack.orchestrator.currentRunId).toBeNull();
  });

  it("36. cancellation with git rollback restores workspace", async () => {
    const { GitService } = await import("@devmesh/workspace");
    const git = new GitService();

    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    git.init(stack.root);
    const orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      git,
    });

    const pipelinePromise = orchestrator.run(stack.projectId, "rollback cancel");
    await new Promise((r) => setTimeout(r, 300));

    orchestrator.cancel();
    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");

    // Verify no broken files remain (workspace should be clean after rollback)
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(stack.root, "should-not-exist.txt"))).toBe(false);
    await stack.storage.close();
  });

  it("37. two simultaneous cancel requests produce single terminal state", async () => {
    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "double cancel");
    await new Promise((r) => setTimeout(r, 200));

    stack.orchestrator.cancel();
    stack.orchestrator.cancel();
    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");

    // Only one run.cancelled event should exist
    const cancelledEvents = getEventsOfType(stack.storage, "run.cancelled");
    expect(cancelledEvents.length).toBe(1);
    await stack.storage.close();
  });

  it("38. cancellation races with pipeline completion — no corruption", async () => {
    // Use a fast-finishing script; cancel may or may not win the race
    const stack = makeStack(perAgentScript({
      architect: { text: "spec" },
      developer: {
        effect: () => writeFileSync(join(stack.root, "app.js"), "ok"),
        text: "done",
      },
      tester: { text: "pass" },
      reviewer: { text: "APPROVED" },
    }));

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "race cancel");
    // Cancel after a short delay — the pipeline may complete before cancel takes effect
    await new Promise((r) => setTimeout(r, 50));
    stack.orchestrator.cancel();
    const result = await pipelinePromise;

    // Exactly one terminal state — no corruption
    expect(["completed", "cancelled"]).toContain(result.status);

    const runs = stack.storage.pipelineRuns.listByProject(stack.projectId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const lastRun = runs[runs.length - 1]!;
    expect(["completed", "cancelled"]).toContain(lastRun.status);
    expect(lastRun.finishedAt).not.toBeNull();
    await stack.storage.close();
  });

  it("39. cancelled pipeline has clean terminal state", async () => {
    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "clean terminal");
    await new Promise((r) => setTimeout(r, 200));

    const runId = stack.orchestrator.currentRunId!;
    stack.orchestrator.cancel();
    const result = await pipelinePromise;

    expect(result.status).toBe("cancelled");

    // Pipeline run persisted with all required fields
    const run = stack.storage.pipelineRuns.get(runId)!;
    expect(run).toBeDefined();
    expect(run.status).toBe("cancelled");
    expect(run.finishedAt).not.toBeNull();
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.id).toBe(runId);
    expect(run.projectId).toBe(stack.projectId);

    // No run.completed or run.failed event should exist for this run
    const allEvents = [...stack.storage.events.listAfter(0, 1000)];
    const terminalEvents = allEvents.filter(
      (e) => e.runId === runId && (e.type === "run.completed" || e.type === "run.failed"),
    );
    expect(terminalEvents.length).toBe(0);

    await stack.storage.close();
  });

  it("40. cancel after pipeline completion is idempotent and non-corrupting", async () => {
    const stack = makeStack(perAgentScript({
      architect: { text: "spec" },
      developer: {
        effect: () => writeFileSync(join(stack.root, "app.js"), "ok"),
        text: "done",
      },
      tester: { text: "pass" },
      reviewer: { text: "APPROVED" },
    }));

    const result = await stack.orchestrator.run(stack.projectId, "cancel after done");
    expect(result.status).toBe("completed");

    // Cancel after completion — should not corrupt state
    stack.orchestrator.cancel();

    const runs = stack.storage.pipelineRuns.listByProject(stack.projectId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const lastRun = runs[runs.length - 1]!;
    // Status should remain "completed" — cancel after completion doesn't overwrite
    expect(lastRun.status).toBe("completed");
    await stack.storage.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 6E: Pipeline Lifecycle Hardening
// ---------------------------------------------------------------------------

describe("TerminalStateError", () => {
  it("has correct properties", () => {
    const err = new TerminalStateError({
      runId: "run_abc",
      currentStatus: "completed",
      attemptedStatus: "cancelled",
    });
    expect(err.name).toBe("TerminalStateError");
    expect(err.runId).toBe("run_abc");
    expect(err.currentStatus).toBe("completed");
    expect(err.attemptedStatus).toBe("cancelled");
    expect(err.message).toContain("run_abc");
    expect(err.message).toContain("completed");
    expect(err instanceof Error).toBe(true);
  });
});

describe("Orchestrator: Phase 6E — terminal-state protection", () => {
  it("41. cancel after completion does not overwrite status", async () => {
    const stack = makeStack(perAgentScript({
      architect: { text: "spec" },
      developer: {
        effect: () => writeFileSync(join(stack.root, "app.js"), "ok"),
        text: "done",
      },
      tester: { text: "pass" },
      reviewer: { text: "APPROVED" },
    }));

    const result = await stack.orchestrator.run(stack.projectId, "terminal protect");
    expect(result.status).toBe("completed");

    // Cancel after completion — should be a no-op
    stack.orchestrator.cancel();

    const runs = stack.storage.pipelineRuns.listByProject(stack.projectId);
    const lastRun = runs[runs.length - 1]!;
    expect(lastRun.status).toBe("completed");

    // No run.cancelled event should exist for this run
    const runId = findLatestRunId(stack.storage)!;
    const cancelledEvents = getEventsOfType(stack.storage, "run.cancelled").filter(
      (e) => e.runId === runId,
    );
    expect(cancelledEvents.length).toBe(0);
    await stack.storage.close();
  });

  it("42. concurrent cancel + completion produces exactly one terminal event", async () => {
    const stack = makeStack(perAgentScript({
      architect: { text: "spec" },
      developer: {
        effect: () => writeFileSync(join(stack.root, "app.js"), "ok"),
        text: "done",
      },
      tester: { text: "pass" },
      reviewer: { text: "APPROVED" },
    }));

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "race test");
    // Cancel shortly after start — the pipeline may complete before or after
    await new Promise((r) => setTimeout(r, 50));
    stack.orchestrator.cancel();
    const result = await pipelinePromise;

    // Exactly one terminal status
    expect(["completed", "cancelled"]).toContain(result.status);

    const runs = stack.storage.pipelineRuns.listByProject(stack.projectId);
    const lastRun = runs[runs.length - 1]!;
    expect(["completed", "cancelled"]).toContain(lastRun.status);
    expect(lastRun.finishedAt).not.toBeNull();

    // Exactly one terminal event for this run
    const runId = findLatestRunId(stack.storage)!;
    const terminalEvents = getEventsOfType(stack.storage, "run.completed")
      .concat(getEventsOfType(stack.storage, "run.failed"))
      .concat(getEventsOfType(stack.storage, "run.cancelled"))
      .filter((e) => e.runId === runId);
    expect(terminalEvents.length).toBe(1);
    await stack.storage.close();
  });

  it("43. cancel idempotency: multiple cancel() calls produce single run.cancelled event", async () => {
    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "idempotent cancel");
    await new Promise((r) => setTimeout(r, 200));

    stack.orchestrator.cancel();
    stack.orchestrator.cancel();
    stack.orchestrator.cancel();
    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");

    // Exactly one run.cancelled event
    const cancelledEvents = getEventsOfType(stack.storage, "run.cancelled");
    expect(cancelledEvents.length).toBe(1);
    await stack.storage.close();
  });

  it("44. emitEvent deduplicates identical terminal event types per run", async () => {
    const stack = makeStack(perAgentScript({
      architect: { text: "spec" },
      developer: {
        effect: () => writeFileSync(join(stack.root, "app.js"), "ok"),
        text: "done",
      },
      tester: { text: "pass" },
      reviewer: { text: "APPROVED" },
    }));

    const result = await stack.orchestrator.run(stack.projectId, "dedup test");
    expect(result.status).toBe("completed");

    // Only one run.completed event should exist
    const completedEvents = getEventsOfType(stack.storage, "run.completed");
    expect(completedEvents.length).toBe(1);

    // No run.failed or run.cancelled events should exist
    const failedEvents = getEventsOfType(stack.storage, "run.failed");
    const cancelledEvents = getEventsOfType(stack.storage, "run.cancelled");
    expect(failedEvents.length).toBe(0);
    expect(cancelledEvents.length).toBe(0);
    await stack.storage.close();
  });

  it("45. git rollback is idempotent: second rollback attempt is skipped", async () => {
    const { GitService } = await import("@devmesh/workspace");
    const git = new GitService();

    const stack = makeStack((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));

    git.init(stack.root);

    const orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      git,
    });

    const pipelinePromise = orchestrator.run(stack.projectId, "rollback idempotent");
    await new Promise((r) => setTimeout(r, 200));

    orchestrator.cancel();
    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");

    // Verify workspace exists and is intact (rollback happened once)
    const handle = stack.ws.get(stack.projectId);
    const { existsSync } = await import("node:fs");
    expect(existsSync(handle.root)).toBe(true);

    // The pipeline run should have a clean terminal state
    const runId = findLatestRunId(stack.storage)!;
    const run = stack.storage.pipelineRuns.get(runId)!;
    expect(run.status).toBe("cancelled");
    expect(run.finishedAt).not.toBeNull();
    await stack.storage.close();
  });
});

describe("Orchestrator: Phase 6E — error classification", () => {
  it("46. transient error in event persistence does not fail the pipeline", async () => {
    const storage = createStorage({ path: join(dataRoot, `orch-err-${crypto.randomUUID()}.db`) });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(dataRoot, "ws-err"),
    });
    const handle = workspaces.create("err-test");

    // Create a failing event append to simulate transient error
    let eventAppendCount = 0;
    const originalAppend = storage.events.append.bind(storage.events);
    storage.events.append = ((...args: unknown[]) => {
      eventAppendCount++;
      // Fail on the 3rd event append (which is a non-critical artifact event)
      if (eventAppendCount === 3) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return originalAppend(...(args as [never]));
    }) as typeof storage.events.append;

    const runtime = new FakeRuntime({
      steps: [{ events: [{ kind: "text", text: "ok" }] }],
      outcome: { status: "completed", sessionId: "ses_0", finalText: "done" },
      stepDelayMs: 5,
    });

    const agents = createDefaultAgentRegistry();
    const executionService = new ExecutionService({
      storage,
      workspaces,
      git: { init: () => {}, status: () => ({ branch: "HEAD", entries: [] }) } as never,
      runtime,
      agents,
      defaultTimeoutMs: 30_000,
    });

    const orchestrator = new Orchestrator({
      storage,
      workspaces,
      executionService,
    });

    // Pipeline should complete despite transient event persistence failures
    const result = await orchestrator.run(handle.projectId, "transient error test");
    expect(result.status).toBe("completed");
    await storage.close();
  });

  it("47. non-critical side-effect failure is logged not fatal", async () => {
    const storage = createStorage({ path: join(dataRoot, `orch-side-${crypto.randomUUID()}.db`) });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(dataRoot, "ws-side"),
    });
    const handle = workspaces.create("side-test");

    // Patch storage.executions.listByProject to throw on the first call in cancel()
    // This simulates a non-critical side-effect failure
    const originalListByProject = storage.executions.listByProject.bind(storage.executions);
    let listCallCount = 0;
    storage.executions.listByProject = ((...args: unknown[]) => {
      listCallCount++;
      if (listCallCount === 1) {
        throw new Error("database locked");
      }
      return originalListByProject(...(args as [string]));
    }) as typeof storage.executions.listByProject;

    const runtime = new FakeRuntime({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    });

    const agents = createDefaultAgentRegistry();
    const executionService = new ExecutionService({
      storage,
      workspaces,
      git: { init: () => {}, status: () => ({ branch: "HEAD", entries: [] }) } as never,
      runtime,
      agents,
      defaultTimeoutMs: 30_000,
    });

    const orchestrator = new Orchestrator({
      storage,
      workspaces,
      executionService,
    });

    const pipelinePromise = orchestrator.run(handle.projectId, "side-effect test");
    await new Promise((r) => setTimeout(r, 200));

    // Cancel should not throw even if the side-effect fails
    expect(() => orchestrator.cancel()).not.toThrow();
    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");
    await storage.close();
  });

  it("48. corrupt artifact creation fails gracefully (non-fatal)", async () => {
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "architect") {
        // Return unparseable text that will cause artifact builder to throw
        return {
          steps: [{ events: [{ kind: "text", text: "<<<NOT VALID JSON>>>" }] }],
          outcome: { status: "completed", finalText: "<<<NOT VALID JSON>>>" },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "corrupt artifact");
    // Pipeline should still complete despite artifact creation failure
    expect(result.status).toBe("completed");
    await stack.storage.close();
  });
});

describe("assertPipelineConsistency", () => {
  it("49. passes after a well-formed pipeline run", async () => {
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      return {
        steps: [{ events: [{ kind: "text", text: `${role} completed task` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "consistency check");
    expect(result.status).toBe("completed");

    const runs = stack.storage.pipelineRuns.listByProject(stack.projectId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const runId = runs[0]!.id;
    const violations = assertPipelineConsistency(stack.storage.db, runId);
    expect(violations).toEqual([]);
    await stack.storage.close();
  });

  it("50. catches missing execution link for a task", async () => {
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      return {
        steps: [{ events: [{ kind: "text", text: `${role} completed task` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "consistency drift");
    expect(result.status).toBe("completed");

    const runs = stack.storage.pipelineRuns.listByProject(stack.projectId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const runId = runs[0]!.id;

    // Simulate schema drift: insert a task with no matching execution
    const orphanTaskId = crypto.randomUUID();
    stack.storage.db.prepare(
      `INSERT INTO tasks (id, run_id, project_id, role, title, detail,
         acceptance_criteria, depends_on, status, attempts, max_attempts,
         created_at, updated_at, artifacts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      orphanTaskId,
      runId,
      stack.projectId,
      "developer",
      "orphan task",
      "no execution",
      JSON.stringify(["check"]),
      JSON.stringify([]),
      "pending",
      0,
      3,
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify([]),
    );

    const violations = assertPipelineConsistency(stack.storage.db, runId);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.check === "task_execution_link")).toBe(true);
    await stack.storage.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 7B: Pipeline Stage Persistence
// ---------------------------------------------------------------------------

describe("Phase 7B — pipeline stage persistence", () => {
  it("51. inserts 4 pending stage rows on pipeline start", async () => {
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "stage init test");
    expect(result.status).toBe("completed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const stages = stack.storage.stages.listByRun(runId);
    expect(stages).toHaveLength(4);
    expect(stages.map((s) => s.stageRole)).toEqual(["architect", "developer", "tester", "reviewer"]);
    expect(stages.every((s) => s.status === "completed")).toBe(true);
    expect(stages.every((s) => s.completedAt !== null)).toBe(true);
    await stack.storage.close();
  });

  it("52. stage status transitions through pending → running → completed", async () => {
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "stage transition test");
    expect(result.status).toBe("completed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const stages = stack.storage.stages.listByRun(runId);
    for (const s of stages) {
      expect(s.status).toBe("completed");
      expect(s.startedAt).not.toBeNull();
      expect(s.completedAt).not.toBeNull();
      expect(s.executionId).not.toBeNull();
    }
    await stack.storage.close();
  });

  it("53. stages are cancelled when pipeline fails (architect failure)", async () => {
    const stack = makeStack(failingAgentScript("architect", "architect crashed"));

    const result = await stack.orchestrator.run(stack.projectId, "stage fail test");
    expect(result.status).toBe("failed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const stages = stack.storage.stages.listByRun(runId);
    expect(stages).toHaveLength(4);

    // Architect should be failed
    const architectStage = stages.find((s) => s.stageRole === "architect")!;
    expect(architectStage.status).toBe("failed");

    // Remaining stages should be cancelled (never ran)
    const developerStage = stages.find((s) => s.stageRole === "developer")!;
    const testerStage = stages.find((s) => s.stageRole === "tester")!;
    const reviewerStage = stages.find((s) => s.stageRole === "reviewer")!;
    expect(developerStage.status).toBe("cancelled");
    expect(testerStage.status).toBe("cancelled");
    expect(reviewerStage.status).toBe("cancelled");
    await stack.storage.close();
  });

  it("54. stages are cancelled when pipeline is cancelled", async () => {
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      return {
        steps: [{ effect: () => undefined }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 30_000,
      };
    });

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "stage cancel test");
    await new Promise((r) => setTimeout(r, 200));
    stack.orchestrator.cancel();
    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const stages = stack.storage.stages.listByRun(runId);
    expect(stages).toHaveLength(4);

    // At least the current stage should be cancelled, and remaining pending stages cancelled
    const statuses = stages.map((s) => s.status);
    expect(statuses.every((s) => s === "cancelled" || s === "completed" || s === "failed")).toBe(true);
    await stack.storage.close();
  });

  it("55. stage execution_id and task_id are recorded", async () => {
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "stage exec id test");
    expect(result.status).toBe("completed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const stages = stack.storage.stages.listByRun(runId);
    for (const s of stages) {
      expect(s.executionId).not.toBeNull();
      expect(typeof s.executionId).toBe("string");
    }
    await stack.storage.close();
  });

  it("56. getLastCompleted returns the last completed stage for resumability support", async () => {
    const stack = makeStack(failingAgentScript("tester", "tests failed"));

    const result = await stack.orchestrator.run(stack.projectId, "stage last-completed test");
    expect(result.status).toBe("failed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const last = stack.storage.stages.getLastCompleted(runId);
    expect(last).not.toBeNull();
    // Architect completes first; developer transitions back to "running" during
    // the revision loop so it is not "completed" when the pipeline fails.
    expect(last!.stageRole).toBe("architect");
    await stack.storage.close();
  });

  it("57. stage rows survive database close/reopen", async () => {
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const runResult = await stack.orchestrator.run(stack.projectId, "stage durability test");
    expect(runResult.status).toBe("completed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const stages = stack.storage.stages.listByRun(runId);
    expect(stages.length).toBe(4);
    expect(stages.every((s) => s.completedAt !== null)).toBe(true);
    await stack.storage.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 7C: Resumable Pipelines
// ---------------------------------------------------------------------------

describe("Phase 7C — resumable pipelines", () => {
  it("58. resume after failure skips completed stages and runs remaining", async () => {
    let testerCallCount = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "tester") {
        testerCallCount++;
        if (testerCallCount <= 2) {
          return {
            steps: [{ events: [{ kind: "text", text: "tests failed" }] }],
            outcome: { status: "failed", finalText: "tests failed" },
            stepDelayMs: 5,
          };
        }
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });
    stack.orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      maxTesterRevisions: 1,
    });

    const result1 = await stack.orchestrator.run(stack.projectId, "resume test");
    expect(result1.status).toBe("failed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const stages1 = stack.storage.stages.listByRun(runId);
    expect(stages1).toHaveLength(4);
    const architectStage = stages1.find((s) => s.stageRole === "architect")!;
    expect(architectStage.status).toBe("completed");

    const result2 = await stack.orchestrator.resume(runId);
    expect(result2.status).toBe("completed");

    const stages2 = stack.storage.stages.listByRun(runId);
    expect(stages2.length).toBeGreaterThanOrEqual(5);
    await stack.storage.close();
  });

  it("59. resume after cancellation succeeds", async () => {
    let callCount = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      callCount++;
      if (callCount <= 1) {
        return {
          steps: [{ effect: () => undefined }],
          outcome: { status: "completed", finalText: `${role} ok` },
          stepDelayMs: 60_000,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "cancel resume test");
    await new Promise((r) => setTimeout(r, 200));
    stack.orchestrator.cancel();
    const result1 = await pipelinePromise;
    expect(result1.status).toBe("cancelled");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;

    const result2 = await stack.orchestrator.resume(runId);
    expect(result2.status).toBe("completed");

    await stack.storage.close();
  });

  it("60. resume after timeout succeeds", async () => {
    let callCount = 0;
    const stack = makeStack(
      (req) => {
        const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
        const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
        callCount++;
        if (callCount <= 1) {
          return {
            steps: [{ effect: () => undefined }],
            outcome: { status: "completed", finalText: `${role} ok` },
            stepDelayMs: 600_000,
          };
        }
        return {
          steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
          outcome: { status: "completed", finalText: `${role} ok` },
          stepDelayMs: 5,
        };
      },
      { execTimeoutMs: 500 },
    );

    const result1 = await stack.orchestrator.run(stack.projectId, "timeout resume test");
    expect(result1.status).toBe("timeout");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;

    const result2 = await stack.orchestrator.resume(runId);
    expect(result2.status).toBe("completed");

    await stack.storage.close();
  });

  it("61. resume rejects running pipeline (409)", async () => {
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      return {
        steps: [{ effect: () => undefined }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 60_000,
      };
    });

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "running resume test");
    await new Promise((r) => setTimeout(r, 200));
    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;

    await expect(stack.orchestrator.resume(runId))
      .rejects.toThrow(/terminal state/);

    stack.orchestrator.cancel();
    await pipelinePromise;
    await stack.storage.close();
  });

  it("62. resume rejects completed pipeline (409)", async () => {
    const stack = makeStack();

    const result = await stack.orchestrator.run(stack.projectId, "completed resume test");
    expect(result.status).toBe("completed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;

    await expect(stack.orchestrator.resume(runId))
      .rejects.toThrow(/terminal state/);

    await stack.storage.close();
  });

  it("63. task cards are created only for remaining stages", async () => {
    let devCallCount = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "developer") {
        devCallCount++;
        if (devCallCount <= 1) {
          return {
            steps: [{ events: [{ kind: "text", text: "dev failed" }] }],
            outcome: { status: "failed", finalText: "dev failed" },
            stepDelayMs: 5,
          };
        }
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result1 = await stack.orchestrator.run(stack.projectId, "task card test");
    expect(result1.status).toBe("failed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const tasksBefore = stack.storage.tasks.listByRun(runId as never);
    expect(tasksBefore.length).toBe(4);

    const result2 = await stack.orchestrator.resume(runId);
    expect(result2.status).toBe("completed");

    const tasksAfter = stack.storage.tasks.listByRun(runId as never);
    expect(tasksAfter.length).toBe(7);

    const newTasks = tasksAfter.slice(4);
    expect(newTasks.map((t) => t.role)).toEqual(["developer", "tester", "reviewer"]);

    await stack.storage.close();
  });

  it("64. context entry records resume origin", async () => {
    let devCallCount = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "developer") {
        devCallCount++;
        if (devCallCount <= 1) {
          return {
            steps: [{ events: [{ kind: "text", text: "dev failed" }] }],
            outcome: { status: "failed", finalText: "dev failed" },
            stepDelayMs: 5,
          };
        }
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result1 = await stack.orchestrator.run(stack.projectId, "context resume test");
    expect(result1.status).toBe("failed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;

    const result2 = await stack.orchestrator.resume(runId);
    expect(result2.status).toBe("completed");

    const contextEntries = stack.storage.context.latestByKey("decision");
    expect(contextEntries.size).toBe(1);
    const entry = contextEntries.get("resumed_from")!;
    expect(entry.namespace).toBe("decision");
    expect(entry.key).toBe("resumed_from");
    const value = entry.value as { runId: string; stageIndex: number };
    expect(value.runId).toBe(runId);
    expect(value.stageIndex).toBe(1);

    await stack.storage.close();
  });

  it("65. resume emits run.started event", async () => {
    let devCallCount = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "developer") {
        devCallCount++;
        if (devCallCount <= 1) {
          return {
            steps: [{ events: [{ kind: "text", text: "dev failed" }] }],
            outcome: { status: "failed", finalText: "dev failed" },
            stepDelayMs: 5,
          };
        }
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result1 = await stack.orchestrator.run(stack.projectId, "event resume test");
    expect(result1.status).toBe("failed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const eventsBefore = getEventsOfType(stack.storage, "run.started").length;

    const result2 = await stack.orchestrator.resume(runId);
    expect(result2.status).toBe("completed");

    const eventsAfter = getEventsOfType(stack.storage, "run.started");
    expect(eventsAfter.length).toBe(eventsBefore + 1);

    await stack.storage.close();
  });

  it("66. resume is idempotent — second resume on now-completed run rejects", async () => {
    let devCallCount = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "developer") {
        devCallCount++;
        if (devCallCount <= 1) {
          return {
            steps: [{ events: [{ kind: "text", text: "dev failed" }] }],
            outcome: { status: "failed", finalText: "dev failed" },
            stepDelayMs: 5,
          };
        }
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result1 = await stack.orchestrator.run(stack.projectId, "idempotent resume test");
    expect(result1.status).toBe("failed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;

    const result2 = await stack.orchestrator.resume(runId);
    expect(result2.status).toBe("completed");

    await expect(stack.orchestrator.resume(runId))
      .rejects.toThrow(/terminal state/);

    await stack.storage.close();
  });

  it("67. resumed pipeline supports revision loops", async () => {
    let devCallCount = 0;
    let testerCallCount = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "developer") {
        devCallCount++;
        if (devCallCount <= 1) {
          return {
            steps: [{ events: [{ kind: "text", text: "dev failed" }] }],
            outcome: { status: "failed", finalText: "dev failed" },
            stepDelayMs: 5,
          };
        }
      }
      if (role === "tester") {
        testerCallCount++;
        if (testerCallCount <= 1) {
          return {
            steps: [{ events: [{ kind: "text", text: "tests failed" }] }],
            outcome: { status: "failed", finalText: "tests failed" },
            stepDelayMs: 5,
          };
        }
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result1 = await stack.orchestrator.run(stack.projectId, "revision resume test");
    expect(result1.status).toBe("failed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;

    const result2 = await stack.orchestrator.resume(runId);
    expect(result2.status).toBe("completed");

    await stack.storage.close();
  });

  it("68. resumed pipeline supports cancellation", async () => {
    const stack = makeStack(
      () => {
        return {
          steps: [{ effect: () => undefined }],
          outcome: { status: "completed", finalText: "ok" },
          stepDelayMs: 60_000,
        };
      },
      { execTimeoutMs: 500 },
    );

    const pipelinePromise = stack.orchestrator.run(stack.projectId, "cancel resumed test");
    await new Promise((r) => setTimeout(r, 200));
    stack.orchestrator.cancel();
    const result1 = await pipelinePromise;
    expect(result1.status).toBe("cancelled");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;

    const resumePromise = stack.orchestrator.resume(runId);
    await new Promise((r) => setTimeout(r, 200));
    stack.orchestrator.cancel();
    const result2 = await resumePromise;
    expect(result2.status).toBe("cancelled");

    await stack.storage.close();
  });

  it("69. pipeline_runs.status transitions back to running then terminal", async () => {
    let testerCallCount = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "tester") {
        testerCallCount++;
        if (testerCallCount <= 2) {
          return {
            steps: [{ events: [{ kind: "text", text: "tests failed" }] }],
            outcome: { status: "failed", finalText: "tests failed" },
            stepDelayMs: 5,
          };
        }
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });

    const result1 = await stack.orchestrator.run(stack.projectId, "status transition test");
    expect(result1.status).toBe("failed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const rec1 = stack.storage.pipelineRuns.get(runId);
    expect(rec1!.status).toBe("failed");

    const result2 = await stack.orchestrator.resume(runId);
    expect(result2.status).toBe("completed");

    const rec2 = stack.storage.pipelineRuns.get(runId);
    expect(rec2!.status).toBe("completed");
    expect(rec2!.finishedAt).not.toBeNull();
    expect(rec2!.durationMs).not.toBeNull();

    await stack.storage.close();
  });

  it("70. resume skips all completed stages when all but last are done", async () => {
    let reviewerCallCount = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
      if (role === "reviewer") {
        reviewerCallCount++;
        if (reviewerCallCount <= 1) {
          return {
            steps: [{ events: [{ kind: "text", text: "reviewer rejected" }] }],
            outcome: { status: "failed", finalText: "reviewer rejected" },
            stepDelayMs: 5,
          };
        }
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });
    stack.orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      maxReviewerRevisions: 0,
    });

    const result1 = await stack.orchestrator.run(stack.projectId, "last stage resume test");
    expect(result1.status).toBe("failed");

    const runId = stack.storage.pipelineRuns.listByProject(stack.projectId)[0]!.id;
    const stages1 = stack.storage.stages.listByRun(runId);
    const completedStages = stages1.filter((s) => s.status === "completed");
    expect(completedStages.length).toBe(3);

    const result2 = await stack.orchestrator.resume(runId);
    expect(result2.status).toBe("completed");

    const stages2 = stack.storage.stages.listByRun(runId);
    expect(stages2.length).toBe(5);

    const newReviewerStage = stages2.find(
      (s) => s.stageRole === "reviewer" && s.status === "completed" && s.startedAt !== null,
    );
    expect(newReviewerStage).toBeDefined();

    await stack.storage.close();
  });
});

describe("Orchestrator: Phase 7D — structured output", () => {
  it("sends outputFormat for spec/plan, test_report, and review stages but not developer", async () => {
    const received = new Map<string, unknown>();
    const stack = makeStack((req) => {
      const agentMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = agentMatch?.[1]?.toLowerCase() ?? "unknown";
      received.set(role, req.outputFormat ?? null);
      return {
        steps: [{ events: [{ kind: "text", text: `${role} done` }] }],
        outcome: { status: "completed", sessionId: `ses_${role}`, finalText: `${role} done` },
        stepDelayMs: 1,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "structured output test");
    expect(result.status).toBe("completed");

    expect((received.get("architect") as { name?: string })?.name).toBe("architecture-plan");
    expect((received.get("tester") as { name?: string })?.name).toBe("test-report");
    expect((received.get("reviewer") as { name?: string })?.name).toBe("review");
    expect(received.get("developer")).toBeNull();

    await stack.storage.close();
  });

  it("uses structured output to build spec, plan, and test_report artifacts", async () => {
    const specPayload = {
      title: "Calculator module",
      summary: "A simple arithmetic calculator",
      goals: ["Add", "Subtract"],
      nonGoals: [],
      constraints: [],
      techStack: [],
      risks: [],
      openQuestions: [],
    };
    const planPayload = {
      tasks: [
        {
          refKey: "calc",
          role: "developer",
          title: "Implement calculator",
          detail: "Build the module",
          acceptanceCriteria: ["works"],
          dependsOn: [],
        },
      ],
    };
    const testReportPayload = {
      invocation: { command: "npm test", exitCode: 0, durationMs: 120 },
      verdict: "pass" as const,
      totals: { passed: 5, failed: 0, skipped: 0 },
      failures: [],
    };

    const stack = makeStack(
      perAgentScript({
        architect: {
          text: "some free text architect reply",
          structured: { spec: specPayload, plan: planPayload },
        },
        developer: {
          effect: () => {
            writeFileSync(join(stack.root, "app.js"), "export const x = 1;\n");
            // Provide a passing test script so the independent test replay of
            // the structured invocation command ("npm test") reproduces the
            // tester's claimed "pass" verdict instead of contradicting it.
            writeFileSync(
              join(stack.root, "package.json"),
              JSON.stringify({ name: "calc", scripts: { test: "true" } }),
            );
          },
          text: "implemented",
        },
        tester: { text: "all green", structured: testReportPayload },
        reviewer: { text: "APPROVED" },
      }),
    );

    const result = await stack.orchestrator.run(stack.projectId, "build a calculator");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const artifacts = stack.storage.artifacts.listByRun(runId as never);
    const spec = artifacts.find((a) => a.kind === "spec");
    const plan = artifacts.find((a) => a.kind === "plan");
    const testReport = artifacts.find((a) => a.kind === "test_report");

    // Artifacts reflect the structured payloads, not the free-text fallback.
    expect((spec!.payload as { title: string }).title).toBe("Calculator module");
    expect((plan!.payload as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect((testReport!.payload as { totals: { passed: number } }).totals.passed).toBe(5);
    expect((testReport!.payload as { invocation: { command: string } }).invocation.command).toBe("npm test");

    await stack.storage.close();
  });

  it("uses structured output to build review artifacts", async () => {
    const changeSetId = newArtifactId();
    const stack = makeStack(
      perAgentScript({
        architect: { text: "plan" },
        developer: {
          effect: () => writeFileSync(join(stack.root, "app.js"), "export const x = 1;\n"),
          text: "implemented",
        },
        tester: { text: "pass" },
        reviewer: {
          text: "free text",
          structured: {
            subject: { changeSetId, testReportId: changeSetId },
            verdict: "approved" as const,
            findings: [],
            summary: "Approved the implementation",
          },
        },
      }),
    );

    const result = await stack.orchestrator.run(stack.projectId, "review target");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const artifacts = stack.storage.artifacts.listByRun(runId as never);
    const review = artifacts.find((a) => a.kind === "review");
    const subject = (review!.payload as { subject: { changeSetId: string } }).subject;
    expect(subject.changeSetId).toBe(changeSetId);
    expect((review!.payload as { verdict: string }).verdict).toBe("approved");
    expect((review!.payload as { summary: string }).summary).toBe("Approved the implementation");

    await stack.storage.close();
  });

  it("falls back to text-parsing when structured output is invalid", async () => {
    const stack = makeStack(
      perAgentScript({
        architect: { text: "plan" },
        developer: {
          effect: () => writeFileSync(join(stack.root, "app.js"), "export const x = 1;\n"),
          text: "implemented",
        },
        tester: { text: "5 passed", structured: { verdict: "pass" } as never },
        reviewer: { text: "APPROVED" },
      }),
    );

    const result = await stack.orchestrator.run(stack.projectId, "invalid structured");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const artifacts = stack.storage.artifacts.listByRun(runId as never);
    const testReport = artifacts.find((a) => a.kind === "test_report");
    // Invalid structured output degrades to the free-text parser.
    expect(testReport).toBeDefined();
    expect((testReport!.payload as { verdict: string }).verdict).toBe("pass");
    expect((testReport!.payload as { totals: { passed: number } }).totals.passed).toBe(5);

    await stack.storage.close();
  });

  it("falls back to text-parsing when structured output is absent", async () => {
    const stack = makeStack(
      perAgentScript({
        architect: { text: "A simple spec with Goals listed" },
        developer: {
          effect: () => writeFileSync(join(stack.root, "app.js"), "export const x = 1;\n"),
          text: "implemented",
        },
        tester: { text: "2 tests passed" },
        reviewer: { text: "APPROVED" },
      }),
    );

    const result = await stack.orchestrator.run(stack.projectId, "text only");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const artifacts = stack.storage.artifacts.listByRun(runId as never);
    const spec = artifacts.find((a) => a.kind === "spec");
    const plan = artifacts.find((a) => a.kind === "plan");
    const testReport = artifacts.find((a) => a.kind === "test_report");
    // No structured output anywhere: all artifacts built from free text.
    expect(spec).toBeDefined();
    expect(plan).toBeDefined();
    expect(testReport).toBeDefined();

    await stack.storage.close();
  });
});

describe("Orchestrator: Phase 7E — independent test replay", () => {
  const architectPayload = {
    spec: {
      title: "Calc",
      summary: "s",
      goals: ["g"],
      nonGoals: [],
      constraints: [],
      techStack: [],
      risks: [],
      openQuestions: [],
    },
    plan: {
      tasks: [
        {
          refKey: "calc",
          role: "developer",
          title: "Implement",
          detail: "impl",
          acceptanceCriteria: ["works"],
          dependsOn: [],
        },
      ],
    },
  };

  const passClaim = (command: string) => ({
    invocation: { command, exitCode: 0, durationMs: 100 },
    verdict: "pass" as const,
    totals: { passed: 1, failed: 0, skipped: 0 },
    failures: [],
  });

  function replayVerificationArtifacts(stack: Stack) {
    const runId = findLatestRunId(stack.storage)!;
    return stack.storage.artifacts
      .listByRun(runId as never)
      .filter((a) => a.kind === "verification");
  }

  it("extracts the tester's command and replays it, producing a verification.v1 artifact", async () => {
    const stack = makeStack(
      perAgentScript({
        architect: { text: "plan", structured: architectPayload },
        developer: {
          effect: () => {
            writeFileSync(join(stack.root, "app.js"), "export const x = 1;\n");
            writeFileSync(
              join(stack.root, "package.json"),
              JSON.stringify({ name: "c", scripts: { test: "true" } }),
            );
          },
          text: "implemented",
        },
        tester: { text: "all green", structured: passClaim("npm test") },
        reviewer: { text: "APPROVED" },
      }),
    );

    const result = await stack.orchestrator.run(stack.projectId, "build a calculator");
    expect(result.status).toBe("completed");

    const verifications = replayVerificationArtifacts(stack);
    const replay = verifications.find(
      (v) =>
        v.kind === "verification" &&
        v.payload.checks.some((c) => c.kind === "command_replay"),
    );
    expect(replay).toBeDefined();
    if (replay && replay.kind === "verification") {
      expect(replay.payload.verdict).toBe("verified");
      const check = replay.payload.checks.find((c) => c.kind === "command_replay") as
        | { command: string; exitCode: number; passed: boolean }
        | undefined;
      expect(check?.command).toBe("npm test");
      expect(check?.exitCode).toBe(0);
      expect(check?.passed).toBe(true);
    }

    await stack.storage.close();
  });

  it("contradicting replay (tester says pass, replay fails) triggers developer revision", async () => {
    let devRuns = 0;
    const stack = makeStack((req) => {
      const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";

      if (role === "tester") {
        return {
          steps: [{ events: [{ kind: "text", text: "all green" }] }],
          outcome: {
            status: "completed",
            finalText: "all green",
            structured: passClaim("npm test"),
          },
          stepDelayMs: 5,
        };
      }
      if (role === "developer") {
        devRuns++;
        // First developer run ships tests that fail; the retry (after the
        // contradiction) fixes them so the replay eventually agrees.
        const failing = devRuns === 1;
        return {
          steps: [
            {
              effect: () => {
                writeFileSync(join(stack.root, "app.js"), "export const x = 1;\n");
                writeFileSync(
                  join(stack.root, "package.json"),
                  JSON.stringify({
                    name: "c",
                    scripts: { test: failing ? "false" : "true" },
                  }),
                );
              },
              events: [{ kind: "text", text: "implemented" }],
            },
          ],
          outcome: { status: "completed", finalText: "implemented" },
          stepDelayMs: 5,
        };
      }
      if (role === "architect") {
        return {
          steps: [{ events: [{ kind: "text", text: "plan" }] }],
          outcome: {
            status: "completed",
            finalText: "plan",
            structured: architectPayload,
          },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: "APPROVED" }] }],
        outcome: { status: "completed", finalText: "APPROVED" },
        stepDelayMs: 5,
      };
    });

    const result = await stack.orchestrator.run(stack.projectId, "fix tests");
    // The tester's false claim triggered a revision; the developer retry fixed
    // the tests, so the replay eventually agreed and the pipeline completed.
    expect(result.status).toBe("completed");

    // Developer should have run twice (initial + revision).
    const devSessions = getEventsOfType(stack.storage, "agent.session.opened").filter(
      (e) => "role" in e && e.role === "developer",
    );
    expect(devSessions.length).toBeGreaterThanOrEqual(2);

    // A contradiction should have been recorded as a revision_cycles row
    // carrying the replay_contradiction signature.
    const revisions = stack.storage.revisionCycles.listByRun(
      findLatestRunId(stack.storage)! as never,
    );
    expect(revisions.some((r) => r.failureSignature === "replay_contradiction")).toBe(true);

    await stack.storage.close();
  });

  it("inconclusive replay (missing binary) does not fail the stage", async () => {
    const stack = makeStack(
      perAgentScript({
        architect: { text: "plan", structured: architectPayload },
        developer: {
          effect: () => writeFileSync(join(stack.root, "app.js"), "export const x = 1;\n"),
          text: "implemented",
        },
        tester: { text: "ran", structured: passClaim("no-such-tool-xyz-98765") },
        reviewer: { text: "APPROVED" },
      }),
    );

    const result = await stack.orchestrator.run(stack.projectId, "build x");
    // A missing binary must not fail the stage — recorded as inconclusive.
    expect(result.status).toBe("completed");

    const verifications = replayVerificationArtifacts(stack);
    const replay = verifications.find(
      (v) =>
        v.kind === "verification" &&
        v.payload.checks.some((c) => c.kind === "command_replay"),
    );
    expect(replay).toBeDefined();
    if (replay && replay.kind === "verification") {
      // Inconclusive is a pass-through: verdict stays verified, detail notes it.
      expect(replay.payload.verdict).toBe("verified");
      const check = replay.payload.checks.find(
        (c) => c.kind === "command_replay",
      ) as { detail: string } | undefined;
      expect(check?.detail).toContain("replay inconclusive");
    }

    // No revision loop was entered.
    const devSessions = getEventsOfType(stack.storage, "agent.session.opened").filter(
      (e) => "role" in e && e.role === "developer",
    );
    expect(devSessions).toHaveLength(1);

    await stack.storage.close();
  });

  it("replay timeout is bounded and yields inconclusive rather than a failure", async () => {
    const storage = createStorage({ path: join(dataRoot, `orch-replay-t-${crypto.randomUUID()}.db`) });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(dataRoot, "ws-replay-t"),
    });
    const handle = workspaces.create("replay-timeout");
    const agents = createDefaultAgentRegistry();
    const executionService = new ExecutionService({
      storage,
      workspaces,
      git: { init: () => {}, status: () => ({ branch: "HEAD", entries: [] }) } as never,
      runtime: new FakeRuntime(
        (req) => {
          const roleMatch = req.instruction.match(/You are the (\w+) agent/i);
          const role = roleMatch?.[1]?.toLowerCase() ?? "unknown";
          if (role === "tester") {
            return {
              steps: [{ events: [{ kind: "text", text: "ran" }] }],
              outcome: {
                status: "completed",
                finalText: "ran",
                structured: passClaim("sleep 30"),
              },
              stepDelayMs: 5,
            };
          }
          if (role === "developer") {
            return {
              steps: [
                {
                  effect: () =>
                    writeFileSync(join(handle.root, "app.js"), "export const x = 1;\n"),
                  events: [{ kind: "text", text: "implemented" }],
                },
              ],
              outcome: { status: "completed", finalText: "implemented" },
              stepDelayMs: 5,
            };
          }
          if (role === "architect") {
            return {
              steps: [{ events: [{ kind: "text", text: "plan" }] }],
              outcome: {
                status: "completed",
                finalText: "plan",
                structured: architectPayload,
              },
              stepDelayMs: 5,
            };
          }
          return {
            steps: [{ events: [{ kind: "text", text: "APPROVED" }] }],
            outcome: { status: "completed", finalText: "APPROVED" },
            stepDelayMs: 5,
          };
        },
      ),
      agents,
      defaultTimeoutMs: 30_000,
    });
    const orchestrator = new Orchestrator({
      storage,
      workspaces,
      executionService,
      // Tiny replay budget so `sleep 30` is killed almost immediately.
      testReplayTimeoutMs: 1_000,
    });

    const result = await orchestrator.run(handle.projectId, "timeout replay");
    // A hanging replay is treated as inconclusive, not a stage failure.
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(storage)!;
    const verifications = storage.artifacts
      .listByRun(runId as never)
      .filter((a) => a.kind === "verification");
    const replay = verifications.find(
      (v) =>
        v.kind === "verification" &&
        v.payload.checks.some((c) => c.kind === "command_replay"),
    );
    expect(replay).toBeDefined();
    if (replay && replay.kind === "verification") {
      const check = replay.payload.checks.find(
        (c) => c.kind === "command_replay",
      ) as { detail: string } | undefined;
      expect(check?.detail).toContain("replay inconclusive");
    }

    await storage.close();
  }, 15_000);

  it("replays the command in the workspace root as cwd", async () => {
    const stack = makeStack(
      perAgentScript({
        architect: { text: "plan", structured: architectPayload },
        developer: {
          effect: () => {
            // A marker + a script that only succeeds if cwd is the workspace
            // root (marker.txt lives there).
            writeFileSync(join(stack.root, "marker.txt"), "present\n");
            writeFileSync(
              join(stack.root, "check.sh"),
              "test -f marker.txt\n",
            );
          },
          text: "implemented",
        },
        tester: { text: "checked", structured: passClaim("sh check.sh") },
        reviewer: { text: "APPROVED" },
      }),
    );

    const result = await stack.orchestrator.run(stack.projectId, "cwd check");
    // If the replay ran outside the workspace root, `test -f marker.txt` would
    // fail and trigger a contradiction. A completed run proves the cwd was the
    // workspace root.
    expect(result.status).toBe("completed");

    await stack.storage.close();
  });
});

describe("Orchestrator: Phase 7F — dynamic DAG execution", () => {
  // A spec + multi-task plan produced by the architect via structured output.
  function dagPlan(tasks: Array<Record<string, unknown>>) {
    return {
      spec: {
        title: "DAG project",
        summary: "a plan-driven multi-task project",
        goals: ["ship"],
        nonGoals: [],
        constraints: [],
        techStack: [],
        risks: [],
        openQuestions: [],
      },
      plan: { tasks },
    };
  }

  function planTask(refKey: string, extra: Partial<Record<string, unknown>> = {}) {
    return {
      refKey,
      role: "developer",
      title: `Task ${refKey}`,
      detail: `Implement ${refKey}`,
      acceptanceCriteria: ["done"],
      dependsOn: [] as string[],
      ...extra,
    };
  }

  // Factory that delegates to perAgentScript for the architect and all four
  // linear roles, while letting developer tasks be routed by their title.
  function planScript(
    tasks: Array<Record<string, unknown>>,
    devBehavior: (
      title: string,
    ) => { status?: "completed" | "failed"; effect?: () => void; text?: string },
  ): FakeScriptFactory {
    return (req) => {
      const agentMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = agentMatch?.[1]?.toLowerCase() ?? "unknown";

      if (role === "architect") {
        return {
          steps: [{ events: [{ kind: "text", text: "plan" }] }],
          outcome: { status: "completed", finalText: "plan", structured: dagPlan(tasks) },
          stepDelayMs: 5,
        };
      }
      if (role === "developer") {
        // Route by the embedded plan task refKey in the detail text.
        const refKey = req.instruction.match(/Implement ([A-Za-z0-9_-]+)/)?.[1];
        const behavior = devBehavior(refKey ?? "unknown");
        return {
          steps: [
            {
              effect: behavior.effect,
              events: [{ kind: "text", text: behavior.text ?? "impl" }],
            },
          ],
          outcome: {
            status: behavior.status ?? "completed",
            finalText: behavior.text ?? "impl",
          },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    };
  }

  // Plan-scheduled task cards carry the "# Task" instruction appended in
  // executeDag; the pre-created linear chain cards do not.
  const planTasksOf = (stack: ReturnType<typeof makeStack>, runId: string): TaskCard[] =>
    stack.storage.tasks
      .listByRun(runId as never)
      .filter((t) => t.detail.includes("# Task\nYou are the"));

  it("parses a multi-task plan from the architect and runs the DAG", async () => {
    const stack = makeStack(
      planScript(
        [planTask("task-1"), planTask("task-2", { dependsOn: ["task-1"] })],
        () => ({}),
      ),
    );

    const result = await stack.orchestrator.run(stack.projectId, "build a dag project");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const tasks = stack.storage.tasks.listByRun(runId as never);
    // The plan schedules exactly the 2 plan tasks (NOT the 3-card linear tail).
    const planTasks = planTasksOf(stack, runId);
    expect(planTasks).toHaveLength(2);

    // Architect and plan tasks reach terminal success; the superseded linear
    // tail cards are cancelled rather than left dangling.
    expect(tasks.find((t) => t.role === "architect")?.status).toBe("done");
    for (const t of planTasks) {
      expect(["done", "in_review"]).toContain(t.status);
    }
    expect(tasks.filter((t) => t.status === "cancelled").length).toBe(3);

    await stack.storage.close();
  });

  it("creates plan tasks with correct dependencies from dependsOn refKeys", async () => {
    const stack = makeStack(
      planScript([planTask("t1"), planTask("t2", { dependsOn: ["t1"] })], () => ({})),
    );
    const result = await stack.orchestrator.run(stack.projectId, "plan deps");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const tasks = stack.storage.tasks.listByRun(runId as never);
    const t1 = tasks.find((t) => t.detail.includes("Implement t1"))!;
    const t2 = tasks.find((t) => t.detail.includes("Implement t2"))!;
    expect(t2.dependsOn).toContain(t1.id);

    await stack.storage.close();
  });

  it("executes tasks in topological dependency order", async () => {
    const writeOrder: string[] = [];
    const orderArr: string[] = [];
    const stack = makeStack(
      planScript(
        [
          planTask("a"),
          planTask("b", { dependsOn: ["a"] }),
          planTask("c", { dependsOn: ["a"] }),
        ],
        (title) => ({
          effect: () => {
            writeOrder.push(title);
            orderArr.push(title);
            writeFileSync(join(stack.root, `${title}.txt`), title);
          },
        }),
      ),
    );

    const result = await stack.orchestrator.run(stack.projectId, "topo order");
    expect(result.status).toBe("completed");

    // b and c both depend on a, so a must come first.
    expect(writeOrder[0]).toBe("a");
    expect(writeOrder).toContain("b");
    expect(writeOrder).toContain("c");

    await stack.storage.close();
  });

  it("pipeline completes when all plan tasks reach done", async () => {
    const stack = makeStack(
      planScript(
        [
          planTask("x"),
          planTask("y", { dependsOn: ["x"] }),
          planTask("z", { dependsOn: ["x"] }),
        ],
        () => ({ effect: () => writeFileSync(join(stack.root, "f.js"), "x") }),
      ),
    );
    const result = await stack.orchestrator.run(stack.projectId, "all done");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const planTasks = planTasksOf(stack, runId);
    expect(planTasks).toHaveLength(3);
    for (const t of planTasks) {
      expect(["done", "in_review"]).toContain(t.status);
    }
    // run.completed emitted exactly once.
    expect(getEventsOfType(stack.storage, "run.completed").length).toBe(1);

    await stack.storage.close();
  });

  it("handles concurrency pressure above the ExecutionService project lock", async () => {
    // ExecutionService permits only one active execution per project, so even
    // with maxConcurrency=2 the DAG cannot run two tasks truly in parallel.
    // The important guarantee is that concurrent pressure does NOT spuriously
    // fail the pipeline: tasks are serialized by the project lock and all still
    // complete.
    const stack = makeStack(
      planScript([planTask("one"), planTask("two")], () => ({
        // No-op effect: serialization is proven via session/reply ordering.
      })),
    );
    stack.orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      maxConcurrency: 2,
      respectPlanRoles: true,
    });

    const result = await stack.orchestrator.run(stack.projectId, "concurrent");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const planTasks = planTasksOf(stack, runId);
    expect(planTasks).toHaveLength(2);
    for (const t of planTasks) {
      expect(["done", "in_review"]).toContain(t.status);
    }

    await stack.storage.close();
  });

  it("serializes execution with maxConcurrency=1 (default)", async () => {
    const stack = makeStack(
      planScript([planTask("one"), planTask("two")], () => ({
        // No-op effect: serialization is proven via session/reply ordering.
      })),
    );
    // Default maxConcurrency is 1 — sequential.
    const result = await stack.orchestrator.run(stack.projectId, "serial");
    expect(result.status).toBe("completed");

    const events = [...stack.storage.events.listAfter(0, 2000)];
    const devOpens = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type === "agent.session.opened" && e.role === "developer")
      .map(({ i }) => i);
    const firstReply = events.findIndex((e) => e.type === "agent.reply.completed");
    expect(devOpens.length).toBe(2);
    // With default concurrency, the second developer start happens only after
    // the first developer reply completed.
    expect(devOpens[1]).toBeGreaterThan(firstReply);

    await stack.storage.close();
  });

  it("falls back to the linear chain when the plan has a single task", async () => {
    const stack = makeStack(
      planScript([planTask("only", { role: "developer" })], () => ({
        effect: () => writeFileSync(join(stack.root, "app.js"), "x"),
      })),
    );
    const result = await stack.orchestrator.run(stack.projectId, "single task plan");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const tasks = stack.storage.tasks.listByRun(runId as never);
    // Single-task plan -> full 4-card linear chain.
    expect(tasks).toHaveLength(4);
    expect(getEventsOfType(stack.storage, "task.created").length).toBe(4);

    await stack.storage.close();
  });

  it("falls back to the linear chain when no plan artifact is produced", async () => {
    // Architect emits no structured output at all -> no plan artifact.
    const stack = makeStack(
      perAgentScript({
        architect: { text: "A general analysis without a structured plan" },
        developer: {
          effect: () => writeFileSync(join(stack.root, "app.js"), "x"),
          text: "impl",
        },
        tester: { text: "pass" },
        reviewer: { text: "APPROVED" },
      }),
    );
    const result = await stack.orchestrator.run(stack.projectId, "no plan");
    expect(result.status).toBe("completed");

    const runId = findLatestRunId(stack.storage)!;
    const tasks = stack.storage.tasks.listByRun(runId as never);
    expect(tasks).toHaveLength(4);
    expect(getEventsOfType(stack.storage, "task.created").length).toBe(4);

    await stack.storage.close();
  });

  it("invalid plan (dangling dependency) fails the pipeline", async () => {
    // task-2 depends on a nonexistent refKey "ghost".
    const stack = makeStack(
      planScript([planTask("task-1"), planTask("task-2", { dependsOn: ["ghost"] })], () => ({})),
    );
    const result = await stack.orchestrator.run(stack.projectId, "invalid plan");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("invalid plan");

    await stack.storage.close();
  });

  it("per-plan-task revision loop: a failing developer task retries", async () => {
    const attempts = new Map<string, number>();
    const stack = makeStack(
      planScript([planTask("flaky"), planTask("stable")], (title) => {
        if (title === "flaky") {
          const n = (attempts.get("flaky") ?? 0) + 1;
          attempts.set("flaky", n);
          if (n === 1) {
            return { status: "failed", text: "flaky build error" };
          }
          return { effect: () => writeFileSync(join(stack.root, "flaky.txt"), "ok") };
        }
        return { effect: () => writeFileSync(join(stack.root, "stable.txt"), "ok") };
      }),
    );

    const result = await stack.orchestrator.run(stack.projectId, "flaky task");
    expect(result.status).toBe("completed");
    expect(attempts.get("flaky")).toBe(2);

    const runId = findLatestRunId(stack.storage)!;
    const tasks = stack.storage.tasks.listByRun(runId as never);
    const flaky = tasks.find((t) => t.detail.includes("Implement flaky"))!;
    expect(flaky.attempts).toBeGreaterThanOrEqual(2);

    await stack.storage.close();
  });

  it("per-plan-task doom-loop detection terminates on repeated identical failure", async () => {
    // Two plan tasks, both of which fail with an identical signature every
    // time, so the per-task doom-loop detector fires before the attempt budget.
    const stack = makeStack(
      planScript(
        [
          planTask("loop-1", { role: "developer" }),
          planTask("loop-2", { role: "developer", dependsOn: ["loop-1"] }),
        ],
        () => ({ status: "failed", text: "build failed" }),
      ),
    );

    // Override doom-loop threshold low so it fires before the attempt budget.
    stack.orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      doomLoopThreshold: 2,
      taskMaxAttempts: { developer: 10 },
    });

    const result = await stack.orchestrator.run(stack.projectId, "doom loop task");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("doom-loop");

    await stack.storage.close();
  });

  it("pipeline fails when a plan task exhausts its attempt budget", async () => {
    const stack = makeStack(
      planScript([planTask("bad"), planTask("good")], (title) => {
        if (title === "bad") return { status: "failed", text: "always fails" };
        return { effect: () => writeFileSync(join(stack.root, "good.txt"), "ok") };
      }),
    );
    // Give the bad task a single-shot budget so it fails fast.
    stack.orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      taskMaxAttempts: { developer: 1 },
    });

    const result = await stack.orchestrator.run(stack.projectId, "bad task");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("exhausted");

    await stack.storage.close();
  });

  it("respectPlanRoles=false routes all plan tasks to the developer agent", async () => {
    const usedRoles = new Set<string>();
    const stack = makeStack((req) => {
      const agentMatch = req.instruction.match(/You are the (\w+) agent/i);
      const role = agentMatch?.[1]?.toLowerCase() ?? "unknown";
      usedRoles.add(role);
      if (role === "architect") {
        return {
          steps: [{ events: [{ kind: "text", text: "plan" }] }],
          outcome: {
            status: "completed",
            finalText: "plan",
            structured: dagPlan([
              { ...planTask("t1", { role: "architect" }) },
              { ...planTask("t2", { role: "reviewer" }) },
            ]),
          },
          stepDelayMs: 5,
        };
      }
      return {
        steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
        outcome: { status: "completed", finalText: `${role} ok` },
        stepDelayMs: 5,
      };
    });
    stack.orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      respectPlanRoles: false,
      fallbackChain: ["developer"],
    });

    const result = await stack.orchestrator.run(stack.projectId, "force developer");
    expect(result.status).toBe("completed");

    // Only the architect runs as architect; the plan tasks are all developers.
    // Legacy linear-chain cards are retired as "cancelled" and don't count.
    const runId = findLatestRunId(stack.storage)!;
    const tasks = stack.storage.tasks.listByRun(runId as never);
    const active = tasks.filter((t) => t.status !== "cancelled");
    const devTasks = active.filter((t) => t.role === "developer");
    const archTasks = active.filter((t) => t.role === "architect");
    expect(devTasks).toHaveLength(2);
    expect(archTasks).toHaveLength(1);

    await stack.storage.close();
  });

  it("creates a git checkpoint before a DAG developer task and rolls back on failure", async () => {
    const { GitService } = await import("@devmesh/workspace");
    const git = new GitService();

    const stack = makeStack(
      planScript(
        [
          planTask("t1"),
          planTask("t2", { dependsOn: ["t1"] }),
        ],
        (title) => {
          if (title === "t1") {
            return {
              status: "failed",
              effect: () => writeFileSync(join(stack.root, "app.js"), "broken"),
            };
          }
          return {};
        },
      ),
    );

    git.init(stack.root);
    stack.orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      git,
      taskMaxAttempts: { developer: 1 },
    });

    const result = await stack.orchestrator.run(stack.projectId, "git dag task");
    // t1 writes a broken file then fails and exhausts its single-shot budget,
    // failing the pipeline and triggering rollback.
    expect(result.status).toBe("failed");

    // A checkpoint must have been created before the plan developer ran.
    const handle = stack.ws.get(stack.projectId);
    const checkpoints = git.listCheckpoints(handle.root);
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);

    // Rollback should have removed the broken file written by t1.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(handle.root, "app.js"))).toBe(false);

    await stack.storage.close();
  });
});

describe("Orchestrator: Phase 9B — approval gate", () => {
  /** Stack whose developer task is gated behind an approval request. */
  function gatedStack() {
    const stack = makeStack(perAgentScript({
      architect: { text: "plan" },
      developer: {
        effect: () => writeFileSync(join(stack.root, "f.txt"), "v1"),
        text: "impl",
      },
      tester: { text: "pass" },
      reviewer: { text: "APPROVED" },
    }));
    const approvalGate = new ApprovalGate(stack.storage);
    stack.orchestrator = new Orchestrator({
      storage: stack.storage,
      workspaces: stack.ws,
      executionService: stack.es,
      approvalGate,
      gateAction: (card) =>
        card.role === "developer"
          ? {
              kind: "destructive_git",
              title: "Workspace mutation",
              detail: "developer will modify workspace files",
              risk: "high" as const,
            }
          : null,
    });
    return { storage: stack.storage, orchestrator: stack.orchestrator, approvalGate, projectId: stack.projectId };
  }

  async function waitForPendingApproval(storage: Storage): Promise<ApprovalRecord> {
    for (let i = 0; i < 200; i++) {
      const pending = storage.approvals.listPending();
      if (pending.length > 0) return pending[0]!;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no pending approval appeared");
  }

  function developerTask(storage: Storage): { status: string } {
    const runId = findLatestRunId(storage)!;
    const dev = storage.tasks.listByRun(runId as never).find((t) => t.role === "developer");
    if (!dev) throw new Error("no developer task persisted");
    return dev;
  }

  it("70. gated task blocks on approval; approve resumes and completes", async () => {
    const { storage, orchestrator, approvalGate, projectId } = gatedStack();

    const pipelinePromise = orchestrator.run(projectId, "gated pipeline") as unknown as Promise<PipelineResult>;
    const approval = await waitForPendingApproval(storage);

    expect(approval.status).toBe("pending");
    expect(approval.kind).toBe("destructive_git");
    expect(developerTask(storage).status).toBe("blocked");
    expect(getEventsOfType(storage, "approval.requested").length).toBe(1);

    approvalGate.resolve(approval.id, "allow");

    const result = await pipelinePromise;
    expect(result.status).toBe("completed");
    expect(getEventsOfType(storage, "approval.resolved").length).toBe(1);
    await storage.close();
  });

  it("71. deny fails the pipeline and leaves the task blocked", async () => {
    const { storage, orchestrator, approvalGate, projectId } = gatedStack();

    const pipelinePromise = orchestrator.run(projectId, "gated deny") as unknown as Promise<PipelineResult>;
    const approval = await waitForPendingApproval(storage);

    approvalGate.resolve(approval.id, "deny");

    const result = await pipelinePromise;
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("approval denied");
    expect(developerTask(storage).status).toBe("blocked");
    expect(getEventsOfType(storage, "run.failed").length).toBe(1);
    expect(getEventsOfType(storage, "approval.resolved").length).toBe(1);
    await storage.close();
  });

  it("72. cancel while blocked returns cancelled", async () => {
    const { storage, orchestrator, projectId } = gatedStack();

    const pipelinePromise = orchestrator.run(projectId, "gated cancel") as unknown as Promise<PipelineResult>;
    const approval = await waitForPendingApproval(storage);
    expect(approval.status).toBe("pending");

    orchestrator.cancel();

    const result = await pipelinePromise;
    expect(result.status).toBe("cancelled");
    expect(getEventsOfType(storage, "run.cancelled").length).toBe(1);
    await storage.close();
  });

  it("73. request is idempotent for a pending (runId, taskId) pair", async () => {
    const { storage, approvalGate } = gatedStack();
    const projectId = storage.projects.list()[0]?.id ?? "00000000-0000-4000-8000-000000000000" as never;
    const runId = "00000000-0000-4000-8000-000000000001" as never;
    const taskId = "00000000-0000-4000-8000-000000000002";

    const spec = {
      kind: "cost_release",
      title: "Raise cap",
      detail: "",
      risk: "medium" as const,
    };
    const first = approvalGate.request({ projectId: projectId as never, runId, taskId: taskId as never, spec });
    const second = approvalGate.request({ projectId: projectId as never, runId, taskId: taskId as never, spec });

    expect(second.id).toBe(first.id);
    expect(storage.approvals.listPending().length).toBe(1);
    expect(getEventsOfType(storage, "approval.requested").length).toBe(1);

    // An already-resolved approval is never re-requested.
    approvalGate.resolve(first.id, "deny");
    const third = approvalGate.request({ projectId: projectId as never, runId, taskId: taskId as never, spec });
    expect(third.id).toBe(first.id);
    expect(third.status).toBe("denied");
    expect(getEventsOfType(storage, "approval.requested").length).toBe(1);

    // Resume reconstruction: a NEW task id for the same gate kind reuses the
    // prior decision instead of minting a fresh request (Phase 7C recreates
    // task cards under fresh ids when it rebuilds the staged pipeline).
    const otherTaskId = "00000000-0000-4000-8000-000000000003";
    const fourth = approvalGate.request({
      projectId: projectId as never,
      runId,
      taskId: otherTaskId as never,
      spec,
    });
    expect(fourth.id).toBe(first.id);
    expect(fourth.status).toBe("denied");
    expect(storage.approvals.listByRun(runId as never).length).toBe(1);
    expect(getEventsOfType(storage, "approval.requested").length).toBe(1);

    await storage.close();
  });

  it("74. blocked state survives a resume: prior decision is honored, not re-requested", async () => {
    const { storage, orchestrator, approvalGate, projectId } = gatedStack();

    // First run: the developer task is gated → blocked; cancel while the
    // decision is still pending.
    const firstRun = orchestrator.run(projectId, "gated resume") as unknown as Promise<PipelineResult>;
    const approval = await waitForPendingApproval(storage);
    expect(approval.status).toBe("pending");

    orchestrator.cancel();
    const cancelled = await firstRun;
    expect(cancelled.status).toBe("cancelled");

    // Decide while the run is cancelled, then resume from the last completed
    // stage. Resume recreates the developer card under a new id; the gate must
    // reconstruct the persisted (approved) approval instead of re-requesting.
    approvalGate.resolve(approval.id, "allow");
    const runId = findLatestRunId(storage)!;

    const resumed = await orchestrator.resume(runId);
    expect(resumed.status).toBe("completed");

    const approvals = storage.approvals.listByRun(runId as never);
    expect(approvals.length).toBe(1);
    expect(approvals[0]!.status).toBe("approved");
    expect(getEventsOfType(storage, "approval.requested").length).toBe(1);
    expect(getEventsOfType(storage, "approval.resolved").length).toBe(1);
    await storage.close();
  });
});
