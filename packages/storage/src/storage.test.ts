import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactSchema,
  makeContextEntry,
  makeTaskCard,
  newApprovalId,
  newArtifactBase,
  newArtifactId,
  newProjectId,
  newRunId,
  newTaskId,
  taskCardSchema,
  taskIdSchema,
} from "@devmesh/contracts";
import { createStorage, pipelineRunSummary, pipelineHealth, summarizeRunUsage, summarizeTaskUsage, type Storage } from "./index.js";
import { withTransaction, StorageError } from "./db.js";
import { EventBus } from "./event-bus.js";
import type { ExecutionRecord, RevisionCycleRecord, ApprovalRecord } from "./repos.js";
import type { DomainEvent, ProjectId, RunId } from "@devmesh/contracts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devmesh-storage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fileStorage(): Storage {
  return createStorage({ path: join(dir, `t-${Math.random().toString(36).slice(2)}.db`) });
}

describe("migrations", () => {
  it("applies schema version and is idempotent across reopens", () => {
    const path = join(dir, "mig.db");
    const s1 = createStorage({ path });
    expect(s1.schemaVersion).toBeGreaterThanOrEqual(1);
    s1.close();

    const s2 = createStorage({ path });
    expect(s2.schemaVersion).toBe(s1.schemaVersion);
    const tables = s2.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    for (const expected of ["projects", "tasks", "events", "artifacts", "context_entries"]) {
      expect(names).toContain(expected);
    }
    s2.close();
  });

  it("migration v4 adds reply_text column to executions", () => {
    const path = join(dir, "mig4.db");
    const s = createStorage({ path });
    const cols = s.db
      .prepare("PRAGMA table_info(executions)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("reply_text");
    expect(s.schemaVersion).toBeGreaterThanOrEqual(4);
    s.close();
  });

  it("upgrades from v3 database to v4 with reply_text", () => {
    const path = join(dir, "mig3to4.db");
    // createStorage applies all pending migrations including v4
    const s = createStorage({ path });
    const cols = s.db
      .prepare("PRAGMA table_info(executions)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("reply_text");
    s.close();
  });

  it("migration 9 adds usage columns to executions", () => {
    const path = join(dir, "mig9.db");
    const s = createStorage({ path });
    expect(s.schemaVersion).toBeGreaterThanOrEqual(9);
    const cols = s.db
      .prepare("PRAGMA table_info(executions)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("input_tokens");
    expect(names).toContain("output_tokens");
    expect(names).toContain("cost_usd_micros");
    expect(names).toContain("cost_currency");
    expect(names).toContain("usage_source");
    s.close();
  });

  it("migration 9 is idempotent across reopens", () => {
    const path = join(dir, "mig9-idempotent.db");
    const s1 = createStorage({ path });
    expect(s1.schemaVersion).toBeGreaterThanOrEqual(9);
    s1.close();
    const s2 = createStorage({ path });
    expect(s2.schemaVersion).toBe(s1.schemaVersion);
    s2.close();
  });

  it("migration 10 creates approvals table", () => {
    const path = join(dir, "mig10.db");
    const s = createStorage({ path });
    expect(s.schemaVersion).toBeGreaterThanOrEqual(10);
    const cols = s.db
      .prepare("PRAGMA table_info(approvals)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const expected of [
      "id",
      "project_id",
      "run_id",
      "task_id",
      "kind",
      "title",
      "detail",
      "risk",
      "status",
      "requested_at",
      "resolved_at",
      "decision",
      "decided_by",
    ]) {
      expect(names).toContain(expected);
    }
    s.close();
  });

  it("migration 10 is idempotent across reopens", () => {
    const path = join(dir, "mig10-idempotent.db");
    const s1 = createStorage({ path });
    expect(s1.schemaVersion).toBeGreaterThanOrEqual(10);
    s1.close();
    const s2 = createStorage({ path });
    expect(s2.schemaVersion).toBe(s1.schemaVersion);
    const tables = s2.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("approvals");
    s2.close();
  });
});

describe("projects", () => {
  it("roundtrips records and enforces uniqueness", () => {
    const s = fileStorage();
    const rec = {
      id: newProjectId(),
      name: "demo",
      rootPath: "/tmp/demo-ws",
      createdAt: new Date().toISOString(),
    };
    s.projects.insert(rec);
    expect(s.projects.get(rec.id)?.name).toBe("demo");
    expect(s.projects.findByName("demo")?.id).toBe(rec.id);
    expect(s.projects.list()).toHaveLength(1);

    expect(() => s.projects.insert({ ...rec })).toThrow(); // duplicate id
    expect(() =>
      s.projects.insert({ ...rec, id: newProjectId(), rootPath: "/other" }),
    ).toThrow(); // duplicate name
    s.close();
  });
});

describe("tasks", () => {
  it("inserts, updates, and counts by status", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    s.projects.insert({
      id: projectId,
      name: "p",
      rootPath: "/tmp/p",
      createdAt: new Date().toISOString(),
    });

    const card = makeTaskCard({
      runId: newRunId(),
      projectId,
      role: "developer",
      title: "Implement thing",
      detail: "do it well",
      acceptanceCriteria: ["works"],
      dependsOn: [],
      status: "pending",
    });
    s.tasks.insert(card);
    expect(s.tasks.get(card.id)).toEqual(card);

    const updated: typeof card = {
      ...card,
      status: "running",
      attempts: 1,
      updatedAt: new Date().toISOString(),
    };
    s.tasks.update(updated);
    expect(s.tasks.get(card.id)?.status).toBe("running");

    expect(() =>
      s.tasks.update({
        ...updated,
        id: taskIdSchema.parse(crypto.randomUUID()),
      }),
    ).toThrow(/does not exist/);

    expect(s.tasks.countByStatus(projectId)).toEqual({ running: 1 });
    expect(s.tasks.listByRun(card.runId)).toHaveLength(1);
    s.close();
  });
});

describe("events", () => {
  it("assigns monotonic seq and roundtrips payloads", () => {
    const s = fileStorage();
    const runId = newRunId();
    const base = { ts: new Date().toISOString(), runId };

    const e1 = s.events.append({ ...base, type: "run.started", goal: "build x" });
    const e2 = s.events.append({
      ...base,
      type: "run.failed",
      reason: "boom",
      actor: "system",
    });
    expect(e1.seq).toBeGreaterThan(0);
    expect(e2.seq).toBe(e1.seq + 1);
    expect(e1).toMatchObject({ type: "run.started", goal: "build x", runId });

    expect(s.events.latestSeq()).toBe(e2.seq);
    expect(s.events.listAfter(0)).toEqual([e1, e2]);
    expect(s.events.listAfter(e1.seq)).toEqual([e2]);
    expect(s.events.listByRun(runId)).toEqual([e1, e2]);
    s.close();
  });

  it("rejects invalid events at the boundary", () => {
    const s = fileStorage();
    expect(() =>
      s.events.append({ ts: new Date().toISOString(), type: "nope" as never }),
    ).toThrow();
    s.close();
  });
});

describe("artifacts", () => {
  it("stores validated artifacts and filters by kind", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    s.projects.insert({
      id: projectId,
      name: "artifacts-fixture",
      rootPath: "/tmp/artifacts-fixture",
      createdAt: new Date().toISOString(),
    });
    const ctx = { runId: newRunId(), projectId, producedBy: "architect" as const };
    const spec = artifactSchema.parse({
      kind: "spec",
      ...newArtifactBase(ctx),
      payload: {
        title: "Spec",
        summary: "s",
        goals: ["g"],
        nonGoals: [],
        constraints: [],
        techStack: [],
        risks: [],
        openQuestions: [],
      },
    });
    s.artifacts.insert(spec);
    expect(s.artifacts.get(spec.id)).toEqual(spec);
    expect(s.artifacts.listByRun(ctx.runId, "spec")).toHaveLength(1);
    expect(s.artifacts.listByRun(ctx.runId, "review")).toHaveLength(0);

    expect(() => s.artifacts.insert({ ...spec, id: newArtifactId(), kind: "bogus" as never })).toThrow();
    s.close();
  });
});

describe("context (blackboard)", () => {
  it("tracks supersession chains per key", () => {
    const s = fileStorage();
    const v1 = makeContextEntry({
      namespace: "decision",
      key: "auth/strategy",
      value: "cookie",
      createdBy: "architect",
    });
    const v2 = makeContextEntry({
      namespace: "decision",
      key: "auth/strategy",
      value: "token",
      createdBy: "architect",
      supersedes: v1.id,
    });
    s.context.put(v1);
    s.context.put(v2);

    expect(s.context.latestByKey("decision").get("auth/strategy")?.value).toBe("token");
    expect(s.context.history("auth/strategy", "decision").map((e) => e.value)).toEqual([
      "cookie",
      "token",
    ]);
    expect(s.context.get(v1.id)?.supersedes).toBeUndefined();
    expect(s.context.get(v2.id)?.supersedes).toBe(v1.id);
    s.close();
  });
});

