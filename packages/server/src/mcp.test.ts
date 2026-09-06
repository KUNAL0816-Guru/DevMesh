import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeContextEntry, newApprovalId, newArtifactBase, newProjectId, newRunId, artifactSchema } from "@devmesh/contracts";
import type { ProjectId, RunId } from "@devmesh/contracts";
import { createStorage } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-mcp-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

async function buildStack(opts?: { bearerToken?: string }) {
  const config = loadConfig({
    DEVMESH_DATA_ROOT: dataRoot,
    DEVMESH_LOG_LEVEL: "error",
    DEVMESH_PORT: "0",
    ...(opts?.bearerToken ? { DEVMESH_AUTH_TOKEN: opts.bearerToken } : {}),
  });
  const storage = createStorage({ path: join(config.dataRoot, "test.db") });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(config.dataRoot, "workspaces"),
  });
  const app = buildApp({ config, storage, workspaces });
  return { app, storage };
}

type TestApp = Awaited<ReturnType<typeof buildStack>>["app"];
type TestStorage = ReturnType<typeof createStorage>;

const TEST_TOKEN = "test-secret-token-12345";
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };
const MCP_HEADERS = { accept: "application/json, text/event-stream", "content-type": "application/json" };

function rpcMessage(id: number, method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

async function postMcp(app: TestApp, message: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, ...headers },
    payload: JSON.stringify(message),
  });
}

function initialize(id: number) {
  return rpcMessage(id, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-http-test", version: "0.0.0" },
  });
}

interface JsonRpcEnvelope {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Parse a streamable-HTTP response body, accepting both JSON and SSE framing. */
function parseMcpBody(body: string): JsonRpcEnvelope {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpcEnvelope;
  }
  const frames: Array<Record<string, unknown>> = [];
  for (const block of trimmed.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload) frames.push(JSON.parse(payload) as Record<string, unknown>);
      }
    }
  }
  const withId = frames.find((f) => typeof f.id === "number");
  if (withId) return withId as unknown as JsonRpcEnvelope;
  if (frames.length > 0) return frames[0] as unknown as JsonRpcEnvelope;
  throw new Error(`unable to parse MCP body: ${body.slice(0, 120)}`);
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

async function toolCall(
  app: TestApp,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = AUTH,
): Promise<{ status: number; result: ToolResult; raw: string }> {
  const res = await postMcp(app, rpcMessage(99, "tools/call", { name, arguments: args }), headers);
  const body = parseMcpBody(res.body);
  if (body.error) {
    throw new Error(`tools/call ${name} failed with JSON-RPC error ${body.error.code}: ${body.error.message}`);
  }
  return { status: res.statusCode, result: body.result as ToolResult, raw: res.body };
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text).join("");
}

function seedProject(
  storage: TestStorage,
  opts: { owner: string; name: string; rootPath: string; pluginToken: string },
): ProjectId {
  const projectId = newProjectId();
  storage.projects.insert({
    id: projectId,
    name: opts.name,
    rootPath: opts.rootPath,
    createdAt: new Date().toISOString(),
    ownerPrincipalId: opts.owner,
    pluginToken: opts.pluginToken,
  });
  return projectId;
}

function seedOwned(storage: TestStorage, name = "mine"): ProjectId {
  const id = seedProject(storage, {
    owner: "devmesh:default",
    name,
    rootPath: `/tmp/devmesh-hidden-root-${newProjectId()}`,
    pluginToken: "dpk_owned_super_secret",
  });
  return id;
}

function seedForeign(storage: TestStorage): ProjectId {
  const id = seedProject(storage, {
    owner: "someone:else",
    name: "foreign",
    rootPath: `/tmp/foreign-root-${newProjectId()}`,
    pluginToken: "dpk_foreign_super_secret",
  });
  return id;
}

function seedRun(storage: TestStorage, projectId: ProjectId): RunId {
  const runId = newRunId();
  storage.pipelineRuns.insert({
    id: runId,
    projectId,
    status: "completed",
    goal: "secret goal text",
    errorMessage: null,
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 42,
  });
  return runId;
}

function seedContextEntry(storage: TestStorage, projectId: ProjectId, value: string) {
  storage.context.put(
    makeContextEntry({ namespace: "decision", key: "k", value, createdBy: "architect" }),
    projectId,
  );
}

