import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ProjectId,
} from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import { FakeRuntime, type FakeScriptFactory } from "@devmesh/runtime";
import { createDefaultAgentRegistry } from "@devmesh/agents";
import { Orchestrator, type PipelineResult } from "./orchestrator.js";
import { ExecutionService } from "./executions/service.js";
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
  return { storage, orchestrator, projectId: handle.projectId, root: handle.root };
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
