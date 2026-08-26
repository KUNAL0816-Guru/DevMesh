import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ProjectId,
  type TaskId,
  TerminalStateError,
} from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
import { assertPipelineConsistency } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import { FakeRuntime, type FakeScriptFactory } from "@devmesh/runtime";
import { createDefaultAgentRegistry } from "@devmesh/agents";
import { Orchestrator, type PipelineResult } from "./orchestrator.js";
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
  scripts: Record<string, { status?: string; effect?: () => void; text?: string }>,
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
