import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactSchema,
  makeTaskCard,
  newArtifactBase,
  newProjectId,
  newRunId,
} from "@devmesh/contracts";
import type { Storage } from "@devmesh/storage";
import { createStorage } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import { FakeRuntime } from "@devmesh/runtime";
import { createDefaultAgentRegistry } from "@devmesh/agents";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { startServer } from "./bootstrap.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-server-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

function testConfig() {
  return loadConfig({
    DEVMESH_DATA_ROOT: dataRoot,
    DEVMESH_LOG_LEVEL: "error",
    DEVMESH_PORT: "0",
  });
}

async function buildStack() {
  const config = testConfig();
  const storage = createStorage({ path: join(config.dataRoot, "test.db") });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(config.dataRoot, "workspaces"),
  });
  const app = buildApp({ config, storage, workspaces });
  return { app, storage };
}

/** Seed a project + pipeline run + tasks + events + artifacts + executions for query tests. */
function seedPipelineData(storage: Storage) {
  const projectId = newProjectId();
  const runId = newRunId();
  const now = "2026-08-01T10:00:00.000Z";

  storage.projects.insert({
    id: projectId,
    name: "qtest",
    rootPath: "/tmp/qtest",
    createdAt: now,
  });

  storage.pipelineRuns.insert({
    id: runId,
    projectId,
    status: "running",
    goal: "implement feature X",
    errorMessage: null,
    createdAt: now,
    finishedAt: null,
    durationMs: null,
  });

  const task1 = makeTaskCard({
    runId,
    projectId,
    role: "architect",
    title: "Architecture analysis",
    detail: "analyze",
    acceptanceCriteria: ["done"],
    dependsOn: [],
    status: "in_review",
  });
  const task2 = makeTaskCard({
    runId,
    projectId,
    role: "developer",
    title: "Implementation",
    detail: "implement",
    acceptanceCriteria: ["done"],
    dependsOn: [task1.id],
    status: "running",
  });
  storage.tasks.insert(task1);
  storage.tasks.insert(task2);

  const evt1 = storage.events.append({
    ts: now,
    runId,
    projectId,
    actor: "system",
    type: "run.started",
    goal: "implement feature X",
  });
  const evt2 = storage.events.append({
    ts: now,
    runId,
    projectId,
    actor: "system",
    type: "task.created",
    card: task1,
  });
  const evt3 = storage.events.append({
    ts: now,
    runId,
    projectId,
    actor: "system",
    type: "task.created",
    card: task2,
  });

  const spec = artifactSchema.parse({
    kind: "spec",
    ...newArtifactBase({ runId, projectId, producedBy: "architect" }),
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
  const plan = artifactSchema.parse({
    kind: "plan",
    ...newArtifactBase({ runId, projectId, producedBy: "architect" }),
    payload: { tasks: [{ refKey: "t1", role: "developer", title: "Task One", detail: "d", acceptanceCriteria: ["a"], dependsOn: [] }] },
  });
  storage.artifacts.insert(spec);
  storage.artifacts.insert(plan);

  storage.executions.insert({
    id: crypto.randomUUID(),
    runId,
    projectId,
    taskId: task1.id,
    agentId: "architect",
    role: "architect",
    runtime: "fake",
    status: "completed",
    failureKind: null,
    instruction: "analyze",
    sessionRef: null,
    exitCode: 0,
    stoppedReason: null,
    errorMessage: null,
    stdoutTail: null,
    stderrTail: null,
    replyText: "analysis complete",
    startedAt: now,
    finishedAt: now,
    durationMs: 100,
    resultArtifactId: spec.id,
    verificationArtifactId: null,
  });

  return { projectId, runId, task1, task2, evt1, evt2, evt3, spec, plan };
}

describe("HTTP API", () => {
  it("reports health including storage liveness", async () => {
    const { app } = await buildStack();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.checks.storage).toBe("ok");
    expect(typeof body.version).toBe("string");
    await app.close();
  });

  it("creates and lists projects end-to-end", async () => {
    const { app } = await buildStack();
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Demo App" },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project.name).toBe("demo-app");
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(project).not.toHaveProperty("rootPath"); // internal detail stays internal

    const list = await app.inject({ method: "GET", url: "/projects" });
    const listed = list.json() as { projects: Array<{ id: string }> };
    expect(listed.projects.map((p) => p.id)).toContain(project.id);

    const one = await app.inject({ method: "GET", url: `/projects/${project.id}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().name).toBe("demo-app");
    await app.close();
  });

  it("maps errors to structured problem payloads", async () => {
    const { app } = await buildStack();
    // invalid body
    const badBody = await app.inject({ method: "POST", url: "/projects", payload: {} });
    expect(badBody.statusCode).toBe(400);
    expect(badBody.json().error.code).toBe("request/invalid");

    // duplicate name
    await app.inject({ method: "POST", url: "/projects", payload: { name: "dupe" } });
    const dup = await app.inject({ method: "POST", url: "/projects", payload: { name: "dupe" } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("workspace/already-exists");

    // unknown but well-formed id
    const missing = await app.inject({
      method: "GET",
      url: `/projects/00000000-0000-4000-8000-000000000000`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("workspace/not-found");

    // malformed id
    const malformed = await app.inject({ method: "GET", url: "/projects/not-a-uuid" });
    expect(malformed.statusCode).toBe(404);

    // unknown route
    const noRoute = await app.inject({ method: "GET", url: "/nope" });
    expect(noRoute.statusCode).toBe(404);
    expect(noRoute.json().error.code).toBe("request/not-found");
    await app.close();
  });

  it("closing the app releases the database", async () => {
    const { app, storage } = await buildStack();
    await app.close(); // onClose hook closes storage
    let closed = false;
    try {
      storage.db.prepare("SELECT 1").get();
    } catch {
      closed = true;
    }
    expect(closed).toBe(true);
  });
});

describe("graceful lifecycle (real listen)", () => {
  it("serves over TCP and shuts down cleanly", async () => {
    const server = await startServer({
      config: testConfig(),
      installSignals: false,
    });
    try {
      expect(server.address).toMatch(/127\.0\.0\.1:\d+/);
      const port = Number(server.address.split(":")[1]);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      await server.shutdown();
    }
    // after shutdown the port is released; a second bind on :0 is trivially fine,
    // so assert shutdown idempotence instead:
    await expect(server.shutdown()).resolves.toBeUndefined();
  });
});

describe("POST /projects/:id/pipeline returns runId", () => {
  it("returns pipeline object with runId, projectId, status, goal, createdAt", async () => {
    const config = testConfig();
    const storage = createStorage({ path: join(config.dataRoot, "test.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(config.dataRoot, "workspaces"),
    });
    const runtime = new FakeRuntime({
      steps: [{ events: [{ kind: "text", text: "done" }] }],
      outcome: { status: "completed", sessionId: "ses_0", finalText: "ok" },
      stepDelayMs: 5,
    });
    const app = buildApp({
      config: { ...config, runtime: "opencode" } as typeof config,
      storage,
      workspaces,
      runtime,
      agents: createDefaultAgentRegistry(),
    });

    // Create a project first
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "pipeline-test" },
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id;

    // Start a pipeline
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/pipeline`,
      payload: { instruction: "build the feature" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.pipeline).toBeDefined();
    expect(body.pipeline.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.pipeline.projectId).toBe(projectId);
    expect(body.pipeline.status).toBe("running");
    expect(body.pipeline.goal).toBe("build the feature");
    expect(body.pipeline.createdAt).toBeDefined();
    expect(body.message).toBeUndefined();

    await app.close();
  });

  it("503 when no runtime is wired", async () => {
    const { app } = await buildStack();
    const created = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "no-runtime" },
    });
    const projectId = created.json().id;

    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/pipeline`,
      payload: { instruction: "do something" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("runtime/not-configured");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 6B: Pipeline Query API tests
// ---------------------------------------------------------------------------

describe("GET /projects/:projectId/pipelines", () => {
  it("returns pipeline runs for a project", async () => {
    const { app, storage } = await buildStack();
    const { projectId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/pipelines` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pipelines: Array<{ id: string; goal: string }> };
    expect(body.pipelines).toHaveLength(1);
    expect(body.pipelines[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.pipelines[0]!.goal).toBe("implement feature X");
    await app.close();
  });

  it("returns empty pipelines array for a project with no runs", async () => {
    const { app, storage } = await buildStack();
    const projectId = newProjectId();
    storage.projects.insert({ id: projectId, name: "empty", rootPath: "/empty", createdAt: new Date().toISOString() });
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/pipelines` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { pipelines: unknown[] }).pipelines).toEqual([]);
    await app.close();
  });
});

describe("GET /pipelines/:runId", () => {
  it("returns an existing pipeline run", async () => {
    const { app, storage } = await buildStack();
    const { runId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pipeline: { id: string; status: string } };
    expect(body.pipeline.id).toBe(runId);
    expect(body.pipeline.status).toBe("running");
    expect(body.pipeline.goal).toBe("implement feature X");
    await app.close();
  });

  it("returns 404 for a missing pipeline run", async () => {
    const { app, storage } = await buildStack();
    seedPipelineData(storage);
    const missingRun = newRunId();
    const res = await app.inject({ method: "GET", url: `/pipelines/${missingRun}` });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("pipeline/not-found");
    await app.close();
  });
});

describe("GET /pipelines/:runId/tasks", () => {
  it("returns tasks for the pipeline run", async () => {
    const { app, storage } = await buildStack();
    const { runId, task1, task2 } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}/tasks` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<{ id: string; role: string }> };
    expect(body.tasks).toHaveLength(2);
    const ids = body.tasks.map((t) => t.id);
    expect(ids).toContain(task1.id);
    expect(ids).toContain(task2.id);
    await app.close();
  });
});