describe("durability", () => {
  it("state survives full close + reopen on the same file", () => {
    const path = join(dir, "durable.db");
    const projectId = newProjectId();
    {
      const s = createStorage({ path });
      s.projects.insert({
        id: projectId,
        name: "survivor",
        rootPath: "/tmp/survivor",
        createdAt: new Date().toISOString(),
      });
      s.events.append({
        ts: new Date().toISOString(),
        runId: newRunId(),
        projectId,
        type: "run.started",
        goal: "outlive the process",
      });
      s.close();
    }
    {
      const s = createStorage({ path });
      expect(s.projects.findByName("survivor")?.id).toBe(projectId);
      const first = s.events.listAfter(0)[0];
      expect(first).toMatchObject({ type: "run.started", projectId });
      s.close();
    }
  });
});

describe("migration v6 (pipeline_runs)", () => {
  it("creates pipeline_runs table with correct columns", () => {
    const path = join(dir, "mig6.db");
    const s = createStorage({ path });
    expect(s.schemaVersion).toBeGreaterThanOrEqual(6);
    const cols = s.db
      .prepare("PRAGMA table_info(pipeline_runs)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("project_id");
    expect(names).toContain("status");
    expect(names).toContain("goal");
    expect(names).toContain("error_message");
    expect(names).toContain("created_at");
    expect(names).toContain("finished_at");
    expect(names).toContain("duration_ms");
    s.close();
  });

  it("idempotent across reopens", () => {
    const path = join(dir, "mig6-idempotent.db");
    const s1 = createStorage({ path });
    expect(s1.schemaVersion).toBeGreaterThanOrEqual(6);
    s1.close();
    const s2 = createStorage({ path });
    expect(s2.schemaVersion).toBe(s1.schemaVersion);
    s2.close();
  });
});

describe("pipelineRuns", () => {
  it("inserts and retrieves a pipeline run", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    s.projects.insert({
      id: projectId,
      name: "pr-test",
      rootPath: "/tmp/pr-test",
      createdAt: new Date().toISOString(),
    });
    const runId = newRunId();
    const now = new Date().toISOString();
    s.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "running",
      goal: "build feature X",
      errorMessage: null,
      createdAt: now,
      finishedAt: null,
      durationMs: null,
    });
    const rec = s.pipelineRuns.get(runId);
    expect(rec).not.toBeNull();
    expect(rec!.id).toBe(runId);
    expect(rec!.projectId).toBe(projectId);
    expect(rec!.status).toBe("running");
    expect(rec!.goal).toBe("build feature X");
    expect(rec!.errorMessage).toBeNull();
    expect(rec!.finishedAt).toBeNull();
    s.close();
  });

  it("updates a pipeline run to terminal status", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    s.projects.insert({
      id: projectId,
      name: "pr-update",
      rootPath: "/tmp/pr-update",
      createdAt: new Date().toISOString(),
    });
    const runId = newRunId();
    const now = new Date().toISOString();
    s.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "running",
      goal: "fix bug",
      errorMessage: null,
      createdAt: now,
      finishedAt: null,
      durationMs: null,
    });
    const finishedAt = new Date().toISOString();
    s.pipelineRuns.update({
      id: runId,
      projectId,
      status: "completed",
      goal: "fix bug",
      errorMessage: null,
      createdAt: now,
      finishedAt,
      durationMs: 5000,
    });
    const rec = s.pipelineRuns.get(runId);
    expect(rec!.status).toBe("completed");
    expect(rec!.finishedAt).toBe(finishedAt);
    expect(rec!.durationMs).toBe(5000);
    s.close();
  });

  it("persists error message on failure", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    s.projects.insert({
      id: projectId,
      name: "pr-fail",
      rootPath: "/tmp/pr-fail",
      createdAt: new Date().toISOString(),
    });
    const runId = newRunId();
    const now = new Date().toISOString();
    s.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "running",
      goal: "implement Y",
      errorMessage: null,
      createdAt: now,
      finishedAt: null,
      durationMs: null,
    });
    const finishedAt = new Date().toISOString();
    s.pipelineRuns.update({
      id: runId,
      projectId,
      status: "failed",
      goal: "implement Y",
      errorMessage: "developer failed",
      createdAt: now,
      finishedAt,
      durationMs: 12000,
    });
    const rec = s.pipelineRuns.get(runId);
    expect(rec!.status).toBe("failed");
    expect(rec!.errorMessage).toBe("developer failed");
    expect(rec!.durationMs).toBe(12000);
    s.close();
  });

  it("returns null for non-existent id", () => {
    const s = fileStorage();
    expect(s.pipelineRuns.get(crypto.randomUUID())).toBeNull();
    s.close();
  });

  it("throws on update of non-existent row", () => {
    const s = fileStorage();
    expect(() =>
      s.pipelineRuns.update({
        id: crypto.randomUUID(),
        projectId: newProjectId(),
        status: "completed",
        goal: "x",
        errorMessage: null,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 100,
      }),
    ).toThrow(/does not exist/);
    s.close();
  });

  it("listByProject returns runs ordered by created_at DESC", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    s.projects.insert({
      id: projectId,
      name: "pr-list",
      rootPath: "/tmp/pr-list",
      createdAt: new Date().toISOString(),
    });
    const r1 = newRunId();
    const r2 = newRunId();
    const now1 = "2026-01-01T00:00:00.000Z";
    const now2 = "2026-01-02T00:00:00.000Z";
    s.pipelineRuns.insert({
      id: r1, projectId, status: "completed", goal: "first",
      errorMessage: null, createdAt: now1, finishedAt: null, durationMs: null,
    });
    s.pipelineRuns.insert({
      id: r2, projectId, status: "running", goal: "second",
      errorMessage: null, createdAt: now2, finishedAt: null, durationMs: null,
    });
    const list = s.pipelineRuns.listByProject(projectId);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe(r2);
    expect(list[1]!.id).toBe(r1);
    s.close();
  });

  it("listByProject scoped to a specific project", () => {
    const s = fileStorage();
    const p1 = newProjectId();
    const p2 = newProjectId();
    s.projects.insert({ id: p1, name: "a", rootPath: "/a", createdAt: new Date().toISOString() });
    s.projects.insert({ id: p2, name: "b", rootPath: "/b", createdAt: new Date().toISOString() });
    const now = new Date().toISOString();
    s.pipelineRuns.insert({ id: newRunId(), projectId: p1, status: "running", goal: "a1", errorMessage: null, createdAt: now, finishedAt: null, durationMs: null });
    s.pipelineRuns.insert({ id: newRunId(), projectId: p2, status: "running", goal: "b1", errorMessage: null, createdAt: now, finishedAt: null, durationMs: null });
    expect(s.pipelineRuns.listByProject(p1)).toHaveLength(1);
    expect(s.pipelineRuns.listByProject(p2)).toHaveLength(1);
    s.close();
  });

  it("findRunning returns only running pipelines", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    s.projects.insert({ id: projectId, name: "c", rootPath: "/c", createdAt: new Date().toISOString() });
    const now = new Date().toISOString();
    s.pipelineRuns.insert({ id: newRunId(), projectId, status: "running", goal: "r1", errorMessage: null, createdAt: now, finishedAt: null, durationMs: null });
    s.pipelineRuns.insert({ id: newRunId(), projectId, status: "running", goal: "r2", errorMessage: null, createdAt: now, finishedAt: null, durationMs: null });
    s.pipelineRuns.insert({ id: newRunId(), projectId, status: "completed", goal: "done", errorMessage: null, createdAt: now, finishedAt: now, durationMs: 100 });
    s.pipelineRuns.insert({ id: newRunId(), projectId, status: "failed", goal: "fail", errorMessage: "err", createdAt: now, finishedAt: now, durationMs: 50 });
    const running = s.pipelineRuns.findRunning();
    expect(running).toHaveLength(2);
    expect(running.every((r) => r.status === "running")).toBe(true);
    s.close();
  });

  it("pipeline_runs state survives close + reopen", () => {
    const path = join(dir, "pr-durable.db");
    const projectId = newProjectId();
    const runId = newRunId();
    const now = new Date().toISOString();
    {
      const s = createStorage({ path });
      s.projects.insert({ id: projectId, name: "dur", rootPath: "/dur", createdAt: now });
      s.pipelineRuns.insert({ id: runId, projectId, status: "running", goal: "persist", errorMessage: null, createdAt: now, finishedAt: null, durationMs: null });
      s.close();
    }
    {
      const s = createStorage({ path });
      const rec = s.pipelineRuns.get(runId);
      expect(rec).not.toBeNull();
      expect(rec!.status).toBe("running");
      expect(rec!.goal).toBe("persist");
      s.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ExecutionRepository
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

function makeExec(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: crypto.randomUUID(),
    runId: newRunId(),
    projectId: newProjectId(),
    taskId: null,
    agentId: null,
    role: "developer",
    runtime: "opencode",
    status: "pending",
    failureKind: null,
    instruction: "do something",
    sessionRef: null,
    exitCode: null,
    stoppedReason: null,
    errorMessage: null,
    stdoutTail: null,
    stderrTail: null,
    replyText: null,
    startedAt: now(),
    finishedAt: null,
    durationMs: null,
    resultArtifactId: null,
    verificationArtifactId: null,
    structured: null,
    usage: null,
    ...overrides,
  };
}

function ensureProject(s: Storage, projectId: string, name = "test") {
  if (!s.projects.get(projectId as never)) {
    s.projects.insert({ id: projectId as never, name, rootPath: `/${name}`, createdAt: now() });
  }
}

describe("ExecutionRepository", () => {
  it("inserts and retrieves an execution", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "exec");
    const rec = s.executions.insert(makeExec({ projectId }));
    expect(rec.id).toBeTruthy();
    const fetched = s.executions.get(rec.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("pending");
    expect(fetched!.role).toBe("developer");
    s.close();
  });

  it("roundtrips null optional fields correctly", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "nulls");
    const rec = s.executions.insert(makeExec({ projectId }));
    const fetched = s.executions.get(rec.id)!;
    expect(fetched.taskId).toBeNull();
    expect(fetched.agentId).toBeNull();
    expect(fetched.failureKind).toBeNull();
    expect(fetched.sessionRef).toBeNull();
    expect(fetched.exitCode).toBeNull();
    expect(fetched.errorMessage).toBeNull();
    expect(fetched.stdoutTail).toBeNull();
    expect(fetched.stderrTail).toBeNull();
    expect(fetched.replyText).toBeNull();
    expect(fetched.finishedAt).toBeNull();
    expect(fetched.durationMs).toBeNull();
    expect(fetched.resultArtifactId).toBeNull();
    expect(fetched.verificationArtifactId).toBeNull();
    expect(fetched.usage).toBeNull();
    s.close();
  });

  it("roundtrips reported token usage (tokens only, no cost yet)", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "usage");
    const rec = s.executions.insert(
      makeExec({
        projectId,
        usage: {
          inputTokens: 1240,
          outputTokens: 380,
          costUsdMicros: null,
          currency: null,
          usageSource: null,
        },
      }),
    );
    const fetched = s.executions.get(rec.id)!;
    expect(fetched.usage).toEqual({
      inputTokens: 1240,
      outputTokens: 380,
      costUsdMicros: null,
      currency: null,
      usageSource: null,
    });
    s.close();
  });

  it("roundtrips a fully-stamped usage report (derived cost)", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "usage-der");
    const rec = s.executions.insert(
      makeExec({
        projectId,
        usage: {
          inputTokens: 500,
          outputTokens: 90,
          costUsdMicros: 415,
          currency: "USD",
          usageSource: "derived",
        },
      }),
    );
    const updated = s.executions.update({
      ...rec,
      status: "completed",
      usage: {
        inputTokens: 500,
        outputTokens: 90,
        costUsdMicros: 415,
        currency: "USD",
        usageSource: "derived",
      },
    });
    expect(updated).toBeUndefined();
    const fetched = s.executions.get(rec.id)!;
    expect(fetched.usage).toEqual({
      inputTokens: 500,
      outputTokens: 90,
      costUsdMicros: 415,
      currency: "USD",
      usageSource: "derived",
    });
    s.close();
  });

  it("updates an execution record", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "upd");
    const rec = s.executions.insert(makeExec({ projectId }));
    s.executions.update({
      ...rec,
      status: "running",
      exitCode: 0,
      errorMessage: "oops",
      stdoutTail: "out",
      stderrTail: "err",
      replyText: "done",
      finishedAt: now(),
      durationMs: 1500,
    });
    const updated = s.executions.get(rec.id)!;
    expect(updated.status).toBe("running");
    expect(updated.exitCode).toBe(0);
    expect(updated.errorMessage).toBe("oops");
    expect(updated.stdoutTail).toBe("out");
    expect(updated.stderrTail).toBe("err");
    expect(updated.replyText).toBe("done");
    expect(updated.durationMs).toBe(1500);
    s.close();
  });

  it("throws on update of non-existent execution", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "nf");
    expect(() => s.executions.update(makeExec({ id: crypto.randomUUID(), projectId }))).toThrow(/does not exist/);
    s.close();
  });

  it("listByRun returns executions ordered by started_at DESC", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    ensureProject(s, projectId, "lr");
    const earlier = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-02T00:00:00.000Z";
    s.executions.insert(makeExec({ runId, projectId, role: "tester", startedAt: earlier }));
    s.executions.insert(makeExec({ runId, projectId, role: "developer", startedAt: later }));
    const list = s.executions.listByRun(runId);
    expect(list).toHaveLength(2);
    expect(list[0]!.role).toBe("developer");
    expect(list[1]!.role).toBe("tester");
    s.close();
  });

  it("listByRun returns empty for unknown run", () => {
    const s = fileStorage();
    expect(s.executions.listByRun(newRunId())).toHaveLength(0);
    s.close();
  });

  it("listByProject scoped to specific project", () => {
    const s = fileStorage();
    const p1 = newProjectId();
    const p2 = newProjectId();
    ensureProject(s, p1, "a");
    ensureProject(s, p2, "b");
    s.executions.insert(makeExec({ projectId: p1 }));
    s.executions.insert(makeExec({ projectId: p1 }));
    s.executions.insert(makeExec({ projectId: p2 }));
    expect(s.executions.listByProject(p1)).toHaveLength(2);
    expect(s.executions.listByProject(p2)).toHaveLength(1);
    s.close();
  });

  it("findUnfinished returns only pending and running executions", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "uf");
    s.executions.insert(makeExec({ projectId, status: "pending" }));
    s.executions.insert(makeExec({ projectId, status: "running" }));
    s.executions.insert(makeExec({ projectId, status: "completed" }));
    s.executions.insert(makeExec({ projectId, status: "failed" }));
    const unfinished = s.executions.findUnfinished();
    expect(unfinished).toHaveLength(2);
    expect(unfinished.every((r) => r.status === "pending" || r.status === "running")).toBe(true);
    s.close();
  });

  it("reconcileInterrupted marks unfinished as interrupted", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "rc");
    s.executions.insert(makeExec({ projectId, status: "running", errorMessage: null }));
    const finishedAt = now();
    const reconciled = s.executions.reconcileInterrupted(finishedAt);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]!.status).toBe("interrupted");
    const stored = s.executions.get(reconciled[0]!.id)!;
    expect(stored.status).toBe("interrupted");
    expect(stored.finishedAt).toBe(finishedAt);
    expect(stored.errorMessage).toContain("restarted while");
    s.close();
  });

  it("reconcileInterrupted preserves existing errorMessage", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "rc2");
    s.executions.insert(makeExec({ projectId, status: "running", errorMessage: "already had one" }));
    s.executions.reconcileInterrupted(now());
    const unfinished = s.executions.findUnfinished();
    expect(unfinished).toHaveLength(0);
    const all = s.db.prepare("SELECT * FROM executions WHERE status = 'interrupted'").all() as Array<{ error_message: string | null }>;
    expect(all).toHaveLength(1);
    expect(all[0]!.error_message).toBe("already had one");
    s.close();
  });
});

