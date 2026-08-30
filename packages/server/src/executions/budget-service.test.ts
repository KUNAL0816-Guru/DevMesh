import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeTaskCard,
  newRunId,
  type DomainEvent,
  type ProjectId,
  type TaskCard,
} from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import { FakeRuntime } from "@devmesh/runtime";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-budget-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

type RuntimeFactory = (handle: { projectId: ProjectId; root: string }) => FakeRuntime | null;

function makeStack(runtimeFn: RuntimeFactory, overrides: Partial<Config> = {}) {
  const storage = createStorage({ path: join(dataRoot, `t-${crypto.randomUUID()}.db`) });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(dataRoot, "workspaces"),
  });
  const handle = workspaces.create("budget-test");
  const runtime = runtimeFn ? runtimeFn(handle) : null;
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataRoot,
      logLevel: "error",
      runtime: runtime ? "opencode" : "none",
      opencodeBin: "opencode",
      opencodeAutoApprove: false,
      execTimeoutMs: 30_000,
      ...overrides,
    } as Config,
    storage,
    workspaces,
    runtime,
  });
  return { app, storage, workspaces, handle };
}

/** Completes with a fixed token report (or none when usage is omitted). */
function doneScript(usage?: { inputTokens: number; outputTokens: number }) {
  return {
    steps: [],
    outcome: {
      status: "completed",
      sessionId: "ses_u",
      finalText: "ok",
      exitCode: 0,
      ...(usage ? { usage } : {}),
    },
    stepDelayMs: 5,
  } as never;
}

function taskCard(projectId: ProjectId, runId: ReturnType<typeof newRunId>, maxAttempts = 10): TaskCard {
  return makeTaskCard({
    projectId,
    runId,
    role: "developer",
    status: "ready",
    title: "budget card",
    detail: "budget test",
    acceptanceCriteria: ["file exists"],
    dependsOn: [],
    maxAttempts,
  });
}

async function startExecution(app: { inject: (o: { method: string; url: string; payload: Record<string, unknown> }) => Promise<{ statusCode: number; json: () => { execution?: { id: string }; error?: { code: string; message: string } } }> }, projectId: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: `/projects/${projectId}/executions`, payload: body });
}

async function waitForTerminal(storage: Storage, id: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = storage.executions.get(id);
    if (rec && rec.status !== "running") return rec.status;
    if (Date.now() > deadline) throw new Error(`execution ${id} never finished`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("ExecutionService budget gate (Phase 8C)", () => {
  it("task-level block: rejects a start before the execution is created", async () => {
    const stack = makeStack(() => new FakeRuntime(doneScript({ inputTokens: 10, outputTokens: 10 })), {
      budget: {
        task: { maxTokens: 100, reservationTokens: 300, behavior: "block" },
      },
    });
    const card = taskCard(stack.handle.projectId, newRunId());
    stack.storage.tasks.insert(card);

    const res = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "do it",
      taskId: card.id,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code).toBe("budget/exhausted");

    // Nothing was inserted and nothing started.
    expect(stack.storage.executions.listByProject(stack.handle.projectId)).toHaveLength(0);

    await stack.app.close();
  });

  it("run-level block: a committed over-limit run gates the next task start", async () => {
    const stack = makeStack(
      () => new FakeRuntime(doneScript({ inputTokens: 3_000, outputTokens: 2_000 })),
      {
        budget: { run: { maxTokens: 4_000, behavior: "block" } },
      },
    );
    const runId = newRunId();
    const card1 = taskCard(stack.handle.projectId, runId);
    const card2 = taskCard(stack.handle.projectId, runId);
    stack.storage.tasks.insert(card1);
    stack.storage.tasks.insert(card2);

    const first = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "first",
      taskId: card1.id,
    });
    expect(first.statusCode).toBe(202);
    expect(await waitForTerminal(stack.storage, first.json().execution!.id)).toBe("completed");

    // 5_000 committed tokens in the run scope > 4_000 limit.
    const second = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "second",
      taskId: card2.id,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error?.code).toBe("budget/exhausted");

    await stack.app.close();
  });

  it("unknownUsage=block: rejects once a run contains a committed UNKNOWN-usage execution", async () => {
    const stack = makeStack(
      () => new FakeRuntime(doneScript()),
      {
        budget: { run: { maxTokens: 100_000, unknownUsage: "block" } },
      },
    );
    const runId = newRunId();
    const card1 = taskCard(stack.handle.projectId, runId);
    const card2 = taskCard(stack.handle.projectId, runId);
    stack.storage.tasks.insert(card1);
    stack.storage.tasks.insert(card2);

    const first = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "first",
      taskId: card1.id,
    });
    expect(first.statusCode).toBe(202);
    expect(await waitForTerminal(stack.storage, first.json().execution!.id)).toBe("completed");

    const second = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "second",
      taskId: card2.id,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error?.code).toBe("budget/exhausted");

    await stack.app.close();
  });

  it("warn behavior allows the start and emits a budget warning event", async () => {
    const stack = makeStack(
      () => new FakeRuntime(doneScript({ inputTokens: 3_000, outputTokens: 2_000 })),
      {
        budget: { run: { maxTokens: 4_000, behavior: "warn" } },
      },
    );
    const runId = newRunId();
    const card1 = taskCard(stack.handle.projectId, runId);
    const card2 = taskCard(stack.handle.projectId, runId);
    stack.storage.tasks.insert(card1);
    stack.storage.tasks.insert(card2);

    const first = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "first",
      taskId: card1.id,
    });
    expect(first.statusCode).toBe(202);
    expect(await waitForTerminal(stack.storage, first.json().execution!.id)).toBe("completed");

    // Over the limit but "warn": the start is allowed and a warning is surfaced.
    const second = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "second",
      taskId: card2.id,
    });
    expect(second.statusCode).toBe(202);
    expect(await waitForTerminal(stack.storage, second.json().execution!.id)).toBe("completed");

    const events = [...stack.storage.events.listAfter(0, 500)];
    expect(
      events.some(
        (e) => e.type === "error.raised" && String(e.scope).startsWith("budget/"),
      ),
    ).toBe(true);

    await stack.app.close();
  });

  it("overshoot after completion surfaces as a non-fatal budget concern", async () => {
    const stack = makeStack(
      () => new FakeRuntime(doneScript({ inputTokens: 3_000, outputTokens: 2_000 })),
      {
        budget: { run: { maxTokens: 4_000, behavior: "block" } },
      },
    );

    const first = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "first",
    });
    expect(first.statusCode).toBe(202);
    expect(await waitForTerminal(stack.storage, first.json().execution!.id)).toBe("completed");

    // A direct execution has no pipeline run, so its start was gated against an
    // empty scope; the completion's reconciliation reports the overshoot.
    const events = [...stack.storage.events.listAfter(0, 500)];
    const concerns = events.filter(
      (e): e is Extract<DomainEvent, { type: "error.raised" }> =>
        e.type === "error.raised" && String(e.message).includes("budget concern"),
    );
    expect(concerns.length).toBeGreaterThan(0);
    expect(concerns[0]!.fatal).toBe(false);

    await stack.app.close();
  });

  it("reservations are released on terminal paths (no leak across attempts)", async () => {
    // Tight budget: if the 300-token reservation ever leaked, the committed+
    // reserved projection would reject a later attempt. All five succeed only
    // if every previous reservation was released.
    const stack = makeStack(
      () => new FakeRuntime(doneScript({ inputTokens: 100, outputTokens: 100 })),
      {
        budget: {
          task: { maxTokens: 2_000, reservationTokens: 300, behavior: "block" },
        },
      },
    );
    const card = taskCard(stack.handle.projectId, newRunId(), /* maxAttempts */ 10);
    stack.storage.tasks.insert(card);

    for (let i = 0; i < 5; i++) {
      const res = await startExecution(stack.app as never, stack.handle.projectId, {
        instruction: "attempt",
        taskId: card.id,
      });
      expect(res.statusCode).toBe(202);
      expect(await waitForTerminal(stack.storage, res.json().execution!.id)).toBe("completed");
    }

    await stack.app.close();
  });
});

