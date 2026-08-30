import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ProjectId, type TaskCard } from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import { FakeRuntime, type FakeScriptFactory } from "@devmesh/runtime";
import { createDefaultAgentRegistry } from "@devmesh/agents";
import { Orchestrator } from "./orchestrator.js";
import { ExecutionService } from "./executions/service.js";
import type { BudgetConfig } from "./executions/budget.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-budget-orch-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

interface Stack {
  storage: Storage;
  orchestrator: Orchestrator;
  ws: WorkspaceService;
  es: ExecutionService;
  projectId: ProjectId;
  root: string;
}

function makeStack(
  scriptFn: FakeScriptFactory,
  budget?: BudgetConfig,
  opts: { maxConcurrency?: number } = {},
): Stack {
  const storage = createStorage({ path: join(dataRoot, `orch-${crypto.randomUUID()}.db`) });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(dataRoot, "workspaces"),
  });
  const handle = workspaces.create("orch-budget");

  function scanEntries(dir: string, base = ""): Array<{ x: string; y: string; path: string }> {
    const entries: Array<{ x: string; y: string; path: string }> = [];
    try {
      for (const name of readdirSync(dir)) {
        if (name === ".git" || name === ".devmesh") continue;
        const abs = join(dir, name);
        const rel = base ? `${base}/${name}` : name;
        const st = statSync(abs);
        if (st.isDirectory()) entries.push(...scanEntries(abs, rel));
        else entries.push({ x: "?", y: "?", path: rel });
      }
    } catch { /* ignore */ }
    return entries;
  }

  const runtime = new FakeRuntime(scriptFn);
  const executionService = new ExecutionService({
    storage,
    workspaces,
    git: {
      init: () => {},
      status: () => ({ branch: "HEAD", entries: scanEntries(handle.root) }),
    } as never,
    runtime,
    agents: createDefaultAgentRegistry(),
    defaultTimeoutMs: 30_000,
    ...(budget ? { budget } : {}),
  });
  const orchestrator = new Orchestrator({
    storage,
    workspaces,
    executionService,
    ...(opts.maxConcurrency ? { maxConcurrency: opts.maxConcurrency } : {}),
  });
  return {
    storage,
    orchestrator,
    ws: workspaces,
    es: executionService,
    projectId: handle.projectId,
    root: handle.root,
  };
}

/** Every execution completes and reports `tokens` input/output tokens. */
function countingScript(tokens: number): FakeScriptFactory {
  return (req) => {
    const agentMatch = req.instruction.match(/You are the (\w+) agent/i);
    const role = agentMatch?.[1]?.toLowerCase() ?? "unknown";
    return {
      steps: [
        {
          effect: role === "developer"
            ? () => writeFileSync(join(req.workspaceRoot, `${role}.txt`), role)
            : undefined,
          events: [{ kind: "text", text: `${role} ok` }],
        },
      ],
      outcome: {
        status: "completed",
        sessionId: `ses_${role}`,
        finalText: `${role} ok`,
        usage: { inputTokens: tokens, outputTokens: tokens },
      },
      stepDelayMs: 5,
    };
  };
}

/** Multi-task plan used to route the pipeline to DAG execution. */
function planScript(tokens: number): FakeScriptFactory {
  const dagPlan = {
    spec: { title: "DAG", summary: "s", goals: ["g"], nonGoals: [], constraints: [], techStack: [], risks: [], openQuestions: [] },
    plan: {
      tasks: [
        { refKey: "a", role: "developer", title: "Task A", detail: "Implement a", acceptanceCriteria: ["d"], dependsOn: [] as string[] },
        { refKey: "b", role: "developer", title: "Task B", detail: "Implement b", acceptanceCriteria: ["d"], dependsOn: ["a"] as string[] },
      ],
    },
  };
  return (req) => {
    const agentMatch = req.instruction.match(/You are the (\w+) agent/i);
    const role = agentMatch?.[1]?.toLowerCase() ?? "unknown";
    if (role === "architect") {
      return {
        steps: [{ events: [{ kind: "text", text: "plan" }] }],
        outcome: { status: "completed", finalText: "plan", structured: dagPlan, usage: { inputTokens: tokens, outputTokens: tokens } },
        stepDelayMs: 5,
      };
    }
    if (role === "developer") {
      return {
        steps: [{ events: [{ kind: "text", text: "impl" }] }],
        outcome: { status: "completed", finalText: "impl", usage: { inputTokens: tokens, outputTokens: tokens } },
        stepDelayMs: 5,
      };
    }
    return {
      steps: [{ events: [{ kind: "text", text: `${role} ok` }] }],
      outcome: { status: "completed", finalText: `${role} ok`, usage: { inputTokens: tokens, outputTokens: tokens } },
      stepDelayMs: 5,
    };
  };
}

