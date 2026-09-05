import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactSchema,
  makeContextEntry,
  makeTaskCard,
  newApprovalId,
  newArtifactBase,
  newProjectId,
  newRunId,
  newTaskId,
} from "@devmesh/contracts";
import type { Storage } from "@devmesh/storage";
import { createStorage, summarizeRunUsage } from "@devmesh/storage";
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
    structured: null,
    usage: null,
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

    // unknown route → SPA fallback serves index.html
    const noRoute = await app.inject({ method: "GET", url: "/nope" });
    expect(noRoute.statusCode).toBe(200);
    expect(noRoute.headers["content-type"]).toContain("text/html");
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
    const body = res.json() as { pipeline: { id: string; status: string; goal: string } };
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

describe("POST /pipelines/:runId/cancel", () => {
  it("returns 404 for a missing pipeline", async () => {
    const { app } = await buildStack();
    const res = await app.inject({
      method: "POST",
      url: "/pipelines/00000000-0000-4000-8000-000000000000/cancel",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("pipeline/not-found");
    await app.close();
  });

  it("returns 200 for already completed pipeline (idempotent)", async () => {
    const { app, storage } = await buildStack();
    const projectId = newProjectId();
    const runId = newRunId();
    storage.projects.insert({ id: projectId, name: "cancel-test", rootPath: "/tmp/cancel", createdAt: new Date().toISOString() });
    storage.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "completed",
      goal: "done",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 100,
    });

    const res = await app.inject({ method: "POST", url: `/pipelines/${runId}/cancel`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pipeline: { status: string } };
    expect(body.pipeline.status).toBe("completed");
    await app.close();
  });

  it("returns 200 for already cancelled pipeline (idempotent)", async () => {
    const { app, storage } = await buildStack();
    const projectId = newProjectId();
    const runId = newRunId();
    storage.projects.insert({ id: projectId, name: "cancel-test2", rootPath: "/tmp/cancel2", createdAt: new Date().toISOString() });
    storage.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "cancelled",
      goal: "already cancelled",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 50,
    });

    const res = await app.inject({ method: "POST", url: `/pipelines/${runId}/cancel`, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pipeline: { status: string } };
    expect(body.pipeline.status).toBe("cancelled");
    await app.close();
  });

  it("cancels a running pipeline via API and returns 202", async () => {
    const config = testConfig();
    const storage = createStorage({ path: join(config.dataRoot, "test.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(config.dataRoot, "workspaces"),
    });
    const runtime = new FakeRuntime((_req) => ({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    }));
    const app = buildApp({
      config: { ...config, runtime: "opencode" } as typeof config,
      storage,
      workspaces,
      runtime,
      agents: createDefaultAgentRegistry(),
    });

    // Create a project and start a pipeline
    const created = await app.inject({ method: "POST", url: "/projects", payload: { name: "cancel-api" } });
    const projectId = (created.json() as { id: string }).id;
    const startRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/pipeline`,
      payload: { instruction: "long task" },
    });
    expect(startRes.statusCode).toBe(202);
    const runId = (startRes.json() as { pipeline: { runId: string } }).pipeline.runId;

    // Wait for pipeline to start
    await new Promise((r) => setTimeout(r, 300));

    // Cancel the pipeline
    const cancelRes = await app.inject({ method: "POST", url: `/pipelines/${runId}/cancel`, payload: {} });
    expect(cancelRes.statusCode).toBe(202);
    const cancelBody = cancelRes.json() as { pipeline: { id: string; status: string } };
    expect(cancelBody.pipeline.id).toBe(runId);

    // Wait for the pipeline to fully terminate
    await new Promise((r) => setTimeout(r, 1000));

    // Verify persisted state
    const getRes = await app.inject({ method: "GET", url: `/pipelines/${runId}` });
    const pipelineRun = (getRes.json() as { pipeline: { status: string } }).pipeline;
    expect(["cancelled", "running"]).toContain(pipelineRun.status);

    await app.close();
  });

  it("returns 404 for invalid run id format", async () => {
    const { app } = await buildStack();
    const res = await app.inject({
      method: "POST",
      url: "/pipelines/not-a-uuid/cancel",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
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

// ---------------------------------------------------------------------------
// Phase 7A: Context API tests
// ---------------------------------------------------------------------------

function seedContextData(storage: Storage) {
  const projectId = newProjectId();
  storage.projects.insert({ id: projectId, name: "ctx-test", rootPath: "/tmp/ctx-" + projectId, createdAt: new Date().toISOString() });

  const e1 = makeContextEntry({ namespace: "spec", key: "api-url", value: "/api/v1", createdBy: "architect" });
  const e2 = makeContextEntry({ namespace: "spec", key: "api-url", value: "/api/v2", createdBy: "architect", supersedes: e1.id });
  const e3 = makeContextEntry({ namespace: "spec", key: "db-engine", value: "sqlite", createdBy: "architect" });
  const e4 = makeContextEntry({ namespace: "decision", key: "auth-strategy", value: "jwt", createdBy: "developer" });

  storage.context.put(e1, projectId);
  storage.context.put(e2, projectId);
  storage.context.put(e3, projectId);
  storage.context.put(e4, projectId);

  return { projectId, e1, e2, e3, e4 };
}

describe("GET /projects/:projectId/context", () => {
  it("returns latest entries grouped by namespace", async () => {
    const { app, storage } = await buildStack();
    const { projectId, e2, e3, e4 } = seedContextData(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/context` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { context: { spec: Array<{ key: string; id: string }>; decision: Array<{ key: string; id: string }> } };
    expect(body.context.spec).toBeDefined();
    expect(body.context.decision).toBeDefined();
    // e2 supersedes e1, so only e2 should be latest for key "api-url"
    const specKeys = body.context.spec.map((e) => e.key);
    expect(specKeys).toContain("api-url");
    expect(specKeys).toContain("db-engine");
    // Verify superseded entry e1 is excluded
    const specUrls = body.context.spec.filter((e) => e.key === "api-url");
    expect(specUrls).toHaveLength(1);
    expect(specUrls[0]!.id).toBe(e2.id);
    // e4 is the latest for auth-strategy
    expect(body.context.decision.find((e) => e.key === "auth-strategy")!.id).toBe(e4.id);
    // db-engine entry
    expect(body.context.spec.find((e) => e.key === "db-engine")!.id).toBe(e3.id);
    await app.close();
  });

  it("returns 404 for missing project", async () => {
    const { app } = await buildStack();
    const res = await app.inject({
      method: "GET",
      url: "/projects/00000000-0000-4000-8000-000000000000/context",
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("workspace/not-found");
    await app.close();
  });

  it("returns empty context for a project with no entries", async () => {
    const { app, storage } = await buildStack();
    const projectId = newProjectId();
    storage.projects.insert({ id: projectId, name: "empty", rootPath: "/empty", createdAt: new Date().toISOString() });
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/context` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { context: Record<string, unknown[]> }).context).toEqual({});
    await app.close();
  });
});

describe("GET /projects/:projectId/context/:namespace", () => {
  it("returns only entries in the specified namespace", async () => {
    const { app, storage } = await buildStack();
    const { projectId, e2, e3, e4 } = seedContextData(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/context/spec` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { context: Array<{ key: string; id: string }> };
    expect(body.context.length).toBeGreaterThanOrEqual(2);
    const ids = body.context.map((e) => e.id);
    expect(ids).toContain(e2.id);
    expect(ids).toContain(e3.id);
    // Should not contain decision namespace entries
    expect(ids).not.toContain(e4.id);
    await app.close();
  });

  it("returns 400 for invalid namespace", async () => {
    const { app, storage } = await buildStack();
    const { projectId } = seedContextData(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/context/gossip` });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("request/invalid");
    await app.close();
  });

  it("returns 404 for missing project", async () => {
    const { app } = await buildStack();
    const res = await app.inject({
      method: "GET",
      url: "/projects/00000000-0000-4000-8000-000000000000/context/spec",
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("GET /projects/:projectId/context/:namespace/history/:key", () => {
  it("returns version chain in chronological order", async () => {
    const { app, storage } = await buildStack();
    const { projectId, e1, e2 } = seedContextData(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/context/spec/history/api-url` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { history: Array<{ id: string; supersedes?: string }> };
    expect(body.history).toHaveLength(2);
    // First entry should not have supersedes
    expect(body.history[0]!.id).toBe(e1.id);
    expect(body.history[0]!.supersedes).toBeUndefined();
    // Second entry supersedes the first
    expect(body.history[1]!.id).toBe(e2.id);
    expect(body.history[1]!.supersedes).toBe(e1.id);
    await app.close();
  });

  it("returns empty history for a nonexistent key", async () => {
    const { app, storage } = await buildStack();
    const { projectId } = seedContextData(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/context/spec/history/no-such-key` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { history: unknown[] }).history).toEqual([]);
    await app.close();
  });

  it("returns 400 for invalid namespace", async () => {
    const { app, storage } = await buildStack();
    const { projectId } = seedContextData(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/context/gossip/history/x` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for missing project", async () => {
    const { app } = await buildStack();
    const res = await app.inject({
      method: "GET",
      url: "/projects/00000000-0000-4000-8000-000000000000/context/spec/history/x",
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /projects/:projectId/context", () => {
  it("creates a new context entry with server-assigned id/timestamp", async () => {
    const { app, storage } = await buildStack();
    const { projectId } = seedContextData(storage);
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/context`,
      payload: { namespace: "convention", key: "style/lint", value: "eslint", createdBy: "system" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { context: { id: string; namespace: string; key: string; value: string; createdAt: string } };
    expect(body.context.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.context.namespace).toBe("convention");
    expect(body.context.key).toBe("style/lint");
    expect(body.context.value).toBe("eslint");
    expect(body.context.createdAt).toMatch(/Z$/);
    // Verify it's persisted
    const entry = storage.context.get(body.context.id as never);
    expect(entry).not.toBeNull();
    expect(entry!.key).toBe("style/lint");
    await app.close();
  });

  it("returns 400 for invalid body", async () => {
    const { app, storage } = await buildStack();
    const { projectId } = seedContextData(storage);
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/context`,
      payload: { namespace: "bad" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("request/invalid");
    await app.close();
  });

  it("returns 400 for invalid namespace in body", async () => {
    const { app, storage } = await buildStack();
    const { projectId } = seedContextData(storage);
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/context`,
      payload: { namespace: "nonexistent", key: "k", value: "v", createdBy: "system" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for missing project", async () => {
    const { app } = await buildStack();
    const res = await app.inject({
      method: "POST",
      url: "/projects/00000000-0000-4000-8000-000000000000/context",
      payload: { namespace: "spec", key: "k", value: "v", createdBy: "system" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("context project ownership enforcement", () => {
  it("returns 404 for context queries on non-existent projects", async () => {
    const { app, storage } = await buildStack();
    seedContextData(storage);

    const res1 = await app.inject({
      method: "GET",
      url: "/projects/00000000-0000-4000-8000-000000000000/context",
    });
    expect(res1.statusCode).toBe(404);

    const res2 = await app.inject({
      method: "GET",
      url: "/projects/00000000-0000-4000-8000-000000000000/context/spec",
    });
    expect(res2.statusCode).toBe(404);

    const res3 = await app.inject({
      method: "GET",
      url: "/projects/00000000-0000-4000-8000-000000000000/context/spec/history/api-url",
    });
    expect(res3.statusCode).toBe(404);

    const res4 = await app.inject({
      method: "POST",
      url: "/projects/00000000-0000-4000-8000-000000000000/context",
      payload: { namespace: "spec", key: "k", value: "v", createdBy: "system" },
    });
    expect(res4.statusCode).toBe(404);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 7C: POST /pipelines/:runId/resume
// ---------------------------------------------------------------------------

describe("POST /pipelines/:runId/resume", () => {
  function seedFailedPipeline(storage: Storage) {
    const projectId = newProjectId();
    const runId = newRunId();
    const now = "2026-08-01T10:00:00.000Z";

    storage.projects.insert({
      id: projectId,
      name: "resume-test",
      rootPath: "/tmp/resume-test",
      createdAt: now,
    });

    // Ensure the workspace directory exists on disk so resume can access it.
    mkdirSync("/tmp/resume-test", { recursive: true });

    storage.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "failed",
      goal: "implement feature X",
      errorMessage: "tester failed",
      createdAt: now,
      finishedAt: now,
      durationMs: 5000,
    });

    return { projectId, runId };
  }

  function seedRunningPipeline(storage: Storage) {
    const projectId = newProjectId();
    const runId = newRunId();
    const now = "2026-08-01T10:00:00.000Z";

    storage.projects.insert({
      id: projectId,
      name: "running-test",
      rootPath: "/tmp/running-test",
      createdAt: now,
    });

    storage.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "running",
      goal: "implement feature Y",
      errorMessage: null,
      createdAt: now,
      finishedAt: null,
      durationMs: null,
    });

    return { projectId, runId };
  }

  function seedCompletedPipeline(storage: Storage) {
    const projectId = newProjectId();
    const runId = newRunId();
    const now = "2026-08-01T10:00:00.000Z";

    storage.projects.insert({
      id: projectId,
      name: "completed-test",
      rootPath: "/tmp/completed-test",
      createdAt: now,
    });

    storage.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "completed",
      goal: "implement feature Z",
      errorMessage: null,
      createdAt: now,
      finishedAt: now,
      durationMs: 3000,
    });

    return { projectId, runId };
  }

  it("returns 202 for valid resume of failed pipeline", async () => {
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

    const { projectId, runId } = seedFailedPipeline(storage);

    // Create stages for the pipeline
    const stageRoles = ["architect", "developer", "tester", "reviewer"];
    for (let i = 0; i < stageRoles.length; i++) {
      storage.stages.insert({
        id: crypto.randomUUID(),
        runId,
        projectId,
        stageIndex: i,
        stageRole: stageRoles[i]!,
        status: i < 3 ? "completed" : "failed",
        executionId: null,
        taskId: null,
        startedAt: i < 3 ? "2026-08-01T10:00:01.000Z" : "2026-08-01T10:00:04.000Z",
        completedAt: i < 3 ? "2026-08-01T10:00:02.000Z" : null,
        createdAt: "2026-08-01T10:00:00.000Z",
      });
    }

    const res = await app.inject({
      method: "POST",
      url: `/pipelines/${runId}/resume`,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { pipeline: { runId: string; status: string; goal: string } };
    expect(body.pipeline).toBeDefined();
    expect(body.pipeline.runId).toBe(runId);
    expect(body.pipeline.status).toBe("running");
    expect(body.pipeline.goal).toBe("implement feature X");

    await app.close();
  });

  it("returns 404 for missing pipeline", async () => {
    const { app } = await buildStack();
    const missingId = "00000000-0000-4000-8000-000000000000";

    const res = await app.inject({
      method: "POST",
      url: `/pipelines/${missingId}/resume`,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("pipeline/not-found");

    await app.close();
  });

  it("returns 409 for running pipeline", async () => {
    const config = testConfig();
    const storage = createStorage({ path: join(config.dataRoot, "test.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(config.dataRoot, "workspaces"),
    });
    const runtime = new FakeRuntime({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed", sessionId: "ses_0", finalText: "ok" },
      stepDelayMs: 60_000,
    });
    const app = buildApp({
      config: { ...config, runtime: "opencode" } as typeof config,
      storage,
      workspaces,
      runtime,
      agents: createDefaultAgentRegistry(),
    });

    const { runId } = seedRunningPipeline(storage);

    const res = await app.inject({
      method: "POST",
      url: `/pipelines/${runId}/resume`,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("pipeline/not-resumable");
    expect(body.error.message).toContain("running");

    await app.close();
  });

  it("returns 409 for completed pipeline", async () => {
    const config = testConfig();
    const storage = createStorage({ path: join(config.dataRoot, "test.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(config.dataRoot, "workspaces"),
    });
    const app = buildApp({
      config: { ...config, runtime: "opencode" } as typeof config,
      storage,
      workspaces,
      agents: createDefaultAgentRegistry(),
    });

    const { runId } = seedCompletedPipeline(storage);

    const res = await app.inject({
      method: "POST",
      url: `/pipelines/${runId}/resume`,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("pipeline/not-resumable");
    expect(body.error.message).toContain("completed");

    await app.close();
  });

  it("returns 503 when no runtime is wired", async () => {
    const config = testConfig();
    const storage = createStorage({ path: join(config.dataRoot, "test.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(config.dataRoot, "workspaces"),
    });
    const app = buildApp({
      config: { ...config, runtime: "opencode" } as typeof config,
      storage,
      workspaces,
      agents: createDefaultAgentRegistry(),
    });

    // Seed a resumable (failed) pipeline — resume validation passes, but no
    // runtime is wired to actually perform the resume.
    const { runId } = seedFailedPipeline(storage);

    const res = await app.inject({
      method: "POST",
      url: `/pipelines/${runId}/resume`,
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe("runtime/not-configured");

    await app.close();
  });
});

describe("approvals API (Phase 9B)", () => {
  it("creates a pending approval and emits approval.requested", async () => {
    const { app, storage } = await buildStack();
    const { projectId, runId, task1 } = seedPipelineData(storage);

    const res = await app.inject({
      method: "POST",
      url: "/approvals",
      payload: {
        projectId,
        runId,
        taskId: task1.id,
        kind: "destructive_git",
        title: "Force-push",
        detail: "overwrite origin/main",
        risk: "high",
      },
    });
    expect(res.statusCode).toBe(201);
    const approval = res.json().approval as {
      id: string;
      status: string;
      kind: string;
      risk: string;
      runId: string;
      taskId: string | null;
    };
    expect(approval.status).toBe("pending");
    expect(approval.kind).toBe("destructive_git");
    expect(approval.risk).toBe("high");
    expect(approval.runId).toBe(runId);
    expect(approval.taskId).toBe(task1.id);

    const events = storage.events.listByRun(runId);
    const req = events.find((e) => e.type === "approval.requested");
    expect(req && "approvalId" in req && (req as { approvalId: string }).approvalId).toBe(approval.id);
    await app.close();
  });

  it("creates a run-scoped approval without a task", async () => {
    const { app, storage } = await buildStack();
    const { projectId, runId } = seedPipelineData(storage);

    const res = await app.inject({
      method: "POST",
      url: "/approvals",
      payload: { projectId, runId, kind: "cost_release", title: "Raise cap", risk: "medium" },
    });
    expect(res.statusCode).toBe(201);
    const approval = res.json().approval as { status: string; taskId: string | null };
    expect(approval.status).toBe("pending");
    expect(approval.taskId).toBeNull();
    await app.close();
  });

  it("rejects creation against unknown project / run / task", async () => {
    const { app, storage } = await buildStack();
    const { projectId, runId, task1 } = seedPipelineData(storage);

    const cases: Array<{ payload: Record<string, unknown>; code: string }> = [
      {
        payload: { projectId: newProjectId(), runId, taskId: task1.id, kind: "k", title: "t", risk: "low" },
        code: "workspace/not-found",
      },
      {
        payload: { projectId, runId: newRunId(), taskId: task1.id, kind: "k", title: "t", risk: "low" },
        code: "pipeline/not-found",
      },
      {
        payload: { projectId, runId, taskId: newTaskId(), kind: "k", title: "t", risk: "low" },
        code: "task/not-found",
      },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: "POST", url: "/approvals", payload: c.payload });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe(c.code);
    }
    await app.close();
  });

  it("fetches a single approval and lists pending per project", async () => {
    const { app, storage } = await buildStack();
    const { projectId, runId } = seedPipelineData(storage);

    const created = await app.inject({
      method: "POST",
      url: "/approvals",
      payload: { projectId, runId, kind: "network_egress", title: "Call external API", risk: "low" },
    });
    const approvalId = created.json().approval.id as string;
    expect(created.statusCode).toBe(201);

    const one = await app.inject({ method: "GET", url: `/approvals/${approvalId}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().approval.id).toBe(approvalId);
    expect(one.json().approval.status).toBe("pending");

    const missing = await app.inject({ method: "GET", url: `/approvals/${newApprovalId()}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("approval/not-found");

    const list = await app.inject({ method: "GET", url: `/projects/${projectId}/approvals` });
    expect(list.statusCode).toBe(200);
    expect(list.json().approvals.map((a: { id: string }) => a.id)).toContain(approvalId);
    await app.close();
  });

  it("resolves an approval and rejects double-resolution", async () => {
    const { app, storage } = await buildStack();
    const { projectId, runId } = seedPipelineData(storage);

    const created = await app.inject({
      method: "POST",
      url: "/approvals",
      payload: { projectId, runId, kind: "destructive_git", title: "Force-push", risk: "critical" },
    });
    const approvalId = created.json().approval.id as string;

    const resolved = await app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/resolve`,
      payload: { decision: "allow" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().approval.status).toBe("approved");
    expect(resolved.json().approval.decision).toBe("allow");

    const events = storage.events.listByRun(runId);
    const ev = events.find((e) => e.type === "approval.resolved");
    expect(ev && "approvalId" in ev && (ev as { approvalId: string }).approvalId).toBe(approvalId);

    const again = await app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/resolve`,
      payload: { decision: "deny" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("storage/approval-resolved");
    await app.close();
  });

  it("deny marks the approval denied, drops it from pending, unknown resolve 404s", async () => {
    const { app, storage } = await buildStack();
    const { projectId, runId } = seedPipelineData(storage);

    const created = await app.inject({
      method: "POST",
      url: "/approvals",
      payload: { projectId, runId, kind: "destructive_git", title: "Force-push", risk: "high" },
    });
    const approvalId = created.json().approval.id as string;

    const denied = await app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/resolve`,
      payload: { decision: "deny" },
    });
    expect(denied.json().approval.status).toBe("denied");

    const list = await app.inject({ method: "GET", url: `/projects/${projectId}/approvals` });
    expect(list.json().approvals.map((a: { id: string }) => a.id)).not.toContain(approvalId);

    const unknown = await app.inject({
      method: "POST",
      url: `/approvals/${newApprovalId()}/resolve`,
      payload: { decision: "allow" },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("approval/not-found");
    await app.close();
  });

  it("rejects malformed approval payloads", async () => {
    const { app } = await buildStack();
    const bad = await app.inject({
      method: "POST",
      url: "/approvals",
      payload: { projectId: "nope", runId: "nope", title: "t", risk: "urgent" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("request/invalid");

    const badList = await app.inject({ method: "GET", url: `/projects/${newProjectId()}/approvals` });
    expect(badList.statusCode).toBe(404);
    expect(badList.json().error.code).toBe("workspace/not-found");
    await app.close();
  });
});

describe("GET /pipelines/:runId/usage", () => {
  it("returns usage summary for an existing pipeline run", async () => {
    const { app, storage } = await buildStack();
    const { runId } = seedPipelineData(storage);
    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}/usage` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      usage: {
        runId: string;
        executionCount: number;
        unknownExecutionCount: number;
        totals: Record<string, unknown>;
      };
    };
    expect(body.usage.runId).toBe(runId);
    expect(body.usage.executionCount).toBeGreaterThanOrEqual(1);

    const expected = summarizeRunUsage(storage.db, runId)!;
    expect(body.usage.executionCount).toBe(expected.executionCount);
    expect(body.usage.unknownExecutionCount).toBe(expected.unknownExecutionCount);
    expect(body.usage.totals).toEqual(expected.totals);
    await app.close();
  });

  it("returns 404 for a nonexistent pipeline run", async () => {
    const { app, storage } = await buildStack();
    seedPipelineData(storage);
    const missingRun = newRunId();
    const res = await app.inject({ method: "GET", url: `/pipelines/${missingRun}/usage` });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("pipeline/not-found");
    await app.close();
  });

  it("returns usage with zero totals for a run with no executions", async () => {
    const { app, storage } = await buildStack();
    const projectId = newProjectId();
    const runId = newRunId();
    const now = "2026-08-01T10:00:00.000Z";
    storage.projects.insert({ id: projectId, name: "empty-run", rootPath: "/tmp/empty", createdAt: now });
    storage.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "completed",
      goal: "nothing",
      errorMessage: null,
      createdAt: now,
      finishedAt: now,
      durationMs: 0,
    });
    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}/usage` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { usage: { executionCount: number; unknownExecutionCount: number; totals: { inputTokens: number; outputTokens: number } } };
    expect(body.usage.executionCount).toBe(0);
    expect(body.usage.unknownExecutionCount).toBe(0);
    expect(body.usage.totals.inputTokens).toBe(0);
    expect(body.usage.totals.outputTokens).toBe(0);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 13C: Static frontend serving
// ---------------------------------------------------------------------------

describe("static frontend serving (Phase 13C)", () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "devmesh-static-"));
    mkdirSync(join(fixtureDir, "assets"), { recursive: true });
    writeFileSync(
      join(fixtureDir, "index.html"),
      "<!DOCTYPE html><html><head><title>DevMesh</title></head><body><div id=\"root\"></div></body></html>",
    );
    writeFileSync(join(fixtureDir, "assets", "app.js"), "console.log('hello');");
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("GET / returns the frontend index.html", async () => {
    const config = testConfig();
    const storage = createStorage({ path: join(config.dataRoot, "test.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(config.dataRoot, "workspaces"),
    });
    const app = buildApp({ config, storage, workspaces, staticRoot: fixtureDir });

    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("DevMesh");
    expect(res.body).toContain('id="root"');
    await app.close();
  });

  it("static assets under /assets/ are served successfully", async () => {
    const config = testConfig();
    const storage = createStorage({ path: join(config.dataRoot, "test.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(config.dataRoot, "workspaces"),
    });
    const app = buildApp({ config, storage, workspaces, staticRoot: fixtureDir });

    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log");
    await app.close();
  });

  it("API routes are still handled by the API (not the SPA fallback)", async () => {
    const config = testConfig();
    const storage = createStorage({ path: join(config.dataRoot, "test.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(config.dataRoot, "workspaces"),
    });
    const app = buildApp({ config, storage, workspaces, staticRoot: fixtureDir });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(true);

    const missing = await app.inject({ method: "GET", url: "/health/nonexistent" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("request/not-found");
    await app.close();
  });

  it("SPA fallback serves index.html for unknown frontend routes", async () => {
    const config = testConfig();
    const storage = createStorage({ path: join(config.dataRoot, "test.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(config.dataRoot, "workspaces"),
    });
    const app = buildApp({ config, storage, workspaces, staticRoot: fixtureDir });

    const res = await app.inject({ method: "GET", url: "/some-frontend-route" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("DevMesh");
    await app.close();
  });
});
