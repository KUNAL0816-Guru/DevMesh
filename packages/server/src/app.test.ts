import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
