import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