describe("GET /pipelines/:runId/events", () => {
  it("returns events for the pipeline run", async () => {
    const { app, storage } = await buildStack();
    const { runId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}/events` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ seq: number; type: string }>; hasMore: boolean };
    expect(body.events.length).toBeGreaterThanOrEqual(3);
    expect(body.hasMore).toBe(false);
    expect(body.events.every((e) => typeof e.seq === "number")).toBe(true);
    await app.close();
  });

  it("returns 404 for events on a missing run", async () => {
    const { app, storage } = await buildStack();
    seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/pipelines/${newRunId()}/events` });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("pipeline/not-found");
    await app.close();
  });

  it("pagination afterSeq works correctly", async () => {
    const { app, storage } = await buildStack();
    const { runId, evt1 } = seedPipelineData(storage);
    // After the first event, we should get the remaining events
    const res = await app.inject({
      method: "GET",
      url: `/pipelines/${runId}/events?afterSeq=${evt1.seq}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ seq: number }>; hasMore: boolean };
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(body.events.every((e) => e.seq > evt1.seq)).toBe(true);
    await app.close();
  });

  it("limit is respected", async () => {
    const { app, storage } = await buildStack();
    const { runId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}/events?limit=2` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ seq: number }>; hasMore: boolean };
    expect(body.events).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    await app.close();
  });

  it("rejects invalid pagination parameters safely", async () => {
    const { app, storage } = await buildStack();
    const { runId } = seedPipelineData(storage);
    // Invalid afterSeq — should default to 0, not error
    const res1 = await app.inject({ method: "GET", url: `/pipelines/${runId}/events?afterSeq=abc` });
    expect(res1.statusCode).toBe(200);
    // Negative limit — should use default
    const res2 = await app.inject({ method: "GET", url: `/pipelines/${runId}/events?limit=-5` });
    expect(res2.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /pipelines/:runId/artifacts", () => {
  it("returns artifacts for the pipeline run", async () => {
    const { app, storage } = await buildStack();
    const { runId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}/artifacts` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { artifacts: Array<{ kind: string }> };
    expect(body.artifacts.length).toBeGreaterThanOrEqual(2);
    const kinds = body.artifacts.map((a) => a.kind);
    expect(kinds).toContain("spec");
    expect(kinds).toContain("plan");
    await app.close();
  });

  it("kind filtering works", async () => {
    const { app, storage } = await buildStack();
    const { runId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}/artifacts?kind=spec` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { artifacts: Array<{ kind: string }> };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]!.kind).toBe("spec");
    await app.close();
  });

  it("rejects invalid artifact kind", async () => {
    const { app, storage } = await buildStack();
    const { runId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}/artifacts?kind=invalid_kind` });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("request/invalid");
    await app.close();
  });
});

describe("GET /pipelines/:runId/executions", () => {
  it("returns executions for the pipeline run", async () => {
    const { app, storage } = await buildStack();
    const { runId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}/executions` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { executions: Array<{ runId: string; role: string }> };
    expect(body.executions).toHaveLength(1);
    expect(body.executions[0]!.runId).toBe(runId);
    expect(body.executions[0]!.role).toBe("architect");
    await app.close();
  });
});

