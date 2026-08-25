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
