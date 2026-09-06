import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newPluginToken } from "@devmesh/contracts";
import { createStorage } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import { baselineProfile } from "@devmesh/contracts";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { type ProfileProvider } from "./policy.js";

let dataRoot: string;
let staticRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-perm-bridge-"));
  staticRoot = mkdtempSync(join(tmpdir(), "devmesh-perm-bridge-static-"));
  writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>devmesh</title>");
  mkdirSync(join(staticRoot, "assets"), { recursive: true });
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(staticRoot, { recursive: true, force: true });
});

const ASK_BASH_PROFILE: ProfileProvider = (role) =>
  role === "developer"
    ? { read: "allow", bash: { action: "ask", patterns: ["**"] } }
    : baselineProfile(role);

function buildAppStack(options: { policyBaselines?: ProfileProvider } = {}) {
  const config = loadConfig({
    DEVMESH_DATA_ROOT: dataRoot,
    DEVMESH_LOG_LEVEL: "error",
    DEVMESH_PORT: "0",
  });
  const storage = createStorage({ path: join(config.dataRoot, "test.db") });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(config.dataRoot, "workspaces"),
  });
  const app = buildApp({
    config,
    storage,
    workspaces,
    staticRoot,
    ...(options.policyBaselines ? { policyBaselines: options.policyBaselines } : {}),
  });
  return { app, storage, workspaces };
}

function createProject(workspaces: WorkspaceService, token: string) {
  return workspaces.create(`bridge-${crypto.randomUUID().slice(0, 8)}`, { pluginToken: token });
}

function toolRequest(projectId: string, token: string, overrides: Record<string, unknown> = {}) {
  return {
    method: "POST" as const,
    url: "/permissions/tool",
    headers: { "x-devmesh-project-token": token, "content-type": "application/json" },
    payload: {
      role: "developer",
      tool: "read",
      target: "src/a.ts",
      projectId,
      runId: randomUUID(),
      ...overrides,
    },
  };
}