describe("GET /projects/:projectId/tasks", () => {
  it("returns project-level tasks", async () => {
    const { app, storage } = await buildStack();
    const { projectId, task1, task2 } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/tasks` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<{ id: string }> };
    expect(body.tasks.length).toBeGreaterThanOrEqual(2);
    const ids = body.tasks.map((t) => t.id);
    expect(ids).toContain(task1.id);
    expect(ids).toContain(task2.id);
    await app.close();
  });

  it("returns 404 for a missing project", async () => {
    const { app, storage } = await buildStack();
    seedPipelineData(storage);
    const res = await app.inject({
      method: "GET",
      url: `/projects/00000000-0000-4000-8000-000000000000/tasks`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("workspace/not-found");
    await app.close();
  });
});

describe("GET /projects/:projectId/artifacts", () => {
  it("returns project-level artifacts", async () => {
    const { app, storage } = await buildStack();
    const { projectId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/artifacts` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { artifacts: Array<{ kind: string }> };
    expect(body.artifacts.length).toBeGreaterThanOrEqual(2);
    const kinds = body.artifacts.map((a) => a.kind);
    expect(kinds).toContain("spec");
    expect(kinds).toContain("plan");
    await app.close();
  });

  it("kind filtering works for project artifacts", async () => {
    const { app, storage } = await buildStack();
    const { projectId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/artifacts?kind=plan` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { artifacts: Array<{ kind: string }> };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]!.kind).toBe("plan");
    await app.close();
  });

  it("returns 404 for a missing project", async () => {
    const { app, storage } = await buildStack();
    seedPipelineData(storage);
    const res = await app.inject({
      method: "GET",
      url: `/projects/00000000-0000-4000-8000-000000000000/artifacts`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("workspace/not-found");
    await app.close();
  });
});

describe("run/project ownership enforcement", () => {
  it("pipeline run queries do not expose data from other projects", async () => {
    const { app, storage } = await buildStack();
    const { runId, projectId } = seedPipelineData(storage);

    // Create a second project with its own pipeline run
    const projectId2 = newProjectId();
    const runId2 = newRunId();
    storage.projects.insert({ id: projectId2, name: "other", rootPath: "/other", createdAt: new Date().toISOString() });
    storage.pipelineRuns.insert({
      id: runId2,
      projectId: projectId2,
      status: "completed",
      goal: "other project goal",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 100,
    });

    // Project 1 should only see its own pipeline runs
    const res1 = await app.inject({ method: "GET", url: `/projects/${projectId}/pipelines` });
    const body1 = res1.json() as { pipelines: Array<{ id: string }> };
    expect(body1.pipelines.every((p) => p.id === runId)).toBe(true);

    // Querying pipeline run 2 directly returns run 2 (ownership is per-route, not cross-project)
    const res2 = await app.inject({ method: "GET", url: `/pipelines/${runId2}` });
    expect(res2.statusCode).toBe(200);
    expect((res2.json() as { pipeline: { id: string } }).pipeline.id).toBe(runId2);

    // Pipeline run 1's events/artifacts/executions should only contain run 1 data
    const evtRes = await app.inject({ method: "GET", url: `/pipelines/${runId}/events` });
    const evts = (evtRes.json() as { events: Array<{ runId?: string }> }).events;
    expect(evts.every((e) => e.runId === runId || e.runId === undefined)).toBe(true);
    await app.close();
  });
});
