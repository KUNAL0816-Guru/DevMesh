import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthPrincipal, ProjectId, RunId } from "@devmesh/contracts";
import {
  artifactSchema,
  makeContextEntry,
  newApprovalId,
  newArtifactBase,
  newProjectId,
  newRunId,
  projectIdSchema,
} from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
import { createDevMeshMcpServer } from "./server.js";
import type { McpAuthorization } from "./context.js";

function forbidden(message: string): Error {
  return Object.assign(new Error(message), { code: "auth/forbidden" });
}

const principalP1: AuthPrincipal = { id: "p1", method: "bearer" };

let storage: Storage;
let principal: AuthPrincipal | undefined;
let authorize: McpAuthorization;

beforeEach(() => {
  storage = createStorage({ path: ":memory:" });
  principal = undefined;
  authorize = {
    authorizeProject: (_p, projectId) => {
      if (principal) {
        const rec = storage.projects.get(projectId);
        if (rec && rec.ownerPrincipalId !== principal.id) {
          throw forbidden(`principal "${principal.id}" is not authorized to access project "${projectId}"`);
        }
      }
    },
    authorizeRun: (_p, runId) => {
      if (principal) {
        const run = storage.pipelineRuns.get(runId);
        if (run) {
          const rec = storage.projects.get(projectIdSchema.parse(run.projectId));
          if (rec && rec.ownerPrincipalId !== principal.id) {
            throw forbidden(`principal "${principal.id}" is not authorized to access project "${rec.id}"`);
          }
        }
      }
      const run = storage.pipelineRuns.get(runId);
      return run ? { run, projectId: projectIdSchema.parse(run.projectId) } : null;
    },
  };
});

afterEach(() => {
  storage.close();
});

function seedProject(owner?: string): ProjectId {
  const id = newProjectId();
  storage.projects.insert({
    id,
    name: `project-${id.slice(0, 4)}`,
    rootPath: `/tmp/workspaces/${id}`,
    createdAt: new Date().toISOString(),
    ownerPrincipalId: owner ?? null,
    pluginToken: `dpk_secret_${id}`,
  });
  return id;
}

function seedRun(projectId: ProjectId): RunId {
  const id = newRunId();
  storage.pipelineRuns.insert({
    id,
    projectId,
    status: "completed",
    goal: "seed goal",
    errorMessage: null,
    createdAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 42,
  });
  return id;
}

/** Connect a fresh SDK client to the given server and run the callback. */
async function withClient(
  server: SdkMcpServer,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ name: "mcp-unit-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await fn(client);
  } finally {
    await client.close();
    await server.close();
    await clientTransport.close();
    await serverTransport.close();
  }
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
  const res = (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult;
  return res;
}

function textOf(res: ToolCallResult): string {
  return res.content.map((c) => c.text).join("");
}