function seedApproval(storage: TestStorage, projectId: ProjectId, runId: RunId) {
  const approvalId = newApprovalId();
  storage.approvals.insert({
    id: approvalId,
    projectId,
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
  return approvalId;
}

// ---------------------------------------------------------------------------
// Authentication boundary (Phase 14A hook applies to /mcp)
// ---------------------------------------------------------------------------
describe("Phase 14E: MCP over Streamable HTTP — authentication boundary", () => {
  it("requires a valid Bearer token (401 for missing/invalid)", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });

    const missing = await postMcp(app, initialize(1));
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error.code).toBe("auth/unauthenticated");

    const invalid = await postMcp(app, initialize(2), { authorization: "Bearer wrong-token" });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.code).toBe("auth/unauthenticated");

    await app.close();
  });

  it("completes the initialize handshake with a valid token", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await postMcp(app, initialize(1), AUTH);
    expect(res.statusCode).toBe(200);
    const body = parseMcpBody(res.body) as {
      result: {
        protocolVersion: string;
        capabilities: Record<string, unknown>;
        serverInfo: { name: string; version: string };
      };
    };
    expect(body.result.protocolVersion).toBeTruthy();
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.capabilities.prompts).toBeUndefined();
    expect(body.result.capabilities.resources).toBeUndefined();
    expect(body.result.serverInfo.name).toBe("devmesh-mcp");
    expect(res.body).not.toContain(TEST_TOKEN);
    await app.close();
  });

  it("is unauthenticated in single-user mode (auth disabled)", async () => {
    const { app } = await buildStack();
    const res = await postMcp(app, initialize(1));
    expect(res.statusCode).toBe(200);
    expect((parseMcpBody(res.body) as { result: unknown }).result).toBeTruthy();
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Tool surface (read-only, seven tools, no mutation)
// ---------------------------------------------------------------------------
describe("Phase 14E: tool surface over HTTP", () => {
  it("lists exactly the seven read-only tools", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await postMcp(app, rpcMessage(2, "tools/list", {}), AUTH);
    expect(res.statusCode).toBe(200);
    const names = (parseMcpBody(res.body) as { result: { tools: Array<{ name: string }> } }).result.tools
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      [
        "get_context",
        "get_pipeline",
        "get_run_usage",
        "list_approvals",
        "list_artifacts",
        "list_pipelines",
        "list_projects",
      ].sort(),
    );
    await app.close();
  });

  it("unknown tools produce an MCP error result", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await postMcp(
      app,
      rpcMessage(3, "tools/call", { name: "resolve_approval", arguments: {} }),
      AUTH,
    );
    expect(res.statusCode).toBe(200);
    const body = parseMcpBody(res.body) as { result: ToolResult };
    expect(body.result.isError).toBe(true);
    expect(textOf(body.result)).toMatch(/not found/i);
    await app.close();
  });

  it("malformed arguments produce an invalid-argument error result", async () => {
    const { app } = await buildStack({ bearerToken: TEST_TOKEN });
    const res = await postMcp(
      app,
      rpcMessage(4, "tools/call", { name: "list_pipelines", arguments: { projectId: "not-a-uuid" } }),
      AUTH,
    );
    expect(res.statusCode).toBe(200);
    const body = parseMcpBody(res.body) as { result: ToolResult };
    expect(body.result.isError).toBe(true);
    expect(textOf(body.result)).toMatch(/invalid/i);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Read-only semantics + isolation through the real Phase 14B authorizers
// ---------------------------------------------------------------------------
describe("Phase 14E: read-only tools, authorization, and isolation", () => {
  it("list_projects returns only owned projects and never leaks internals", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    seedOwned(storage);
    seedForeign(storage);

    const { result, raw } = await toolCall(app, "list_projects", {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(result)) as { projects: Array<{ id: string; name: string }> };
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]!.name).toBe("mine");
    expect(raw).not.toContain("rootPath");
    expect(raw).not.toContain("devmesh-hidden-root");
    expect(raw).not.toContain("foreign-root");
    expect(raw).not.toContain("pluginToken");
    expect(raw).not.toContain("dpk_owned_super_secret");
    expect(raw).not.toContain("dpk_foreign_super_secret");
    await app.close();
  });

  it("list_projects covers all projects in single-user mode", async () => {
    const { app, storage } = await buildStack();
    seedOwned(storage);
    seedForeign(storage);
    const { result } = await toolCall(app, "list_projects", {}, {});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(result)) as { projects: Array<unknown> };
    expect(parsed.projects).toHaveLength(2);
    await app.close();
  });

  it("list_pipelines returns a run for an owned project", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const projectId = seedOwned(storage);
    const runId = seedRun(storage, projectId);

    const { result } = await toolCall(app, "list_pipelines", { projectId });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(result)) as { pipelines: Array<{ id: string }> };
    expect(parsed.pipelines.map((p) => p.id)).toEqual([runId]);
    await app.close();
  });

  it("list_pipelines on a foreign project errors instead of returning an empty success", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const foreign = seedForeign(storage);
    seedRun(storage, foreign);

    const { result, raw } = await toolCall(app, "list_pipelines", { projectId: foreign });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not authorized/i);
    expect(raw).not.toContain("secret goal text");
    await app.close();
  });

  it("run-scoped tools reject runs in foreign projects with an error, not data", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const foreign = seedForeign(storage);
    const runId = seedRun(storage, foreign);

    for (const name of ["get_pipeline", "list_artifacts", "get_run_usage"]) {
      const { result } = await toolCall(app, name, { runId });
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toMatch(/not authorized/i);
      expect(textOf(result), name).not.toContain("secret goal text");
    }
    await app.close();
  });

  it("get_pipeline rejects a client projectId that disagrees with the run's project", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const owned = seedOwned(storage);
    const runId = seedRun(storage, owned);
    const otherOwned = seedOwned(storage, "mine-2");

    const { result } = await toolCall(app, "get_pipeline", { runId, projectId: otherOwned });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/does not match/i);
    await app.close();
  });

  it("get_context returns only the requested project's entries", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const owned = seedOwned(storage);
    const foreign = seedForeign(storage);
    seedContextEntry(storage, owned, "owned-secret");
    seedContextEntry(storage, foreign, "foreign-secret");

    const { result, raw } = await toolCall(app, "get_context", { projectId: owned });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(result)) as { context: Array<{ value: string }> };
    expect(parsed.context.map((e) => e.value)).toEqual(["owned-secret"]);
    expect(raw).not.toContain("foreign-secret");

    const denied = await toolCall(app, "get_context", { projectId: foreign });
    expect(denied.result.isError).toBe(true);
    expect(textOf(denied.result)).toMatch(/not authorized/i);
    await app.close();
  });

  it("list_approvals returns only pending approvals for an owned project", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const owned = seedOwned(storage);
    const runId = seedRun(storage, owned);
    seedApproval(storage, owned, runId);
    const foreign = seedForeign(storage);

    const { result } = await toolCall(app, "list_approvals", { projectId: owned });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(result)) as { approvals: Array<{ status: string }> };
    expect(parsed.approvals).toHaveLength(1);
    expect(parsed.approvals[0]!.status).toBe("pending");

    const denied = await toolCall(app, "list_approvals", { projectId: foreign });
    expect(denied.result.isError).toBe(true);
    await app.close();
  });

  it("get_run_usage returns the usage summary for a run the principal owns", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const owned = seedOwned(storage);
    const runId = seedRun(storage, owned);
    const now = new Date().toISOString();
    storage.executions.insert({
      id: crypto.randomUUID(),
      runId,
      projectId: owned,
      taskId: null,
      agentId: "architect",
      role: "architect",
      runtime: "fake",
      status: "completed",
      failureKind: null,
      instruction: "work",
      sessionRef: null,
      exitCode: 0,
      stoppedReason: null,
      errorMessage: null,
      stdoutTail: null,
      stderrTail: null,
      replyText: null,
      startedAt: now,
      finishedAt: now,
      durationMs: 10,
      resultArtifactId: null,
      verificationArtifactId: null,
      structured: null,
      usage: { inputTokens: 4, outputTokens: 1, costUsdMicros: 50, currency: "USD", usageSource: "reported" },
    });

    const { result } = await toolCall(app, "get_run_usage", { runId });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(result)) as {
      usage: { executionCount: number; totals: { inputTokens: number } };
    };
    expect(parsed.usage.executionCount).toBe(1);
    expect(parsed.usage.totals.inputTokens).toBe(4);
    await app.close();
  });

  it("artifacts are stripped to metadata + bounded preview (no raw evidence)", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    const owned = seedOwned(storage);
    const runId = seedRun(storage, owned);
    const secretPath = "packages/mcp/src/key.pem";
    const artifact = artifactSchema.parse({
      kind: "change_set",
      ...newArtifactBase({ runId, projectId: owned, producedBy: "architect" }),
      payload: {
        branch: "feat/x",
        commits: [{ sha: "a".repeat(40), message: "m" }],
        filesChanged: [{ path: secretPath, sha256: "b".repeat(64), sizeBytes: 7 }],
        commandsRun: [],
      },
    });
    storage.artifacts.insert(artifact);

    const { result, raw } = await toolCall(app, "list_artifacts", { runId });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    const parsedResult = JSON.parse(text) as {
      artifacts: Array<{ id: string; kind: string; preview: string }>;
    };
    expect(parsedResult.artifacts).toHaveLength(1);
    expect(parsedResult.artifacts[0]!.preview).toContain("filesChanged: 1");
    expect(raw).not.toContain(secretPath);
    expect(raw).not.toContain("b".repeat(64));
    expect(raw).not.toContain("commandsRun");
    await app.close();
  });

  it("concurrent requests each get a valid independent response (stateless)", async () => {
    const { app, storage } = await buildStack({ bearerToken: TEST_TOKEN });
    seedOwned(storage);

    const calls = [1, 2, 3, 4].map((n) =>
      postMcp(app, rpcMessage(n, "tools/call", { name: "list_projects", arguments: {} }), AUTH),
    );
    const responses = await Promise.all(calls);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      const body = parseMcpBody(res.body) as { result: ToolResult; id: number };
      expect(body.result.isError).toBeUndefined();
      expect(JSON.parse(textOf(body.result)).projects).toHaveLength(1);
    }
    await app.close();
  });
});