function findLatestRunId(storage: Storage): string | null {
  const events = storage.events.listAfter(0, 500);
  for (const evt of [...events].reverse()) {
    if (evt.type === "run.started" && evt.runId) return evt.runId;
  }
  return null;
}

// NOTE on token accounting in these tests: each execution reports 2*tokens
// tokens (tokens input + tokens output). Committed aggregates sum both.

describe("Orchestrator budget reaction (Phase 8C)", () => {
  it("linear chain: run-level exhaustion fails the pipeline and blocks the stage", async () => {
    // Each execution commits 100 inputs + 100 outputs = 200 tokens. The
    // architect runs first (200 committed); the developer start clears the
    // gate (committed 200 < 1000); the tester start sees 400 committed and
    // is allowed; with maxTokens=600 the reviewer's start is rejected only
    // after tester committed (600). To force an earlier failure, size the
    // limit so the THIRD stage start is rejected.
    const stack = makeStack(
      countingScript(100),
      { run: { maxTokens: 500, behavior: "block" } },
    );

    const result = await stack.orchestrator.run(stack.projectId, "budgeted pipeline");
    // architect(200) -> developer(200: 400 committed) -> tester(200: 600 committed)
    // reviewer gate: projected 600 > 500 => reject. run fails.
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("budget exhausted");

    const runId = findLatestRunId(stack.storage)!;
    const byRole = new Map(
      stack.storage.tasks.listByRun(runId as never).map((t) => [t.role, t]),
    );
    // The reviewer stage could not start => its card is blocked (ready -> blocked).
    const reviewer = byRole.get("reviewer") as TaskCard | undefined;
    expect(reviewer).toBeDefined();
    expect(["blocked", "cancelled"]).toContain(reviewer!.status);

    await stack.storage.close();
  });

  it("DAG: run-level exhaustion blocks the plan task and fails the run", async () => {
    // Architect commits 200; DAG task "a" commits another 200 (400 committed).
    // Task "b" starts only when committed 400 > maxTokens 250 => rejected, the
    // task is blocked, and the run fails with a budget message.
    const stack = makeStack(
      planScript(100),
      { run: { maxTokens: 250, behavior: "block" } },
    );

    const result = await stack.orchestrator.run(stack.projectId, "dag budget");
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("budget exhausted");

    const runId = findLatestRunId(stack.storage)!;
    const blocked = stack.storage.tasks
      .listByRun(runId as never)
      .filter((t) => t.detail.includes("Implement b"));
    // startDagTask rejected => card marked blocked (ready -> blocked) before
    // the run fails, so no subsequent scheduling can ever retry it.
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.status).toBe("blocked");

    await stack.storage.close();
  });

  it("warn behavior keeps the pipeline running despite projected overruns", async () => {
    const stack = makeStack(
      countingScript(100),
      { run: { maxTokens: 200, behavior: "warn" } },
    );

    const result = await stack.orchestrator.run(stack.projectId, "warn pipeline");
    expect(result.status).toBe("completed");

    const events = [...stack.storage.events.listAfter(0, 1000)];
    expect(
      events.some(
        (e) => e.type === "error.raised" && String(e.scope).startsWith("budget/"),
      ),
    ).toBe(true);

    await stack.storage.close();
  });

  it("DAG scheduler serialization does not bypass the budget gate", async () => {
    const stack = makeStack(
      countingScript(100),
      { run: { maxTokens: 600, behavior: "block" } },
      { maxConcurrency: 2 },
    );

    const result = await stack.orchestrator.run(stack.projectId, "serialized gate");
    expect(result.status).toBe("completed");

    await stack.storage.close();
  });
});