describe("Phase 14D security: POST /permissions/tool plugin bridge", () => {
  it("401s a request with NO token header (fail closed)", async () => {
    const { app } = buildAppStack();
    const res = await app.inject({
      method: "POST",
      url: "/permissions/tool",
      payload: { role: "developer", tool: "read", projectId: "p", runId: "r" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("plugin/auth-required");
  });

  it("401s an empty token header", async () => {
    const { app } = buildAppStack();
    const res = await app.inject(
      toolRequest("00000000-0000-0000-0000-000000000010", "", {
        role: "developer",
      }),
    );
    expect(res.statusCode).toBe(401);
  });

  it("401s a known project with a WRONG token (constant-time compare)", async () => {
    const { app, workspaces } = buildAppStack();
    const handle = createProject(workspaces, "dpk_correct_token");
    const res = await app.inject(toolRequest(handle.projectId, "dpk_wrong_token"));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("plugin/auth-invalid");
  });

  it("401s an UNKNOWN project even with a plausible token (no oracle)", async () => {
    const { app } = buildAppStack();
    const res = await app.inject(toolRequest(randomUUID(), "dpk_unknown"));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe("plugin/auth-invalid");
  });

  it("401s cross-project token use: a token for A cannot query B", async () => {
    const { app, workspaces } = buildAppStack();
    const a = createProject(workspaces, "dpk_token_a");
    const b = createProject(workspaces, "dpk_token_b");
    // Project A's token used against project B.
    const res = await app.inject(toolRequest(b.projectId, "dpk_token_a"));
    expect(res.statusCode).toBe(401);
    // And project B's token targetting project A.
    const res2 = await app.inject(toolRequest(a.projectId, "dpk_token_b"));
    expect(res2.statusCode).toBe(401);
  });

  it("returns allow for a mapped read-class tool under the default posture", async () => {
    const { app, workspaces } = buildAppStack();
    const handle = createProject(workspaces, "dpk_ok");
    const res = await app.inject(
      toolRequest(handle.projectId, "dpk_ok", { tool: "grep", target: "src/" }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      decision: "allow",
      action: "allow",
      resource: "read",
      tool: "grep",
    });
    expect(body.reason).toBeTruthy();
  });

  it("quotes the canonical ask disposition for the default bash posture (plugin then denies)", async () => {
    const { app, workspaces } = buildAppStack();
    const handle = createProject(workspaces, "dpk_ok");
    // DEVMESH_AGENT_ROLE=developer default: bash "ask" on "npm test*".
    const res = await app.inject(
      toolRequest(handle.projectId, "dpk_ok", { tool: "bash", target: "npm test" }),
    );
    expect(res.statusCode).toBe(200);
    // The canonical engine returns the developer posture (ask); the upstream
    // plugin cannot prompt and rejects it (fail closed). Never allow.
    const body = JSON.parse(res.body);
    expect(body.decision).toBe("ask");
    expect(body.decision).not.toBe("allow");
  });

  it("returns an ask decision verbatim when the shared policy asks", async () => {
    const { app, workspaces } = buildAppStack({ policyBaselines: ASK_BASH_PROFILE });
    const handle = createProject(workspaces, "dpk_ask");
    const res = await app.inject(
      toolRequest(handle.projectId, "dpk_ask", {
        tool: "bash",
        target: "git push",
        taskId: randomUUID(),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).decision).toBe("ask");
  });

  it("denies an UNKNOWN tool with no resource mapping (fail closed, no info leak)", async () => {
    const { app, workspaces } = buildAppStack();
    const handle = createProject(workspaces, "dpk_ok");
    const res = await app.inject(
      toolRequest(handle.projectId, "dpk_ok", { tool: "some_future_tool" }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.decision).toBe("deny");
    expect(body).not.toHaveProperty("resource");
  });

  it("400s a malformed body (invalid projectId) even with a valid token", async () => {
    const { app, workspaces } = buildAppStack();
    const handle = createProject(workspaces, "dpk_ok");
    const res = await app.inject(
      toolRequest(handle.projectId, "dpk_ok", { projectId: "not-a-project-id" }),
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("request/invalid");
  });

  it("400s a malformed body (missing role) with no 401/500", async () => {
    const { app, workspaces } = buildAppStack();
    const handle = createProject(workspaces, "dpk_ok");
    const res = await app.inject({
      method: "POST",
      url: "/permissions/tool",
      headers: { "x-devmesh-project-token": "dpk_ok", "content-type": "application/json" },
      payload: { tool: "read", projectId: handle.projectId, runId: "r" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s unknown /permissions/* paths with JSON (not the SPA shell)", async () => {
    const { app } = buildAppStack();
    const res = await app.inject({ method: "POST", url: "/permissions/nope" });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error?.code).toBe("request/not-found");
    expect(res.body).not.toContain("<!doctype html>");
  });
});

describe("Phase 14D: per-project plugin token lifecycle", () => {
  it("gives every created project a plugin token WITHOUT exposing it via the API", async () => {
    const { app, storage, workspaces } = buildAppStack();
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: `tok-${crypto.randomUUID().slice(0, 8)}` },
    });
    expect(res.statusCode).toBe(201);
    const created = JSON.parse(res.body);
    expect(created).not.toHaveProperty("pluginToken");
    expect(created).not.toHaveProperty("plugin_token");
    const stored = storage.projects.get(created.id);
    expect(typeof stored?.pluginToken).toBe("string");
    expect(stored!.pluginToken!.length).toBeGreaterThan(16);
    // The versioned token is unique per project.
    const b = createProject(workspaces, newPluginToken());
    expect(b.projectId).not.toBe(created.id);
    expect(storage.projects.get(created.id)!.pluginToken).not.toBe(
      storage.projects.get(b.projectId)!.pluginToken,
    );
  });
});

describe("Phase 14D: bridge reuses the shared policy engine (no second authority)", () => {
  it("is not silently sidestepped by the bearer API auth (no operator token required)", async () => {
    const { app, workspaces } = buildAppStack();
    const handle = createProject(workspaces, "dpk_ok");
    // No Authorization header at all: still works via the project token.
    const res = await app.inject({
      method: "POST",
      url: "/permissions/tool",
      headers: { "x-devmesh-project-token": "dpk_ok", "content-type": "application/json" },
      payload: {
        role: "developer",
        tool: "read",
        projectId: handle.projectId,
        runId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).decision).toBe("allow");
  });
});