describe("ExecutionService derived cost (Phase 8C)", () => {
  it("records derived integer cost when pricing matches the configured model", async () => {
    const stack = makeStack(
      () => new FakeRuntime(doneScript({ inputTokens: 1_000_000, outputTokens: 500_000 })),
      {
        opencodeModel: "anthropic/claude-sonnet-4",
        pricing: [
          {
            model: "anthropic/claude-sonnet-4",
            inputUsdPerMillionTokens: 3,
            outputUsdPerMillionTokens: 15,
          },
        ],
      },
    );

    const res = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "cost me",
    });
    expect(res.statusCode).toBe(202);
    expect(await waitForTerminal(stack.storage, res.json().execution!.id)).toBe("completed");

    const row = stack.storage.executions.get(res.json().execution!.id)!;
    expect(row.usage).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      costUsdMicros: 10_500_000,
      currency: "USD",
      usageSource: "derived",
    });

    await stack.app.close();
  });

  it("keeps cost NULL when no pricing is configured (pre-8C behavior)", async () => {
    const stack = makeStack(() => new FakeRuntime(doneScript({ inputTokens: 10, outputTokens: 5 })));

    const res = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "free",
    });
    expect(res.statusCode).toBe(202);
    expect(await waitForTerminal(stack.storage, res.json().execution!.id)).toBe("completed");

    const row = stack.storage.executions.get(res.json().execution!.id)!;
    expect(row.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      costUsdMicros: null,
      currency: null,
      usageSource: null,
    });

    await stack.app.close();
  });

  it("keeps cost NULL when no pricing rule matches the model", async () => {
    const stack = makeStack(
      () => new FakeRuntime(doneScript({ inputTokens: 10, outputTokens: 5 })),
      {
        opencodeModel: "openai/gpt-4o",
        pricing: [
          { model: "anthropic/other", inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
        ],
      },
    );

    const res = await startExecution(stack.app as never, stack.handle.projectId, {
      instruction: "x",
    });
    expect(res.statusCode).toBe(202);
    expect(await waitForTerminal(stack.storage, res.json().execution!.id)).toBe("completed");

    const row = stack.storage.executions.get(res.json().execution!.id)!;
    expect(row.usage?.costUsdMicros).toBeNull();
    expect(row.usage?.usageSource).toBeNull();

    await stack.app.close();
  });
});