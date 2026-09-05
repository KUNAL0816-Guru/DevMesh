import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  artifactSchema,
  newApprovalId,
  newArtifactBase,
  newProjectId,
  newRunId,
  makeContextEntry,
  projectIdSchema,
} from "@devmesh/contracts";
import type { ProjectId, RunId } from "@devmesh/contracts";
import { createStorage } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { registerAuth } from "./auth.js";
import Fastify from "fastify";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-auth-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

function authConfig(token?: string) {
  return loadConfig({
    DEVMESH_DATA_ROOT: dataRoot,
    DEVMESH_LOG_LEVEL: "error",
    DEVMESH_PORT: "0",
    ...(token ? { DEVMESH_AUTH_TOKEN: token } : {}),
  });
}

async function buildStack(opts?: { bearerToken?: string; staticRoot?: string }) {
  const config = authConfig(opts?.bearerToken);
  const storage = createStorage({ path: join(config.dataRoot, "test.db") });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(config.dataRoot, "workspaces"),
  });
  const app = buildApp({
    config,
    storage,
    workspaces,
    staticRoot: opts?.staticRoot,
  });
  return { app, storage };
}

const TEST_TOKEN = "test-secret-token-12345";

// ---------------------------------------------------------------------------
// 1. Authentication disabled preserves existing single-user behavior
// ---------------------------------------------------------------------------
describe("Phase 14A: auth disabled (single-user mode)", () => {
  it("GET /health works without auth", async () => {
    const { app } = await buildStack();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it("GET /projects works without auth", async () => {
    const { app } = await buildStack();
    const res = await app.inject({ method: "GET", url: "/projects" });
    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toEqual([]);
    await app.close();
  });

  it("POST /projects works without auth", async () => {
    const { app } = await buildStack();
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "auth-test" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("auth-test");
    await app.close();
  });

  it("GET /auth/me returns default principal when auth disabled", async () => {
    const { app } = await buildStack();
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("devmesh:default");
    expect(body.method).toBe("bearer");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Authentication enabled + valid Bearer token succeeds
// ---------------------------------------------------------------------------
describe("Phase 14A: auth enabled — valid token", () => {
  it("GET /projects succeeds with valid Bearer token", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().projects).toEqual([]);
    await app.close();
  });

  it("POST /projects succeeds with valid Bearer token", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "authed-project" },
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe("authed-project");
    await app.close();
  });

  it("GET /auth/me returns the authenticated principal", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe("devmesh:default");
    expect(body.method).toBe("bearer");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Authentication enabled + missing Authorization header → 401
// ---------------------------------------------------------------------------
describe("Phase 14A: auth enabled — missing header", () => {
  it("returns 401 for GET /projects without Authorization header", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({ method: "GET", url: "/projects" });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("auth/unauthenticated");
    expect(body.error.message).toBe("missing credentials");
    await app.close();
  });

  it("returns 401 for POST /projects without Authorization header", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "nope" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("auth/unauthenticated");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Authentication enabled + malformed Authorization header → 401
// ---------------------------------------------------------------------------
describe("Phase 14A: auth enabled — malformed header", () => {
  it("returns 401 for 'Basic' scheme", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("auth/unauthenticated");
    expect(body.error.message).toBe("invalid credentials");
    await app.close();
  });

  it("returns 401 for 'Bearer' without token", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("auth/unauthenticated");
    await app.close();
  });

  it("returns 401 for completely malformed header", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: "not-a-header" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("auth/unauthenticated");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Authentication enabled + invalid token → 401
// ---------------------------------------------------------------------------
describe("Phase 14A: auth enabled — invalid token", () => {
  it("returns 401 for wrong token", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: "Bearer wrong-token-value" },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("auth/unauthenticated");
    expect(body.error.message).toBe("invalid credentials");
    await app.close();
  });

  it("returns 401 for partially matching token", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: `Bearer ${TEST_TOKEN.slice(0, -2)}XX` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("auth/unauthenticated");
    await app.close();
  });

  it("returns 401 for empty Bearer token", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: "Bearer " },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("auth/unauthenticated");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Successful authentication exposes the expected principal/context
// ---------------------------------------------------------------------------
describe("Phase 14A: principal context", () => {
  it("authenticated request has principal with expected shape", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const principal = res.json();
    expect(principal).toEqual({ id: "devmesh:default", method: "bearer" });
    await app.close();
  });

  it("unauthenticated request to /auth/me returns 401 when auth enabled", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("auth/unauthenticated");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 7. Authentication failure does not leak the credential
// ---------------------------------------------------------------------------
describe("Phase 14A: no credential leakage", () => {
  it("401 error response does not contain the supplied token", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const supplied = "Bearer leaked-token-value";
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: supplied },
    });
    expect(res.statusCode).toBe(401);
    const raw = res.body;
    expect(raw).not.toContain("leaked-token-value");
    expect(raw).not.toContain("Bearer");
    await app.close();
  });

  it("401 error response does not contain the configured token", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
    const raw = res.body;
    expect(raw).not.toContain(TEST_TOKEN);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 8. Existing error envelope remains consistent
// ---------------------------------------------------------------------------
describe("Phase 14A: error envelope consistency", () => {
  it("auth failure follows the standard {error: {code, message}} envelope", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({ method: "GET", url: "/projects" });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toHaveProperty("code");
    expect(body.error).toHaveProperty("message");
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
    await app.close();
  });

  it("non-auth error envelope is unaffected by auth", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      payload: {},
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("request/invalid");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// 9. Health and static assets remain correct with auth enabled
// ---------------------------------------------------------------------------
describe("Phase 14A: auth boundary — health and static", () => {
  it("/health is unauthenticated when auth is enabled", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await app.close();
  });

  it("static assets are unauthenticated when auth is enabled", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "devmesh-auth-static-"));
    mkdirSync(join(fixtureDir, "assets"), { recursive: true });
    writeFileSync(join(fixtureDir, "index.html"), "<!DOCTYPE html><html><body>Test</body></html>");
    writeFileSync(join(fixtureDir, "assets", "app.js"), "console.log('hello');");

    try {
      const { app } = await buildStack({ bearerToken: TEST_TOKEN, staticRoot: fixtureDir });

      // index.html served from /
      const indexRes = await app.inject({ method: "GET", url: "/" });
      expect(indexRes.statusCode).toBe(200);
      expect(indexRes.headers["content-type"]).toContain("text/html");

      // static asset
      const jsRes = await app.inject({ method: "GET", url: "/assets/app.js" });
      expect(jsRes.statusCode).toBe(200);
      expect(jsRes.body).toContain("console.log");

      await app.close();
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it("SPA fallback is unauthenticated when auth is enabled", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "devmesh-auth-spa-"));
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, "index.html"), "<!DOCTYPE html><html><body>SPA</body></html>");

    try {
      const { app } = await buildStack({ bearerToken: TEST_TOKEN, staticRoot: fixtureDir });

      // SPA fallback for unknown route
      const res = await app.inject({ method: "GET", url: "/some-frontend-route" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("SPA");

      await app.close();
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Config validation tests
// ---------------------------------------------------------------------------
describe("Phase 14A: auth config", () => {
  it("DEVMESH_AUTH_TOKEN enables auth", () => {
    const config = loadConfig({
      DEVMESH_DATA_ROOT: dataRoot,
      DEVMESH_AUTH_TOKEN: "my-token",
    });
    expect(config.auth?.bearerToken).toBe("my-token");
  });

  it("no DEVMESH_AUTH_TOKEN leaves auth absent (single-user mode)", () => {
    const config = loadConfig({
      DEVMESH_DATA_ROOT: dataRoot,
    });
    expect(config.auth).toBeUndefined();
  });

  it("DEVMESH_AUTH_TOKEN with empty string is treated as no token (single-user mode)", () => {
    const config = loadConfig({
      DEVMESH_DATA_ROOT: dataRoot,
      DEVMESH_AUTH_TOKEN: "",
    });
    expect(config.auth).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// registerAuth hook standalone tests
// ---------------------------------------------------------------------------
describe("Phase 14A: registerAuth hook", () => {
  it("does not register a hook when auth config is null", async () => {
    const app = Fastify();
    registerAuth(app, null);
    // No hook registered — any route should pass through.
    app.get("/test", async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects unauthenticated API requests when hook is active", async () => {
    const app = Fastify();
    registerAuth(app, { enabled: true, bearerToken: "hook-token" });
    app.get("/projects", async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/projects" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("passes authenticated API requests when hook is active", async () => {
    const app = Fastify();
    registerAuth(app, { enabled: true, bearerToken: "hook-token" });
    app.get("/projects", async (req) => ({ auth: req.auth }));
    const res = await app.inject({
      method: "GET",
      url: "/projects",
      headers: { authorization: "Bearer hook-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().auth).toEqual({ id: "devmesh:default", method: "bearer" });
    await app.close();
  });

  it("skips /health even when hook is active", async () => {
    const app = Fastify();
    registerAuth(app, { enabled: true, bearerToken: "hook-token" });
    app.get("/health", async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("skips non-API paths (static assets, SPA routes) when hook is active", async () => {
    const app = Fastify();
    registerAuth(app, { enabled: true, bearerToken: "hook-token" });
    app.get("/assets/app.js", async () => "js content");
    app.get("/", async () => "index html");
    app.get("/some-frontend-route", async () => "spa fallback");

    // Static asset with file extension
    const jsRes = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(jsRes.statusCode).toBe(200);

    // Root path (SPA index)
    const rootRes = await app.inject({ method: "GET", url: "/" });
    expect(rootRes.statusCode).toBe(200);

    // SPA fallback
    const spaRes = await app.inject({ method: "GET", url: "/some-frontend-route" });
    expect(spaRes.statusCode).toBe(200);

    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Default principal in single-user mode via /auth/me
// ---------------------------------------------------------------------------
describe("Phase 14A: /auth/me default principal", () => {
  it("returns {id, method} in single-user mode", async () => {
    const { app } = await buildStack();
    const res = await app.inject({ method: "GET", url: "/auth/me" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ id: "devmesh:default", method: "bearer" });
    await app.close();
  });

  it("/auth/me is recognized as API route (not SPA fallback)", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "devmesh-auth-me-"));
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, "index.html"), "<html></html>");
    try {
      const { app } = await buildStack({ staticRoot: fixtureDir });
      const res = await app.inject({ method: "GET", url: "/auth/me" });
      // Should return JSON, not HTML
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json().id).toBe("devmesh:default");
      await app.close();
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 14B: per-project authorization
// ---------------------------------------------------------------------------

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

/** Insert a foreign project (belonging to another principal) directly. */
function seedForeignProject(storage: ReturnType<typeof createStorage>, name = "foreign") {
  const projectId = newProjectId();
  storage.projects.insert({
    id: projectId,
    name,
    rootPath: `/tmp/${name}-${projectId}`,
    createdAt: new Date().toISOString(),
    ownerPrincipalId: "someone:else",
  });
  return projectId;
}

describe("Phase 14B: per-project authorization", () => {
  it("project creation stamps the authenticated principal as owner", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await app.inject({ method: "POST", url: "/projects", payload: { name: "mine" }, headers: AUTH });
    expect(res.statusCode).toBe(201);
    const projectId = projectIdSchema.parse((res.json() as { id: string }).id);
    expect(storage.projects.get(projectId)?.ownerPrincipalId).toBe("devmesh:default");
    await app.close();
  });

  it("GET /projects lists only owned projects when authenticated", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const owned = await app.inject({ method: "POST", url: "/projects", payload: { name: "mine" }, headers: AUTH });
    const ownedId = (owned.json() as { id: string }).id;
    const foreignId = seedForeignProject(storage);

    const res = await app.inject({ method: "GET", url: "/projects", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { projects: Array<{ id: string }> }).projects.map((p) => p.id);
    expect(ids).toContain(ownedId);
    expect(ids).not.toContain(foreignId);
    await app.close();
  });

  it("rejects access to another principal's project with 403", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const foreignId = seedForeignProject(storage);

    const res = await app.inject({ method: "GET", url: `/projects/${foreignId}`, headers: AUTH });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("auth/forbidden");
    await app.close();
  });

  it("project-scoped routes reject foreign projects with 403", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const foreignId = seedForeignProject(storage);

    for (const url of [
      `/projects/${foreignId}/pipelines`,
      `/projects/${foreignId}/tasks`,
      `/projects/${foreignId}/artifacts`,
      `/projects/${foreignId}/context`,
      `/projects/${foreignId}/approvals`,
      `/projects/${foreignId}/executions`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: AUTH });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth/forbidden");
    }
    await app.close();
  });

  it("pipeline-scoped routes reject runs in foreign projects with 403", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const foreignId = seedForeignProject(storage);
    const runId = newRunId();
    storage.pipelineRuns.insert({
      id: runId,
      projectId: foreignId,
      status: "failed",
      goal: "foreign goal",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    });

    for (const url of [
      `/pipelines/${runId}`,
      `/pipelines/${runId}/tasks`,
      `/pipelines/${runId}/events`,
      `/pipelines/${runId}/artifacts`,
      `/pipelines/${runId}/executions`,
      `/pipelines/${runId}/usage`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: AUTH });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth/forbidden");
    }
    await app.close();
  });

  it("approval endpoints reject foreign-project approvals with 403", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const foreignId = seedForeignProject(storage);
    const runId = newRunId();
    const approvalId = newApprovalId();
    storage.approvals.insert({
      id: approvalId,
      projectId: foreignId,
      runId,
      taskId: null,
      kind: "destructive_git",
      title: "Force push",
      detail: "",
      risk: "high",
      status: "pending",
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      decision: null,
      decidedBy: null,
    });

    const fetchRes = await app.inject({ method: "GET", url: `/approvals/${approvalId}`, headers: AUTH });
    expect(fetchRes.statusCode).toBe(403);
    const resolveRes = await app.inject({
      method: "POST",
      url: `/approvals/${approvalId}/resolve`,
      payload: { decision: "allow" },
      headers: AUTH,
    });
    expect(resolveRes.statusCode).toBe(403);
    await app.close();
  });

  it("authorized principal can read their own project pipelines", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const owned = await app.inject({ method: "POST", url: "/projects", payload: { name: "mine" }, headers: AUTH });
    const projectId = (owned.json() as { id: string }).id;
    const runId = newRunId();
    storage.pipelineRuns.insert({
      id: runId,
      projectId,
      status: "completed",
      goal: "my goal",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 5,
    });

    const res = await app.inject({ method: "GET", url: `/pipelines/${runId}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { pipeline: { projectId: string } }).pipeline.projectId).toBe(projectId);
    await app.close();
  });

  it("context entries are scoped per project across the API", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const mk = await app.inject({ method: "POST", url: "/projects", payload: { name: "alpha" }, headers: AUTH });
    const other = await app.inject({ method: "POST", url: "/projects", payload: { name: "beta" }, headers: AUTH });
    const aId = (mk.json() as { id: string }).id;
    const bId = (other.json() as { id: string }).id;

    for (const projectId of [aId, bId]) {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${projectId}/context`,
        payload: { namespace: "decision", key: "auth-strategy", value: projectId, createdBy: "system" },
        headers: AUTH,
      });
      expect(res.statusCode).toBe(201);
    }

    const aList = await app.inject({ method: "GET", url: `/projects/${aId}/context`, headers: AUTH });
    const aEntries: Array<{ value: string }> = (aList.json() as { context: { decision: Array<{ value: string }> } }).context.decision ?? [];
    expect(aEntries.map((e) => e.value)).toEqual([aId]);

    const bList = await app.inject({ method: "GET", url: `/projects/${bId}/context`, headers: AUTH });
    const bEntries: Array<{ value: string }> = (bList.json() as { context: { decision: Array<{ value: string }> } }).context.decision ?? [];
    expect(bEntries.map((e) => e.value)).toEqual([bId]);
    await app.close();
  });

  it("single-user mode does not enforce ownership (legacy behavior)", async () => {
    const { app, storage } = await buildStack();
    const foreignId = seedForeignProject(storage);
    const projectRes = await app.inject({ method: "GET", url: `/projects/${foreignId}` });
    expect(projectRes.statusCode).toBe(200);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Phase 14B: IDOR isolation matrix
// ---------------------------------------------------------------------------

function seedRun(storage: ReturnType<typeof createStorage>, projectId: ProjectId) {
  const runId = newRunId();
  storage.pipelineRuns.insert({
    id: runId,
    projectId,
    status: "failed",
    goal: "foreign goal",
    errorMessage: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
  });
  return runId;
}

function seedExecution(storage: ReturnType<typeof createStorage>, projectId: ProjectId, runId: RunId) {
  const executionId = crypto.randomUUID();
  const now = new Date().toISOString();
  storage.executions.insert({
    id: executionId,
    runId,
    projectId,
    taskId: null,
    agentId: "architect",
    role: "architect",
    runtime: "fake",
    status: "failed",
    failureKind: null,
    instruction: "foreign",
    sessionRef: null,
    exitCode: 1,
    stoppedReason: null,
    errorMessage: "boom",
    stdoutTail: null,
    stderrTail: null,
    replyText: null,
    startedAt: now,
    finishedAt: now,
    durationMs: 10,
    resultArtifactId: null,
    verificationArtifactId: null,
    structured: null,
    usage: null,
  });
  return executionId;
}

function seedArtifact(storage: ReturnType<typeof createStorage>, projectId: ProjectId, runId: RunId) {
  const spec = artifactSchema.parse({
    kind: "spec",
    ...newArtifactBase({ runId, projectId, producedBy: "architect" }),
    payload: {
      title: "Foreign spec",
      summary: "s",
      goals: ["g"],
      nonGoals: [],
      constraints: [],
      techStack: [],
      risks: [],
      openQuestions: [],
    },
  });
  storage.artifacts.insert(spec);
  return spec.id;
}

function seedApproval(storage: ReturnType<typeof createStorage>, projectId: ProjectId, runId: RunId) {
  const approvalId = newApprovalId();
  storage.approvals.insert({
    id: approvalId,
    projectId,
    runId,
    taskId: null,
    kind: "destructive_git",
    title: "Foreign force push",
    detail: "",
    risk: "high",
    status: "pending",
    requestedAt: new Date().toISOString(),
    resolvedAt: null,
    decision: null,
    decidedBy: null,
  });
  return approvalId;
}

function seedContext(storage: ReturnType<typeof createStorage>, projectId: ProjectId) {
  const entry = makeContextEntry({
    namespace: "decision",
    key: "foreign-secret",
    value: "do-not-leak",
    createdBy: "architect",
  });
  storage.context.put(entry, projectId);
  return entry;
}

function fullForeignFixture(storage: ReturnType<typeof createStorage>) {
  const projectId = seedForeignProject(storage);
  const runId = seedRun(storage, projectId);
  return {
    projectId,
    runId,
    executionId: seedExecution(storage, projectId, runId),
    artifactId: seedArtifact(storage, projectId, runId),
    approvalId: seedApproval(storage, projectId, runId),
    contextEntry: seedContext(storage, projectId),
  };
}

describe("Phase 14B: IDOR isolation matrix", () => {
  it("all GET routes under a foreign project return 403", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const fx = fullForeignFixture(storage);
    const urls = [
      `/projects/${fx.projectId}`,
      `/projects/${fx.projectId}/pipelines`,
      `/projects/${fx.projectId}/tasks`,
      `/projects/${fx.projectId}/artifacts`,
      `/projects/${fx.projectId}/executions`,
      `/projects/${fx.projectId}/context`,
      `/projects/${fx.projectId}/context/decision`,
      `/projects/${fx.projectId}/context/decision/history/customers`,
      `/projects/${fx.projectId}/approvals`,
    ];
    const ctxKey = fx.contextEntry.key;
    const sel = `/projects/${fx.projectId}/context/decision/history/${encodeURIComponent(ctxKey)}`;
    urls.push(sel);
    for (const url of urls) {
      const res = await app.inject({ method: "GET", url, headers: AUTH });
      expect(res.statusCode, url).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth/forbidden");
    }
    await app.close();
  });

  it("all mutating project-scoped routes under a foreign project return 403", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const fx = fullForeignFixture(storage);
    const cases: Array<{ method: "POST"; url: string; payload: Record<string, unknown> }> = [
      {
        method: "POST",
        url: `/projects/${fx.projectId}/executions`,
        payload: { taskId: crypto.randomUUID(), reason: "hijack" },
      },
      {
        method: "POST",
        url: `/projects/${fx.projectId}/pipeline`,
        payload: {},
      },
      {
        method: "POST",
        url: `/projects/${fx.projectId}/context`,
        payload: { namespace: "decision", key: "k", value: "v", createdBy: "system" },
      },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: c.method, url: c.url, payload: c.payload, headers: AUTH });
      expect(res.statusCode, c.url).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth/forbidden");
    }
    await app.close();
  });

  it("all routes under a foreign run return 403 (including mutations and SSE)", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const fx = fullForeignFixture(storage);
    const getUrls = [
      `/pipelines/${fx.runId}`,
      `/pipelines/${fx.runId}/tasks`,
      `/pipelines/${fx.runId}/events`,
      `/pipelines/${fx.runId}/events/stream`,
      `/pipelines/${fx.runId}/artifacts`,
      `/pipelines/${fx.runId}/executions`,
      `/pipelines/${fx.runId}/usage`,
    ];
    for (const url of getUrls) {
      const res = await app.inject({ method: "GET", url, headers: AUTH });
      expect(res.statusCode, url).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth/forbidden");
    }
    const cancel = await app.inject({ method: "POST", url: `/pipelines/${fx.runId}/cancel`, headers: AUTH });
    expect(cancel.statusCode).toBe(403);
    const resume = await app.inject({ method: "POST", url: `/pipelines/${fx.runId}/resume`, headers: AUTH });
    expect(resume.statusCode).toBe(403);
    await app.close();
  });

  it("execution get and cancel on a foreign execution return 403", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const fx = fullForeignFixture(storage);
    const get = await app.inject({ method: "GET", url: `/executions/${fx.executionId}`, headers: AUTH });
    expect(get.statusCode).toBe(403);
    const cancel = await app.inject({
      method: "POST",
      url: `/executions/${fx.executionId}/cancel`,
      headers: AUTH,
    });
    expect(cancel.statusCode).toBe(403);
    await app.close();
  });

  it("approval get, resolve, and create against a foreign project return 403", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const fx = fullForeignFixture(storage);

    const get = await app.inject({ method: "GET", url: `/approvals/${fx.approvalId}`, headers: AUTH });
    expect(get.statusCode).toBe(403);
    const resolve = await app.inject({
      method: "POST",
      url: `/approvals/${fx.approvalId}/resolve`,
      payload: { decision: "allow" },
      headers: AUTH,
    });
    expect(resolve.statusCode).toBe(403);

    // Create referencing the foreign run (even with a matching foreign projectId).
    const createForeign = await app.inject({
      method: "POST",
      url: "/approvals",
      payload: {
        projectId: fx.projectId,
        runId: fx.runId,
        kind: "destructive_git",
        title: "t",
        detail: "",
        risk: "high",
      },
      headers: AUTH,
    });
    expect(createForeign.statusCode).toBe(403);
    await app.close();
  });

  it("POST /approvals with own projectId but foreign runId is denied (projectId is derived from the run)", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const owned = await app.inject({ method: "POST", url: "/projects", payload: { name: "mine" }, headers: AUTH });
    const ownedId = (owned.json() as { id: string }).id;
    // Run belongs to a foreign project.
    const fx = fullForeignFixture(storage);

    const res = await app.inject({
      method: "POST",
      url: "/approvals",
      payload: {
        projectId: ownedId,
        runId: fx.runId,
        kind: "destructive_git",
        title: "t",
        detail: "",
        risk: "high",
      },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("auth/forbidden");
    await app.close();
  });

  it("POST /approvals with foreign projectId but own runId is rejected as mismatched", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const owned = await app.inject({ method: "POST", url: "/projects", payload: { name: "mine" }, headers: AUTH });
    const ownedId = (owned.json() as { id: string }).id;
    const runId = seedRun(storage, projectIdSchema.parse(ownedId));
    const foreignId = seedForeignProject(storage);

    const res = await app.inject({
      method: "POST",
      url: "/approvals",
      payload: {
        projectId: foreignId,
        runId,
        kind: "destructive_git",
        title: "t",
        detail: "",
        risk: "high",
      },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("request/invalid");
    await app.close();
  });

  it("POST /approvals with consistent own projectId + runId succeeds", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const owned = await app.inject({ method: "POST", url: "/projects", payload: { name: "mine" }, headers: AUTH });
    const ownedId = (owned.json() as { id: string }).id;
    const runId = seedRun(storage, projectIdSchema.parse(ownedId));

    const res = await app.inject({
      method: "POST",
      url: "/approvals",
      payload: {
        projectId: ownedId,
        runId,
        kind: "destructive_git",
        title: "t",
        detail: "",
        risk: "high",
      },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(201);
    const approval = res.json() as { approval: { projectId: string; runId: string } };
    expect(approval.approval.projectId).toBe(ownedId);
    expect(approval.approval.runId).toBe(runId);
    await app.close();
  });

  it("foreign artifacts are not reachable via the owner's project artifact listing", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const fx = fullForeignFixture(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${fx.projectId}/artifacts`, headers: AUTH });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: { code: string } }).error.code).toBe("auth/forbidden");
    await app.close();
  });

  it("unauthenticated access to a foreign resource returns 401, not 403", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const fx = fullForeignFixture(storage);
    const res = await app.inject({ method: "GET", url: `/projects/${fx.projectId}` });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe("auth/unauthenticated");
    await app.close();
  });
});