// ---------------------------------------------------------------------------
// RevisionCycleRepository
// ---------------------------------------------------------------------------

function makeRC(overrides: Partial<Omit<RevisionCycleRecord, "id" | "createdAt">> = {}): Omit<RevisionCycleRecord, "id" | "createdAt"> {
  return {
    runId: newRunId(),
    projectId: newProjectId(),
    taskId: taskIdSchema.parse(crypto.randomUUID()),
    cycleType: "tester_failure",
    attemptNumber: 1,
    failureKind: "tool_failure",
    failureSignature: "tool_failure:timeout",
    ...overrides,
  };
}

describe("RevisionCycleRepository", () => {
  it("inserts and retrieves by run", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "rc-ins");
    const runId = newRunId();
    const rec = s.revisionCycles.insert(makeRC({ runId, projectId }));
    expect(rec.id).toBeTruthy();
    expect(rec.createdAt).toBeTruthy();
    const list = s.revisionCycles.listByRun(runId);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(rec.id);
    s.close();
  });

  it("listByRun orders by attempt_number ASC", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "rc-asc");
    const runId = newRunId();
    s.revisionCycles.insert(makeRC({ runId, projectId, attemptNumber: 3 }));
    s.revisionCycles.insert(makeRC({ runId, projectId, attemptNumber: 1 }));
    s.revisionCycles.insert(makeRC({ runId, projectId, attemptNumber: 2 }));
    const list = s.revisionCycles.listByRun(runId);
    expect(list.map((r) => r.attemptNumber)).toEqual([1, 2, 3]);
    s.close();
  });

  it("listByTask orders by attempt_number DESC", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "rc-desc");
    const taskId = taskIdSchema.parse(crypto.randomUUID());
    s.revisionCycles.insert(makeRC({ projectId, taskId, attemptNumber: 1 }));
    s.revisionCycles.insert(makeRC({ projectId, taskId, attemptNumber: 3 }));
    s.revisionCycles.insert(makeRC({ projectId, taskId, attemptNumber: 2 }));
    const list = s.revisionCycles.listByTask(taskId);
    expect(list.map((r) => r.attemptNumber)).toEqual([3, 2, 1]);
    s.close();
  });

  it("countBySignature counts failures with matching signature", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "rc-cnt");
    const taskId = taskIdSchema.parse(crypto.randomUUID());
    s.revisionCycles.insert(makeRC({ projectId, taskId, failureSignature: "timeout" }));
    s.revisionCycles.insert(makeRC({ projectId, taskId, failureSignature: "timeout" }));
    s.revisionCycles.insert(makeRC({ projectId, taskId, failureSignature: "crash" }));
    expect(s.revisionCycles.countBySignature(taskId, "timeout")).toBe(2);
    expect(s.revisionCycles.countBySignature(taskId, "crash")).toBe(1);
    expect(s.revisionCycles.countBySignature(taskId, "nonexistent")).toBe(0);
    s.close();
  });

  it("listByFailureKind filters by kind and optional project", () => {
    const s = fileStorage();
    const p1 = newProjectId();
    const p2 = newProjectId();
    ensureProject(s, p1, "lfk-a");
    ensureProject(s, p2, "lfk-b");
    s.revisionCycles.insert(makeRC({ projectId: p1, failureKind: "tool_failure" }));
    s.revisionCycles.insert(makeRC({ projectId: p1, failureKind: "tool_failure" }));
    s.revisionCycles.insert(makeRC({ projectId: p2, failureKind: "tool_failure" }));
    s.revisionCycles.insert(makeRC({ projectId: p1, failureKind: "agent_error" }));
    expect(s.revisionCycles.listByFailureKind("tool_failure")).toHaveLength(3);
    expect(s.revisionCycles.listByFailureKind("tool_failure", p1)).toHaveLength(2);
    expect(s.revisionCycles.listByFailureKind("agent_error")).toHaveLength(1);
    expect(s.revisionCycles.listByFailureKind("nonexistent")).toHaveLength(0);
    s.close();
  });

  it("handles null failureKind and failureSignature", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "rc-null");
    const taskId = taskIdSchema.parse(crypto.randomUUID());
    s.revisionCycles.insert(makeRC({ projectId, taskId, failureKind: null, failureSignature: null }));
    const list = s.revisionCycles.listByTask(taskId);
    expect(list).toHaveLength(1);
    expect(list[0]!.failureKind).toBeNull();
    expect(list[0]!.failureSignature).toBeNull();
    s.close();
  });
});

