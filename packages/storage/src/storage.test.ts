import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactSchema,
  makeContextEntry,
  makeTaskCard,
  newArtifactBase,
  newArtifactId,
  newProjectId,
  newRunId,
  taskIdSchema,
} from "@devmesh/contracts";
import { createStorage, type Storage } from "./index.js";

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
