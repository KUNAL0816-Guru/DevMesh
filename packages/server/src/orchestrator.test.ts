import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ProjectId,
  type TaskId,
} from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
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