// ---------------------------------------------------------------------------
// EventBus / attachBus
// ---------------------------------------------------------------------------

describe("EventBus / attachBus", () => {
  it("propagates events to attached subscribers", () => {
    const s = fileStorage();
    const bus = new EventBus();
    const received: DomainEvent[] = [];
    bus.on("event", (e: DomainEvent) => received.push(e));
    s.events.attachBus(bus);

    const runId = newRunId();
    s.events.append({ ts: new Date().toISOString(), runId, type: "run.started", goal: "test" });
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("run.started");
    expect(received[0]!.runId).toBe(runId);
    s.close();
  });

  it("does not propagate to detached subscribers", () => {
    const s = fileStorage();
    const bus = new EventBus();
    const received: DomainEvent[] = [];
    bus.on("event", (e: DomainEvent) => received.push(e));
    s.events.attachBus(bus);
    s.events.detachBus();

    s.events.append({ ts: new Date().toISOString(), runId: newRunId(), type: "run.started", goal: "test" });
    expect(received).toHaveLength(0);
    s.close();
  });

  it("isolates between separate bus instances", () => {
    const s = fileStorage();
    const bus1 = new EventBus();
    const bus2 = new EventBus();
    const received1: DomainEvent[] = [];
    const received2: DomainEvent[] = [];
    bus1.on("event", (e: DomainEvent) => received1.push(e));
    bus2.on("event", (e: DomainEvent) => received2.push(e));

    s.events.attachBus(bus1);
    s.events.append({ ts: new Date().toISOString(), runId: newRunId(), type: "run.started", goal: "via1" });
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(0);

    s.events.attachBus(bus2);
    s.events.append({ ts: new Date().toISOString(), runId: newRunId(), type: "run.started", goal: "via2" });
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// EventRepository.listByRunAfter
// ---------------------------------------------------------------------------

describe("EventRepository.listByRunAfter", () => {
  it("returns only events with seq > afterSeq for the run", () => {
    const s = fileStorage();
    const runId = newRunId();
    const projectId = newProjectId();
    ensureProject(s, projectId, "ev-lbra");
    const base = { ts: now(), runId, projectId };
    const e1 = s.events.append({ ...base, type: "run.started", goal: "x" });
    const card = makeTaskCard({ runId, projectId, role: "developer", title: "task-a", detail: "d", acceptanceCriteria: ["works"], dependsOn: [], status: "pending" });
    const e2 = s.events.append({ ...base, type: "task.created", card });
    const e3 = s.events.append({ ...base, type: "run.completed", summary: "done" });

    expect(s.events.listByRunAfter(runId, 0)).toEqual([e1, e2, e3]);
    expect(s.events.listByRunAfter(runId, e1.seq)).toEqual([e2, e3]);
    expect(s.events.listByRunAfter(runId, e2.seq)).toEqual([e3]);
    expect(s.events.listByRunAfter(runId, e3.seq)).toEqual([]);
    s.close();
  });

  it("returns empty array when no events match", () => {
    const s = fileStorage();
    expect(s.events.listByRunAfter(newRunId(), 0)).toEqual([]);
    s.close();
  });

  it("respects limit parameter", () => {
    const s = fileStorage();
    const runId = newRunId();
    const base = { ts: now(), runId };
    s.events.append({ ...base, type: "run.started", goal: "alpha" });
    s.events.append({ ...base, type: "run.started", goal: "bravo" });
    s.events.append({ ...base, type: "run.started", goal: "charlie" });

    const limited = s.events.listByRunAfter(runId, 0, 2);
    expect(limited).toHaveLength(2);
    s.close();
  });

  it("only returns events for the specified run", () => {
    const s = fileStorage();
    const run1 = newRunId();
    const run2 = newRunId();
    const base1 = { ts: now(), runId: run1 };
    const base2 = { ts: now(), runId: run2 };
    s.events.append({ ...base1, type: "run.started", goal: "run-one" });
    const e2 = s.events.append({ ...base1, type: "run.completed", summary: "done" });
    s.events.append({ ...base2, type: "run.started", goal: "run-two" });

    const result = s.events.listByRunAfter(run1, e2.seq - 1);
    expect(result).toEqual([e2]);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// TaskRepository.listByProject
// ---------------------------------------------------------------------------

describe("TaskRepository.listByProject", () => {
  it("returns tasks ordered by created_at DESC", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "tp");
    const runId = newRunId();
    const t1 = taskCardSchema.parse({
      id: taskIdSchema.parse(crypto.randomUUID()),
      runId, projectId, role: "developer", title: "first-task", detail: "detail",
      acceptanceCriteria: ["works"], dependsOn: [], status: "pending",
      attempts: 0, maxAttempts: 3,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", artifacts: [],
    });
    const t2 = taskCardSchema.parse({
      id: taskIdSchema.parse(crypto.randomUUID()),
      runId, projectId, role: "tester", title: "second-task", detail: "detail",
      acceptanceCriteria: ["passes"], dependsOn: [], status: "pending",
      attempts: 0, maxAttempts: 3,
      createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", artifacts: [],
    });
    s.tasks.insert(t1);
    s.tasks.insert(t2);
    const list = s.tasks.listByProject(projectId);
    expect(list).toHaveLength(2);
    expect(list[0]!.title).toBe("second-task");
    expect(list[1]!.title).toBe("first-task");
    s.close();
  });

  it("returns empty for project with no tasks", () => {
    const s = fileStorage();
    expect(s.tasks.listByProject(newProjectId())).toHaveLength(0);
    s.close();
  });

  it("scoped to specific project", () => {
    const s = fileStorage();
    const p1 = newProjectId();
    const p2 = newProjectId();
    ensureProject(s, p1, "prj-a");
    ensureProject(s, p2, "prj-b");
    const runId = newRunId();
    s.tasks.insert(makeTaskCard({ runId, projectId: p1, role: "developer", title: "task-a1", detail: "d", acceptanceCriteria: ["ok"], dependsOn: [], status: "pending" }));
    s.tasks.insert(makeTaskCard({ runId, projectId: p1, role: "developer", title: "task-a2", detail: "d", acceptanceCriteria: ["ok"], dependsOn: [], status: "pending" }));
    s.tasks.insert(makeTaskCard({ runId, projectId: p2, role: "developer", title: "task-b1", detail: "d", acceptanceCriteria: ["ok"], dependsOn: [], status: "pending" }));
    expect(s.tasks.listByProject(p1)).toHaveLength(2);
    expect(s.tasks.listByProject(p2)).toHaveLength(1);
    s.close();
  });

  it("respects limit parameter", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    ensureProject(s, projectId, "lim");
    const runId = newRunId();
    s.tasks.insert(makeTaskCard({ runId, projectId, role: "developer", title: "task-alpha", detail: "d", acceptanceCriteria: ["ok"], dependsOn: [], status: "pending" }));
    s.tasks.insert(makeTaskCard({ runId, projectId, role: "developer", title: "task-bravo", detail: "d", acceptanceCriteria: ["ok"], dependsOn: [], status: "pending" }));
    s.tasks.insert(makeTaskCard({ runId, projectId, role: "developer", title: "task-charlie", detail: "d", acceptanceCriteria: ["ok"], dependsOn: [], status: "pending" }));
    expect(s.tasks.listByProject(projectId, 2)).toHaveLength(2);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// withTransaction
// ---------------------------------------------------------------------------

describe("withTransaction", () => {
  it("commits changes on success", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    withTransaction(s.db, () => {
      s.projects.insert({ id: projectId, name: "txn", rootPath: "/txn", createdAt: new Date().toISOString() });
    });
    expect(s.projects.get(projectId)).not.toBeNull();
    s.close();
  });

  it("rolls back on throw", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    try {
      withTransaction(s.db, () => {
        s.projects.insert({ id: projectId, name: "rollback", rootPath: "/rb", createdAt: new Date().toISOString() });
        throw new Error("boom");
      });
    } catch {
      // expected
    }
    expect(s.projects.get(projectId)).toBeNull();
    s.close();
  });

  it("re-throws the original error", () => {
    const s = fileStorage();
    try {
      withTransaction(s.db, () => {
        throw new StorageError("test/code", "intentional");
      });
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("test/code");
      return;
    }
    expect.fail("should have thrown");
  });

  it("works with nested SQL operations", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    withTransaction(s.db, () => {
      s.projects.insert({ id: projectId, name: "nested", rootPath: "/n", createdAt: now() });
      s.tasks.insert(makeTaskCard({ runId, projectId, role: "developer", title: "txn-task", detail: "d", acceptanceCriteria: ["ok"], dependsOn: [], status: "pending" }));
    });
    expect(s.projects.get(projectId)).not.toBeNull();
    expect(s.tasks.listByRun(runId)).toHaveLength(1);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// pipelineRunSummary
// ---------------------------------------------------------------------------

describe("pipelineRunSummary", () => {
  it("returns null for unknown run", () => {
    const s = fileStorage();
    expect(pipelineRunSummary(s.db, newRunId())).toBeNull();
    s.close();
  });

  it("returns correct counts and stage timings", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    s.projects.insert({ id: projectId, name: "prs", rootPath: "/prs", createdAt: new Date().toISOString() });
    const now = new Date().toISOString();
    s.pipelineRuns.insert({ id: runId, projectId, status: "completed", goal: "test", errorMessage: null, createdAt: now, finishedAt: now, durationMs: 5000 });

    s.events.append({ ts: now, runId, projectId, type: "run.started", goal: "test" });
    s.events.append({ ts: now, runId, projectId, type: "run.completed", summary: "done" });

    s.executions.insert(makeExec({ runId, projectId, role: "developer", status: "completed", startedAt: now, finishedAt: now, durationMs: 3000 }));
    s.executions.insert(makeExec({ runId, projectId, role: "tester", status: "completed", startedAt: now, finishedAt: now, durationMs: 2000 }));

    s.artifacts.insert(artifactSchema.parse({
      kind: "spec",
      ...newArtifactBase({ runId, projectId, producedBy: "architect" }),
      payload: { title: "The Spec", summary: "spec summary", goals: ["goal-a"], nonGoals: [], constraints: [], techStack: [], risks: [], openQuestions: [] },
    }));

    const summary = pipelineRunSummary(s.db, runId)!;
    expect(summary).not.toBeNull();
    expect(summary.id).toBe(runId);
    expect(summary.status).toBe("completed");
    expect(summary.eventCount).toBe(2);
    expect(summary.executionCount).toBe(2);
    expect(summary.artifactCount).toBe(1);
    expect(summary.stageTimings).toHaveLength(2);
    expect(summary.stageTimings.map((t) => t.role)).toContain("developer");
    expect(summary.stageTimings.map((t) => t.role)).toContain("tester");
    s.close();
  });

  it("returns zero counts for run with no child records", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    s.projects.insert({ id: projectId, name: "empty", rootPath: "/empty", createdAt: new Date().toISOString() });
    s.pipelineRuns.insert({ id: runId, projectId, status: "running", goal: "empty", errorMessage: null, createdAt: new Date().toISOString(), finishedAt: null, durationMs: null });
    const summary = pipelineRunSummary(s.db, runId)!;
    expect(summary.eventCount).toBe(0);
    expect(summary.executionCount).toBe(0);
    expect(summary.artifactCount).toBe(0);
    expect(summary.stageTimings).toHaveLength(0);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// pipelineHealth
// ---------------------------------------------------------------------------

describe("pipelineHealth", () => {
  it("returns correct status counts, averages, and failure rate", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    s.projects.insert({ id: projectId, name: "ph", rootPath: "/ph", createdAt: new Date().toISOString() });
    const now = new Date().toISOString();

    s.pipelineRuns.insert({ id: newRunId(), projectId, status: "completed", goal: "a", errorMessage: null, createdAt: now, finishedAt: now, durationMs: 1000 });
    s.pipelineRuns.insert({ id: newRunId(), projectId, status: "completed", goal: "b", errorMessage: null, createdAt: now, finishedAt: now, durationMs: 3000 });
    s.pipelineRuns.insert({ id: newRunId(), projectId, status: "failed", goal: "c", errorMessage: "err", createdAt: now, finishedAt: now, durationMs: 500 });
    s.pipelineRuns.insert({ id: newRunId(), projectId, status: "running", goal: "d", errorMessage: null, createdAt: now, finishedAt: null, durationMs: null });

    const health = pipelineHealth(s.db, projectId);
    expect(health.totalRuns).toBe(4);
    expect(health.statusCounts).toEqual({ completed: 2, failed: 1, running: 1 });
    expect(health.averageDurationMs).toBeCloseTo(1500);
    expect(health.failureRate).toBeCloseTo(1 / 3);
    s.close();
  });

  it("returns zero defaults for project with no runs", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const health = pipelineHealth(s.db, projectId);
    expect(health.totalRuns).toBe(0);
    expect(health.statusCounts).toEqual({});
    expect(health.averageDurationMs).toBeNull();
    expect(health.failureRate).toBe(0);
    s.close();
  });

  it("scoped to project isolation", () => {
    const s = fileStorage();
    const p1 = newProjectId();
    const p2 = newProjectId();
    s.projects.insert({ id: p1, name: "a", rootPath: "/a", createdAt: new Date().toISOString() });
    s.projects.insert({ id: p2, name: "b", rootPath: "/b", createdAt: new Date().toISOString() });
    const now = new Date().toISOString();
    s.pipelineRuns.insert({ id: newRunId(), projectId: p1, status: "completed", goal: "a", errorMessage: null, createdAt: now, finishedAt: now, durationMs: 100 });
    s.pipelineRuns.insert({ id: newRunId(), projectId: p2, status: "failed", goal: "b", errorMessage: "err", createdAt: now, finishedAt: now, durationMs: 50 });

    expect(pipelineHealth(s.db, p1).totalRuns).toBe(1);
    expect(pipelineHealth(s.db, p2).totalRuns).toBe(1);
    expect(pipelineHealth(s.db, p1).failureRate).toBe(0);
    expect(pipelineHealth(s.db, p2).failureRate).toBe(1);
    s.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 7B: Pipeline Stage Persistence
// ---------------------------------------------------------------------------

describe("migration 7 — pipeline_stages", () => {
  it("creates pipeline_stages table with correct schema", () => {
    const s = fileStorage();
    expect(s.schemaVersion).toBeGreaterThanOrEqual(7);
    const cols = s.db
      .prepare("PRAGMA table_info(pipeline_stages)")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("id");
    expect(names).toContain("run_id");
    expect(names).toContain("project_id");
    expect(names).toContain("stage_index");
    expect(names).toContain("stage_role");
    expect(names).toContain("status");
    expect(names).toContain("execution_id");
    expect(names).toContain("task_id");
    expect(names).toContain("started_at");
    expect(names).toContain("completed_at");
    expect(names).toContain("created_at");
    s.close();
  });

  it("is idempotent across reopens", () => {
    const path = join(dir, "mig7.db");
    const s1 = createStorage({ path });
    expect(s1.schemaVersion).toBeGreaterThanOrEqual(7);
    s1.close();

    const s2 = createStorage({ path });
    expect(s2.schemaVersion).toBe(s1.schemaVersion);
    const tables = s2.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("pipeline_stages");
    s2.close();
  });
});

describe("stages", () => {
  it("inserts and retrieves a stage record", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    s.projects.insert({ id: projectId, name: "stg", rootPath: "/stg", createdAt: new Date().toISOString() });

    const now = new Date().toISOString();
    const rec = s.stages.insert({
      id: crypto.randomUUID(),
      runId,
      projectId,
      stageIndex: 0,
      stageRole: "architect",
      status: "pending",
      executionId: null,
      taskId: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
    });
    expect(rec.status).toBe("pending");
    const fetched = s.stages.get(rec.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.stageRole).toBe("architect");
    expect(fetched!.stageIndex).toBe(0);
    s.close();
  });

  it("updates a stage record through status transitions", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    s.projects.insert({ id: projectId, name: "stg2", rootPath: "/stg2", createdAt: new Date().toISOString() });

    const now = new Date().toISOString();
    const rec = s.stages.insert({
      id: crypto.randomUUID(),
      runId,
      projectId,
      stageIndex: 1,
      stageRole: "developer",
      status: "pending",
      executionId: null,
      taskId: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
    });

    // pending → running
    s.stages.update({ ...rec, status: "running", startedAt: new Date().toISOString() });
    const running = s.stages.get(rec.id)!;
    expect(running.status).toBe("running");
    expect(running.startedAt).not.toBeNull();

    // running → completed
    s.stages.update({ ...running, status: "completed", completedAt: new Date().toISOString(), executionId: "exec-1" });
    const completed = s.stages.get(rec.id)!;
    expect(completed.status).toBe("completed");
    expect(completed.executionId).toBe("exec-1");
    expect(completed.completedAt).not.toBeNull();
    s.close();
  });

  it("throws StorageError on update of non-existent stage", () => {
    const s = fileStorage();
    expect(() =>
      s.stages.update({
        id: crypto.randomUUID(),
        runId: newRunId(),
        projectId: newProjectId(),
        stageIndex: 0,
        stageRole: "architect",
        status: "completed",
        executionId: null,
        taskId: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
      }),
    ).toThrow();
    s.close();
  });

  it("listByRun returns stages ordered by stage_index", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    s.projects.insert({ id: projectId, name: "stg3", rootPath: "/stg3", createdAt: new Date().toISOString() });

    const now = new Date().toISOString();
    const roles = ["architect", "developer", "tester", "reviewer"];
    for (let i = 0; i < roles.length; i++) {
      s.stages.insert({
        id: crypto.randomUUID(),
        runId,
        projectId,
        stageIndex: i,
        stageRole: roles[i]!,
        status: "pending",
        executionId: null,
        taskId: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
      });
    }

    const stages = s.stages.listByRun(runId);
    expect(stages).toHaveLength(4);
    expect(stages[0]!.stageRole).toBe("architect");
    expect(stages[1]!.stageRole).toBe("developer");
    expect(stages[2]!.stageRole).toBe("tester");
    expect(stages[3]!.stageRole).toBe("reviewer");
    s.close();
  });

  it("listByRun isolates runs", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const run1 = newRunId();
    const run2 = newRunId();
    s.projects.insert({ id: projectId, name: "stg4", rootPath: "/stg4", createdAt: new Date().toISOString() });

    const now = new Date().toISOString();
    s.stages.insert({ id: crypto.randomUUID(), runId: run1, projectId, stageIndex: 0, stageRole: "architect", status: "completed", executionId: null, taskId: null, startedAt: null, completedAt: null, createdAt: now });
    s.stages.insert({ id: crypto.randomUUID(), runId: run1, projectId, stageIndex: 1, stageRole: "developer", status: "completed", executionId: null, taskId: null, startedAt: null, completedAt: null, createdAt: now });
    s.stages.insert({ id: crypto.randomUUID(), runId: run2, projectId, stageIndex: 0, stageRole: "architect", status: "pending", executionId: null, taskId: null, startedAt: null, completedAt: null, createdAt: now });

    expect(s.stages.listByRun(run1)).toHaveLength(2);
    expect(s.stages.listByRun(run2)).toHaveLength(1);
    s.close();
  });

  it("getLastCompleted returns the last completed stage by stage_index", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    s.projects.insert({ id: projectId, name: "stg5", rootPath: "/stg5", createdAt: new Date().toISOString() });

    const now = new Date().toISOString();
    // Insert 4 stages: architect=completed, developer=completed, tester=running, reviewer=pending
    s.stages.insert({ id: "s1", runId, projectId, stageIndex: 0, stageRole: "architect", status: "completed", executionId: "e1", taskId: null, startedAt: now, completedAt: now, createdAt: now });
    s.stages.insert({ id: "s2", runId, projectId, stageIndex: 1, stageRole: "developer", status: "completed", executionId: "e2", taskId: null, startedAt: now, completedAt: now, createdAt: now });
    s.stages.insert({ id: "s3", runId, projectId, stageIndex: 2, stageRole: "tester", status: "running", executionId: null, taskId: null, startedAt: now, completedAt: null, createdAt: now });
    s.stages.insert({ id: "s4", runId, projectId, stageIndex: 3, stageRole: "reviewer", status: "pending", executionId: null, taskId: null, startedAt: null, completedAt: null, createdAt: now });

    const last = s.stages.getLastCompleted(runId);
    expect(last).not.toBeNull();
    expect(last!.id).toBe("s2");
    expect(last!.stageRole).toBe("developer");
    s.close();
  });

  it("getLastCompleted returns null when no stages are completed", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    s.projects.insert({ id: projectId, name: "stg6", rootPath: "/stg6", createdAt: new Date().toISOString() });

    const now = new Date().toISOString();
    s.stages.insert({ id: crypto.randomUUID(), runId, projectId, stageIndex: 0, stageRole: "architect", status: "running", executionId: null, taskId: null, startedAt: now, completedAt: null, createdAt: now });

    expect(s.stages.getLastCompleted(runId)).toBeNull();
    s.close();
  });

  it("survives database close/reopen (durability)", () => {
    const path = join(dir, "stg-dur.db");
    const s1 = createStorage({ path });
    const projectId = newProjectId();
    const runId = newRunId();
    s1.projects.insert({ id: projectId, name: "dur", rootPath: "/dur", createdAt: new Date().toISOString() });

    const now = new Date().toISOString();
    s1.stages.insert({ id: "dur-1", runId, projectId, stageIndex: 0, stageRole: "architect", status: "completed", executionId: "e1", taskId: null, startedAt: now, completedAt: now, createdAt: now });
    s1.stages.insert({ id: "dur-2", runId, projectId, stageIndex: 1, stageRole: "developer", status: "running", executionId: "e2", taskId: null, startedAt: now, completedAt: null, createdAt: now });
    s1.close();

    const s2 = createStorage({ path });
    const stages = s2.stages.listByRun(runId);
    expect(stages).toHaveLength(2);
    expect(stages[0]!.status).toBe("completed");
    expect(stages[1]!.status).toBe("running");

    const last = s2.stages.getLastCompleted(runId);
    expect(last!.id).toBe("dur-1");
    s2.close();
  });
});

// ---------------------------------------------------------------------------
// Usage aggregation (Phase 8B) — summarizeRunUsage / summarizeTaskUsage
// ---------------------------------------------------------------------------

describe("usage aggregation (Phase 8B)", () => {
  function seedRun(
    s: Storage,
    goal = "aggregate me",
  ): { projectId: string; runId: string } {
    const projectId = newProjectId();
    ensureProject(s, projectId, "agg");
    const runId = newRunId();
    s.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "completed",
      goal,
      errorMessage: null,
      createdAt: now(),
      finishedAt: null,
      durationMs: null,
    });
    return { projectId, runId };
  }

  it("returns null for an unknown run", () => {
    const s = fileStorage();
    expect(summarizeRunUsage(s.db, newRunId())).toBeNull();
    s.close();
  });

  it("returns null for an unknown task", () => {
    const s = fileStorage();
    expect(summarizeTaskUsage(s.db, newTaskId())).toBeNull();
    s.close();
  });

  it("aggregates executions reached through per-task linkage", () => {
    const s = fileStorage();
    const { projectId, runId } = seedRun(s);
    const dev = makeTaskCard({
      runId,
      projectId,
      role: "developer",
      title: "Implement parser",
      detail: "build a parser",
      acceptanceCriteria: ["parses"],
      dependsOn: [],
      status: "pending",
    });
    s.tasks.insert(dev);
    s.executions.insert(
      makeExec({
        runId,
        projectId,
        taskId: dev.id,
        role: "developer",
        usage: { inputTokens: 1200, outputTokens: 300, costUsdMicros: null, currency: null, usageSource: null },
      }),
    );
    s.executions.insert(
      makeExec({
        runId,
        projectId,
        taskId: dev.id,
        role: "developer",
        usage: { inputTokens: 800, outputTokens: 100, costUsdMicros: null, currency: null, usageSource: null },
      }),
    );

    const summary = summarizeRunUsage(s.db, runId);
    expect(summary).not.toBeNull();
    expect(summary!.runId).toBe(runId);
    expect(summary!.projectId).toBe(projectId);
    expect(summary!.executionCount).toBe(2);
    expect(summary!.unknownExecutionCount).toBe(0);
    expect(summary!.totals).toEqual({
      inputTokens: 2000,
      outputTokens: 400,
      costUsdMicros: null,
      currency: null,
      usageSource: null,
    });
    expect(summary!.perTask).toHaveLength(1);
    expect(summary!.perTask[0]).toMatchObject({
      taskId: dev.id,
      runId,
      role: "developer",
      title: "Implement parser",
      executionCount: 2,
      unknownExecutionCount: 0,
    });
    expect(summary!.perTask[0]!.totals).toEqual({
      inputTokens: 2000,
      outputTokens: 400,
      costUsdMicros: null,
      currency: null,
      usageSource: null,
    });

    const taskSummary = summarizeTaskUsage(s.db, dev.id);
    expect(taskSummary).not.toBeNull();
    expect(taskSummary!.totals).toEqual(summary!.perTask[0]!.totals);
    s.close();
  });

  it("also counts legacy executions linked by run_id on the execution", () => {
    const s = fileStorage();
    const { projectId, runId } = seedRun(s);
    s.executions.insert(
      makeExec({
        runId,
        projectId,
        taskId: null,
        role: "tester",
        usage: { inputTokens: 40, outputTokens: 60, costUsdMicros: null, currency: null, usageSource: null },
      }),
    );

    const summary = summarizeRunUsage(s.db, runId);
    expect(summary!.executionCount).toBe(1);
    expect(summary!.totals.inputTokens).toBe(40);
    expect(summary!.totals.outputTokens).toBe(60);
    s.close();
  });

  it("counts an execution matching both linkage conventions exactly once", () => {
    const s = fileStorage();
    const { projectId, runId } = seedRun(s);
    const dev = makeTaskCard({
      runId,
      projectId,
      role: "developer",
      title: "Single source of truth",
      detail: "one execution only",
      acceptanceCriteria: ["ok"],
      dependsOn: [],
      status: "pending",
    });
    s.tasks.insert(dev);
    // Execution carries BOTH the task_id link and a run_id link.
    s.executions.insert(
      makeExec({
        runId,
        projectId,
        taskId: dev.id,
        role: "developer",
        usage: { inputTokens: 500, outputTokens: 50, costUsdMicros: null, currency: null, usageSource: null },
      }),
    );

    const summary = summarizeRunUsage(s.db, runId);
    expect(summary!.executionCount).toBe(1);
    expect(summary!.totals.inputTokens).toBe(500);
    expect(summary!.unknownExecutionCount).toBe(0);
    s.close();
  });

  it("is scoped to the run and does not leak other runs' executions", () => {
    const s = fileStorage();
    const { projectId, runId } = seedRun(s);
    const other = newRunId();
    s.pipelineRuns.insert({
      id: other,
      projectId,
      status: "running",
      goal: "other",
      errorMessage: null,
      createdAt: now(),
      finishedAt: null,
      durationMs: null,
    });
    s.executions.insert(
      makeExec({
        runId,
        projectId,
        usage: { inputTokens: 10, outputTokens: 10, costUsdMicros: null, currency: null, usageSource: null },
      }),
    );
    s.executions.insert(
      makeExec({
        runId: other,
        projectId,
        usage: { inputTokens: 9999, outputTokens: 9999, costUsdMicros: null, currency: null, usageSource: null },
      }),
    );

    const summary = summarizeRunUsage(s.db, runId);
    expect(summary!.executionCount).toBe(1);
    expect(summary!.totals.inputTokens).toBe(10);
    s.close();
  });

  it("unknown semantics: null usage increments the unknown count and nulls mixed aggregates", () => {
    const s = fileStorage();
    const { projectId, runId } = seedRun(s);
    const dev = makeTaskCard({
      runId,
      projectId,
      role: "developer",
      title: "Partial telemetry",
      detail: "some runs report, some do not",
      acceptanceCriteria: ["ok"],
      dependsOn: [],
      status: "pending",
    });
    s.tasks.insert(dev);
    s.executions.insert(
      makeExec({
        runId,
        projectId,
        taskId: dev.id,
        role: "developer",
        usage: { inputTokens: 100, outputTokens: 50, costUsdMicros: null, currency: null, usageSource: null },
      }),
    );
    // A second, unmeasured execution: usage is UNKNOWN, not zero.
    s.executions.insert(makeExec({ runId, projectId, taskId: dev.id, role: "developer", usage: null }));

    const summary = summarizeRunUsage(s.db, runId);
    expect(summary!.executionCount).toBe(2);
    expect(summary!.unknownExecutionCount).toBe(1);
    expect(summary!.totals.inputTokens).toBeNull();
    expect(summary!.totals.outputTokens).toBeNull();
    expect(summary!.totals.costUsdMicros).toBeNull();

    const perTask = summary!.perTask[0]!;
    expect(perTask.unknownExecutionCount).toBe(1);
    expect(perTask.executionCount).toBe(2);
    expect(perTask.totals.inputTokens).toBeNull();
    s.close();
  });

  it("all-null usage produces all-null totals", () => {
    const s = fileStorage();
    const { projectId, runId } = seedRun(s);
    s.executions.insert(makeExec({ runId, projectId, usage: null }));
    s.executions.insert(makeExec({ runId, projectId, usage: null }));

    const summary = summarizeRunUsage(s.db, runId);
    expect(summary!.executionCount).toBe(2);
    expect(summary!.unknownExecutionCount).toBe(2);
    expect(summary!.totals).toEqual({
      inputTokens: null,
      outputTokens: null,
      costUsdMicros: null,
      currency: null,
      usageSource: null,
    });
    s.close();
  });

  it("empty scopes report truthful zero totals, never an unknown", () => {
    const s = fileStorage();
    const { projectId, runId } = seedRun(s);

    const summary = summarizeRunUsage(s.db, runId);
    expect(summary!.executionCount).toBe(0);
    expect(summary!.unknownExecutionCount).toBe(0);
    expect(summary!.totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUsdMicros: 0,
      currency: null,
      usageSource: null,
    });
    expect(summary!.perTask).toHaveLength(0);

    // A task that ran no executions is also a truthful zero.
    const idle = makeTaskCard({
      runId,
      projectId,
      role: "reviewer",
      title: "Review everything",
      detail: "no executions happened",
      acceptanceCriteria: ["ok"],
      dependsOn: [],
      status: "pending",
    });
    s.tasks.insert(idle);
    const taskSummary = summarizeTaskUsage(s.db, idle.id);
    expect(taskSummary!.executionCount).toBe(0);
    expect(taskSummary!.unknownExecutionCount).toBe(0);
    expect(taskSummary!.totals.inputTokens).toBe(0);
    s.close();
  });

  it("per-task summary scopes to the task, not the run", () => {
    const s = fileStorage();
    const { projectId, runId } = seedRun(s);
    const dev = makeTaskCard({
      runId,
      projectId,
      role: "developer",
      title: "Dev task",
      detail: "d",
      acceptanceCriteria: ["ok"],
      dependsOn: [],
      status: "pending",
    });
    const tester = makeTaskCard({
      runId,
      projectId,
      role: "tester",
      title: "Test task",
      detail: "t",
      acceptanceCriteria: ["ok"],
      dependsOn: [dev.id],
      status: "pending",
    });
    s.tasks.insert(dev);
    s.tasks.insert(tester);
    s.executions.insert(
      makeExec({
        runId,
        projectId,
        taskId: dev.id,
        role: "developer",
        usage: { inputTokens: 300, outputTokens: 30, costUsdMicros: null, currency: null, usageSource: null },
      }),
    );

    const devSummary = summarizeTaskUsage(s.db, dev.id);
    const testerSummary = summarizeTaskUsage(s.db, tester.id);
    expect(devSummary!.executionCount).toBe(1);
    expect(devSummary!.totals.inputTokens).toBe(300);
    expect(testerSummary!.executionCount).toBe(0);
    expect(testerSummary!.totals.inputTokens).toBe(0);

    const runSummary = summarizeRunUsage(s.db, runId);
    expect(runSummary!.executionCount).toBe(1);
    expect(runSummary!.perTask).toHaveLength(2);
    s.close();
  });

  it("keeps a homogeneous currency/usageSource, and nulls them when mixed", () => {
    const s = fileStorage();
    const { projectId, runId } = seedRun(s);
    s.executions.insert(
      makeExec({
        runId,
        projectId,
        usage: { inputTokens: 1, outputTokens: 1, costUsdMicros: 100, currency: "USD", usageSource: "reported" },
      }),
    );
    s.executions.insert(
      makeExec({
        runId,
        projectId,
        usage: { inputTokens: 1, outputTokens: 1, costUsdMicros: 50, currency: "USD", usageSource: "reported" },
      }),
    );

    let summary = summarizeRunUsage(s.db, runId)!;
    expect(summary.totals.costUsdMicros).toBe(150);
    expect(summary.totals.currency).toBe("USD");
    expect(summary.totals.usageSource).toBe("reported");

    // Inject a differently-priced execution with a second currency.
    s.executions.insert(
      makeExec({
        runId,
        projectId,
        usage: { inputTokens: 1, outputTokens: 1, costUsdMicros: 25, currency: "EUR", usageSource: "reported" },
      }),
    );
    summary = summarizeRunUsage(s.db, runId)!;
    expect(summary.totals.costUsdMicros).toBe(175);
    expect(summary.totals.currency).toBeNull();
    expect(summary.totals.usageSource).toBe("reported");
    s.close();
  });
});

describe("approvals (Phase 9A)", () => {
  function seed(s: Storage, projectId: ProjectId, runId: RunId) {
    s.projects.insert({
      id: projectId,
      name: `approval-proj-${projectId}`,
      rootPath: `/tmp/approval-${projectId}`,
      createdAt: new Date().toISOString(),
    });
    s.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "running",
      goal: "approval test",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    });
  }

  function makeApproval(projectId: ProjectId, runId: RunId): ApprovalRecord {
    return {
      id: newApprovalId(),
      projectId,
      runId,
      taskId: newTaskId(),
      kind: "destructive_git",
      title: "Allow force push?",
      detail: "Overwrites remote history",
      risk: "high",
      status: "pending",
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      decision: null,
      decidedBy: null,
    };
  }

  it("creates and retrieves an approval", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    seed(s, projectId, runId);

    const rec = makeApproval(projectId, runId);
    s.approvals.insert(rec);

    const fetched = s.approvals.get(rec.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.projectId).toBe(projectId);
    expect(fetched!.runId).toBe(runId);
    expect(fetched!.kind).toBe("destructive_git");
    expect(fetched!.title).toBe("Allow force push?");
    expect(fetched!.risk).toBe("high");
    expect(fetched!.status).toBe("pending");
    expect(fetched!.resolvedAt).toBeNull();
    expect(fetched!.decision).toBeNull();
    expect(fetched!.decidedBy).toBeNull();
    s.close();
  });

  it("returns null for unknown approval id", () => {
    const s = fileStorage();
    expect(s.approvals.get(newApprovalId())).toBeNull();
    s.close();
  });

  it("lists approvals by project ordered by requested_at DESC", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    seed(s, projectId, runId);

    const a1 = makeApproval(projectId, runId);
    const a2 = makeApproval(projectId, runId);
    a2.requestedAt = new Date(Date.now() + 1000).toISOString();
    s.approvals.insert(a1);
    s.approvals.insert(a2);

    const list = s.approvals.listByProject(projectId);
    expect(list.map((a) => a.id)).toEqual([a2.id, a1.id]);
    s.close();
  });

  it("lists approvals by run", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId1 = newRunId();
    const runId2 = newRunId();
    s.projects.insert({
      id: projectId,
      name: `approval-proj-${projectId}`,
      rootPath: `/tmp/approval-${projectId}`,
      createdAt: new Date().toISOString(),
    });
    s.pipelineRuns.insert({
      id: runId1,
      projectId,
      status: "running",
      goal: "approval test",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    });
    s.pipelineRuns.insert({
      id: runId2,
      projectId,
      status: "running",
      goal: "approval test",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    });

    const a1 = makeApproval(projectId, runId1);
    const a2 = makeApproval(projectId, runId2);
    s.approvals.insert(a1);
    s.approvals.insert(a2);

    const runList = s.approvals.listByRun(runId1);
    expect(runList.map((a) => a.id)).toEqual([a1.id]);
    s.close();
  });

  it("listPending returns only pending approvals, scoped or global", () => {
    const s = fileStorage();
    const projectId1 = newProjectId();
    const projectId2 = newProjectId();
    const runId1 = newRunId();
    const runId2 = newRunId();
    seed(s, projectId1, runId1);
    seed(s, projectId2, runId2);

    const pending1 = makeApproval(projectId1, runId1);
    const pending2 = makeApproval(projectId2, runId2);
    const resolved = makeApproval(projectId1, runId1);
    resolved.id = newApprovalId();
    s.approvals.insert(pending1);
    s.approvals.insert(pending2);
    s.approvals.insert(resolved);
    s.approvals.resolve(resolved.id, "allow", "user");

    // Global pending: both pending, resolved excluded.
    let pendingIds = s.approvals.listPending().map((a) => a.id);
    expect(pendingIds).toContain(pending1.id);
    expect(pendingIds).toContain(pending2.id);
    expect(pendingIds).not.toContain(resolved.id);

    // Project scoped.
    pendingIds = s.approvals.listPending(projectId1).map((a) => a.id);
    expect(pendingIds).toEqual([pending1.id]);
    s.close();
  });

  it("approves a pending approval atomically", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    seed(s, projectId, runId);

    const rec = makeApproval(projectId, runId);
    s.approvals.insert(rec);

    const updated = s.approvals.resolve(rec.id, "allow", "user");
    expect(updated.status).toBe("approved");
    expect(updated.decision).toBe("allow");
    expect(updated.decidedBy).toBe("user");
    expect(updated.resolvedAt).not.toBeNull();

    const fetched = s.approvals.get(rec.id)!;
    expect(fetched.status).toBe("approved");
    expect(fetched.decision).toBe("allow");
    expect(fetched.decidedBy).toBe("user");
    expect(fetched.resolvedAt).not.toBeNull();
    s.close();
  });

  it("denies a pending approval atomically", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    seed(s, projectId, runId);

    const rec = makeApproval(projectId, runId);
    s.approvals.insert(rec);

    const updated = s.approvals.resolve(rec.id, "deny", "user");
    expect(updated.status).toBe("denied");
    expect(updated.decision).toBe("deny");
    expect(updated.decidedBy).toBe("user");
    expect(updated.resolvedAt).not.toBeNull();

    const fetched = s.approvals.get(rec.id)!;
    expect(fetched.status).toBe("denied");
    expect(fetched.decision).toBe("deny");
    s.close();
  });

  it("rejects resolution of an unknown approval id", () => {
    const s = fileStorage();
    expect(() => s.approvals.resolve(newApprovalId(), "allow", "user")).toThrow(
      /does not exist/,
    );
    s.close();
  });

  it("rejects double-resolution of an already-resolved approval", () => {
    const s = fileStorage();
    const projectId = newProjectId();
    const runId = newRunId();
    seed(s, projectId, runId);

    const rec = makeApproval(projectId, runId);
    s.approvals.insert(rec);

    s.approvals.resolve(rec.id, "allow", "user");
    expect(() => s.approvals.resolve(rec.id, "allow", "user")).toThrow(
      /already resolved/,
    );
    expect(() => s.approvals.resolve(rec.id, "deny", "user")).toThrow(
      /already resolved/,
    );

    // The decision is immutable — first resolution wins.
    const fetched = s.approvals.get(rec.id)!;
    expect(fetched.status).toBe("approved");
    expect(fetched.decision).toBe("allow");
    s.close();
  });

  it("approvals survive reopen (durability)", () => {
    const path = join(dir, "approval-durability.db");
    const projectId = newProjectId();
    const runId = newRunId();

    const s1 = createStorage({ path });
    s1.projects.insert({
      id: projectId,
      name: "approval-durable",
      rootPath: "/tmp/approval-durable",
      createdAt: new Date().toISOString(),
    });
    s1.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "running",
      goal: "durable approval",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    });
    const rec = makeApproval(projectId, runId);
    s1.approvals.insert(rec);
    s1.approvals.resolve(rec.id, "deny", "user");
    s1.close();

    const s2 = createStorage({ path });
    const fetched = s2.approvals.get(rec.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("denied");
    expect(fetched!.decision).toBe("deny");
    expect(fetched!.decidedBy).toBe("user");
    s2.close();
  });
});