describe("createDevMeshMcpServer", () => {
  it("advertises exactly the seven read-only tools and no prompts/resources", async () => {
    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const caps = client.getServerCapabilities();
      expect(caps?.tools).toBeDefined();
      expect(caps?.prompts).toBeUndefined();
      expect(caps?.resources).toBeUndefined();

      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(
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
      for (const t of tools.tools) {
        expect(t.description).toBeTruthy();
      }
    });
  });

  it("unknown tools produce an MCP error result", async () => {
    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const res = await client.callTool({ name: "does_not_exist", arguments: {} });
      expect(res.isError).toBe(true);
      expect((res as unknown as ToolCallResult).content[0]!.text).toMatch(/not found/i);
    });
  });

  it("list_projects is owner-scoped and never leaks internals", async () => {
    const mine = seedProject("p1");
    const theirs = seedProject("p2");
    principal = principalP1;

    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const res = await callTool(client, "list_projects", {});
      expect(res.isError).toBeUndefined();
      const parsed = JSON.parse(textOf(res)) as {
        projects: Array<Record<string, unknown>>;
      };
      expect(parsed.projects.map((p) => p.id)).toEqual([mine]);
      expect(parsed.projects.map((p) => p.id)).not.toContain(theirs);
      expect(Object.keys(parsed.projects[0]!).sort()).toEqual(["createdAt", "id", "name"]);
      for (const p of parsed.projects) {
        expect(JSON.stringify(p)).not.toContain("rootPath");
        expect(JSON.stringify(p)).not.toContain("pluginToken");
        expect(JSON.stringify(p)).not.toContain("ownerPrincipalId");
      }
    });
  });

  it("list_projects covers every project in single-user mode", async () => {
    const first = seedProject();
    const second = seedProject();
    principal = undefined;

    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const res = await callTool(client, "list_projects", {});
      const parsed = JSON.parse(textOf(res)) as { projects: Array<{ id: string }> };
      expect(parsed.projects.map((p) => p.id).sort()).toEqual([first, second].sort());
    });
  });

  it("list_pipelines returns a project's runs and errors (not empty success) on denied access", async () => {
    const owned = seedProject("p1");
    const run = seedRun(owned);
    const foreign = seedProject("p2");
    seedRun(foreign);
    principal = principalP1;

    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const ok = await callTool(client, "list_pipelines", { projectId: owned });
      expect(ok.isError).toBeUndefined();
      const parsed = JSON.parse(textOf(ok)) as { pipelines: Array<{ id: string; projectId: string }> };
      expect(parsed.pipelines.map((p) => p.id)).toEqual([run]);
      expect(parsed.pipelines[0]!.projectId).toBe(owned);

      const denied = await callTool(client, "list_pipelines", { projectId: foreign });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toMatch(/not authorized/i);
      expect(textOf(denied)).not.toContain("seed goal");
    });
  });

  it("list_pipelines for a missing project is a not-found error", async () => {
    principal = principalP1;
    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const res = await callTool(client, "list_pipelines", { projectId: newProjectId() });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/no such project/i);
    });
  });

  it("get_pipeline is run-authoritative and rejects a mismatched projectId", async () => {
    const owned = seedProject("p1");
    const run = seedRun(owned);
    principal = principalP1;

    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const ok = await callTool(client, "get_pipeline", { runId: run });
      const parsed = JSON.parse(textOf(ok)) as { pipeline: { id: string; status: string } };
      expect(parsed.pipeline.id).toBe(run);
      expect(parsed.pipeline.status).toBe("completed");

      const mismatched = await callTool(client, "get_pipeline", {
        runId: run,
        projectId: seedProject("p1"),
      });
      expect(mismatched.isError).toBe(true);
      expect(textOf(mismatched)).toMatch(/does not match/i);

      const missing = await callTool(client, "get_pipeline", { runId: newRunId() });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toMatch(/no such pipeline run/i);
    });
  });

  it("list_artifacts returns bounded previews and strips path/command evidence", async () => {
    const owned = seedProject("p1");
    const run = seedRun(owned);
    const secretPath = "packages/mcp/src/secret.key";
    const artifact = artifactSchema.parse({
      kind: "change_set",
      ...newArtifactBase({ runId: run, projectId: owned, producedBy: "architect" }),
      payload: {
        branch: "feat/secrets",
        commits: [{ sha: "a".repeat(40), message: "add key" }],
        filesChanged: [{ path: secretPath, sha256: "b".repeat(64), sizeBytes: 123 }],
        commandsRun: [{ command: "openssl genrsa -out secret.key", exitCode: 0, durationMs: 5 }],
      },
    });
    storage.artifacts.insert(artifact);
    principal = principalP1;

    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const res = await callTool(client, "list_artifacts", { runId: run });
      expect(res.isError).toBeUndefined();
      const raw = textOf(res);
      const parsed = JSON.parse(raw) as {
        artifacts: Array<{ id: string; kind: string; preview: string }>;
      };
      expect(parsed.artifacts).toHaveLength(1);
      expect(parsed.artifacts[0]!.kind).toBe("change_set");
      expect(parsed.artifacts[0]!.id).toBe(artifact.id);
      expect(parsed.artifacts[0]!.preview).toContain("filesChanged: 1");
      expect(parsed.artifacts[0]!.preview).toContain("feat/secrets");
      expect(raw).not.toContain(secretPath);
      expect(raw).not.toContain("openssl");
      expect(raw).not.toContain("b".repeat(64));
      expect(raw).not.toContain("command");
      expect(raw).not.toContain("cwd");
    });
  });

  it("get_context returns only the requested project's entries and honors namespace filters", async () => {
    const owned = seedProject("p1");
    const foreign = seedProject("p2");
    storage.context.put(
      makeContextEntry({ namespace: "decision", key: "k1", value: "owned-secret", createdBy: "architect" }),
      owned,
    );
    storage.context.put(
      makeContextEntry({ namespace: "decision", key: "k2", value: "other-project-secret", createdBy: "architect" }),
      foreign,
    );
    storage.context.put(
      makeContextEntry({ namespace: "spec", key: "k3", value: "owned-spec", createdBy: "architect" }),
      owned,
    );
    principal = principalP1;

    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const all = await callTool(client, "get_context", { projectId: owned });
      expect(all.isError).toBeUndefined();
      const raw = textOf(all);
      expect(raw).toContain("owned-secret");
      expect(raw).toContain("owned-spec");
      expect(raw).not.toContain("other-project-secret");

      const filtered = await callTool(client, "get_context", { projectId: owned, namespace: "spec" });
      const parsed = JSON.parse(textOf(filtered)) as { context: Array<{ namespace: string; value: string }> };
      expect(parsed.context.map((e) => e.namespace)).toEqual(["spec"]);
      expect(parsed.context[0]!.value).toBe("owned-spec");

      const denied = await callTool(client, "get_context", { projectId: foreign });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toMatch(/not authorized/i);
    });
  });

  it("list_approvals returns only pending requests for the requested project", async () => {
    const owned = seedProject("p1");
    const foreign = seedProject("p2");
    const run = seedRun(owned);

    const pendingId = newApprovalId();
    storage.approvals.insert({
      id: pendingId,
      projectId: owned,
      runId: run,
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
    const resolvedId = newApprovalId();
    storage.approvals.insert({
      id: resolvedId,
      projectId: owned,
      runId: run,
      taskId: null,
      kind: "destructive_git",
      title: "Already decided",
      detail: "",
      risk: "low",
      status: "approved",
      requestedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      decision: "allow",
      decidedBy: "p1",
    });
    principal = principalP1;

    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const res = await callTool(client, "list_approvals", { projectId: owned });
      expect(res.isError).toBeUndefined();
      const parsed = JSON.parse(textOf(res)) as { approvals: Array<{ id: string; status: string }> };
      expect(parsed.approvals.map((a) => a.id)).toEqual([pendingId]);
      expect(parsed.approvals.every((a) => a.status === "pending")).toBe(true);

      const denied = await callTool(client, "list_approvals", { projectId: foreign });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toMatch(/not authorized/i);
    });
  });

  it("get_run_usage aggregates usage and errors for missing runs", async () => {
    const owned = seedProject("p1");
    const run = seedRun(owned);
    const now = new Date().toISOString();
    storage.executions.insert({
      id: crypto.randomUUID(),
      runId: run,
      projectId: owned,
      taskId: null,
      agentId: "architect",
      role: "architect",
      runtime: "fake",
      status: "completed",
      failureKind: null,
      instruction: "do the thing",
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
      usage: { inputTokens: 3, outputTokens: 2, costUsdMicros: 100, currency: "USD", usageSource: "reported" },
    });
    principal = principalP1;

    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const res = await callTool(client, "get_run_usage", { runId: run });
      expect(res.isError).toBeUndefined();
      const parsed = JSON.parse(textOf(res)) as {
        usage: {
          runId: string;
          executionCount: number;
          totals: { inputTokens: number; outputTokens: number; costUsdMicros: number };
        };
      };
      expect(parsed.usage.runId).toBe(run);
      expect(parsed.usage.executionCount).toBe(1);
      expect(parsed.usage.totals.inputTokens).toBe(3);
      expect(parsed.usage.totals.outputTokens).toBe(2);
      expect(parsed.usage.totals.costUsdMicros).toBe(100);

      const missing = await callTool(client, "get_run_usage", { runId: newRunId() });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toMatch(/no such pipeline run/i);
    });
  });

  it("run-scoped tools reject a run in a foreign project with an error result", async () => {
    const foreign = seedProject("p2");
    const run = seedRun(foreign);
    principal = principalP1;

    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      for (const name of ["get_pipeline", "list_artifacts", "get_run_usage"]) {
        const res = await callTool(client, name, { runId: run });
        expect(res.isError, name).toBe(true);
        expect(textOf(res), name).toMatch(/not authorized/i);
        expect(textOf(res), name).not.toContain("seed goal");
      }
    });
  });

  it("malformed arguments are rejected with an invalid-argument error result", async () => {
    principal = principalP1;
    const server = createDevMeshMcpServer({ storage, getPrincipal: () => principal, authorization: authorize });
    await withClient(server, async (client) => {
      const res = await callTool(client, "list_pipelines", { projectId: "not-a-uuid" });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/invalid/i);
    });
  });
});