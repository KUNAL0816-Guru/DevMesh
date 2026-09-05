import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  baselineProfile,
  isArtifactKind,
  makeTaskCard,
  newRunId,
  projectIdSchema,
  taskCardSchema,
  type ProjectId,
  type TaskCard,
} from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
import { GitService, WorkspaceService } from "@devmesh/workspace";
import { FakeRuntime } from "@devmesh/runtime";
import { createDefaultAgentRegistry, type AgentDefinitionInput } from "@devmesh/agents";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import { reconcileInterrupted } from "./executions/service.js";
import type { ProfileProvider } from "./policy.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-exec-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

type RuntimeFactory = (
  handle: { projectId: ProjectId; root: string },
) => FakeRuntime | null;

function makeStack(
  runtimeFn?: RuntimeFactory,
  overrides: Partial<Config> = {},
  policyBaselines?: ProfileProvider,
) {
  const storage = createStorage({ path: join(dataRoot, `t-${crypto.randomUUID()}.db`) });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(dataRoot, "workspaces"),
  });
  const handle = workspaces.create("exec-test");
  const runtime = runtimeFn ? runtimeFn(handle) : null;
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataRoot,
      logLevel: "error",
      runtime: runtime ? "opencode" : "none",
      opencodeBin: "opencode",
      opencodeAutoApprove: false,
      execTimeoutMs: 10_000,
      ...overrides,
    } as Config,
    storage,
    workspaces,
    runtime,
    ...(policyBaselines ? { policyBaselines } : {}),
  });
  return { app, storage, workspaces, handle };
}

const hangScript = (): ConstructorParameters<typeof FakeRuntime>[0] => ({
  steps: [{ effect: () => undefined }],
  outcome: { status: "completed" },
  stepDelayMs: 30_000,
});

const doneScript = (root: string): ConstructorParameters<typeof FakeRuntime>[0] => ({
  steps: [
    {
      effect: () => writeFileSync(join(root, "notes.txt"), "agent output\n"),
      events: [{ kind: "tool", tool: "write", status: "completed" }],
    },
  ],
  outcome: { status: "completed", sessionId: "ses_x1", finalText: "did it", exitCode: 0 },
  stepDelayMs: 5,
});

async function waitForTerminal(
  storage: Storage,
  id: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = storage.executions.get(id);
    if (rec && rec.status !== "running") return rec.status;
    if (Date.now() > deadline) throw new Error(`execution ${id} never finished`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("ExecutionService with FakeRuntime", () => {
  it("completes: verifies workspace change, records artifacts, advances task card", async () => {
    const stack = makeStack((h) => new FakeRuntime(doneScript(h.root)));

    // wire a task card so the state-machine integration is exercised
    const card: TaskCard = makeTaskCard({
      projectId: stack.handle.projectId,
      runId: newRunId(),
      role: "developer",
      status: "ready",
      title: "write a file",
      detail: "create one file",
      acceptanceCriteria: ["file exists"],
      dependsOn: [],
    });
    stack.storage.tasks.insert(card);

    const rec = await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "make a file", taskId: card.id },
    }).then((r) => r.json().execution);

    expect(rec.status).toBe("running");
    const terminal = await waitForTerminal(stack.storage, rec.id);
    expect(terminal).toBe("completed");

    const row = stack.storage.executions.get(rec.id)!;
    expect(row.sessionRef).toBe("ses_x1");
    expect(row.stoppedReason).toBe("end_turn");
    expect(row.resultArtifactId).toBeTruthy();
    expect(row.verificationArtifactId).toBeTruthy();

    // DevMesh-observed ground truth + independent hash verification
    const changeSet = stack.storage.artifacts.get(row.resultArtifactId! as never)!;
    expect(isArtifactKind(changeSet, "change_set")).toBe(true);
    if (isArtifactKind(changeSet, "change_set")) {
      expect(changeSet.payload.filesChanged).toHaveLength(1);
      expect(changeSet.payload.filesChanged[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const verification = stack.storage.artifacts.get(row.verificationArtifactId! as never)!;
    expect(isArtifactKind(verification, "verification")).toBe(true);
    if (isArtifactKind(verification, "verification")) {
      expect(verification.payload.verdict).toBe("verified");
    }

    // task card walked pending -> running -> in_review, attempts incremented once
    const updated = stack.storage.tasks.get(card.id)!;
    expect(updated.status).toBe("in_review");
    expect(updated.attempts).toBe(1);

    const events = [...stack.storage.events.listAfter(0)];
    const types = events.map((e) => e.type);
    expect(types).toContain("task.transitioned");
    expect(types).toContain("agent.session.opened");
    expect(types.filter((t) => t === "artifact.recorded")).toHaveLength(2);
    expect(types).toContain("agent.reply.completed");
    expect(types).not.toContain("verification.failed");

    await stack.app.close();
  });

  it("persists runtime-reported token usage on completion", async () => {
    const stack = makeStack(
      (h) =>
        new FakeRuntime({
          steps: [
            {
              effect: () => writeFileSync(join(h.root, "notes.txt"), "agent output\n"),
              events: [{ kind: "tool", tool: "write", status: "completed" }],
            },
          ],
          outcome: {
            status: "completed",
            sessionId: "ses_usage",
            finalText: "did it",
            exitCode: 0,
            usage: { inputTokens: 812, outputTokens: 199 },
          },
          stepDelayMs: 5,
        }),
    );
    const rec = await stack.app
      .inject({
        method: "POST",
        url: `/projects/${stack.handle.projectId}/executions`,
        payload: { instruction: "measure me" },
      })
      .then((r) => r.json().execution);
    expect(await waitForTerminal(stack.storage, rec.id)).toBe("completed");

    const row = stack.storage.executions.get(rec.id)!;
    // 8A persists tokens; cost fields stay NULL until config pricing lands (8C).
    expect(row.usage).toEqual({
      inputTokens: 812,
      outputTokens: 199,
      costUsdMicros: null,
      currency: null,
      usageSource: null,
    });
    await stack.app.close();
  });

  it("keeps usage null when the runtime reports none", async () => {
    const stack = makeStack((h) => new FakeRuntime(doneScript(h.root)));
    const rec = await stack.app
      .inject({
        method: "POST",
        url: `/projects/${stack.handle.projectId}/executions`,
        payload: { instruction: "quiet run" },
      })
      .then((r) => r.json().execution);
    expect(await waitForTerminal(stack.storage, rec.id)).toBe("completed");
    const row = stack.storage.executions.get(rec.id)!;
    expect(row.usage).toBeNull();
    await stack.app.close();
  });

  it("failed run: no artifacts, task -> failed", async () => {
    const stack = makeStack(
      () =>
        new FakeRuntime({
          steps: [{ events: [{ kind: "error", message: "provider exploded" }] }],
          outcome: { status: "failed", exitCode: 1, failureReason: "provider exploded" },
          stepDelayMs: 5,
        }),
    );
    const rec = await stack.app
      .inject({
        method: "POST",
        url: `/projects/${stack.handle.projectId}/executions`,
        payload: { instruction: "break things" },
      })
      .then((r) => r.json().execution);
    expect(await waitForTerminal(stack.storage, rec.id)).toBe("failed");

    const row = stack.storage.executions.get(rec.id)!;
    expect(row.errorMessage).toBe("provider exploded");
    expect(row.resultArtifactId).toBeNull();
    expect(row.verificationArtifactId).toBeNull();
    await stack.app.close();
  });

  it("timeout run maps to status timeout and budget_exceeded", async () => {
    const stack = makeStack(() => new FakeRuntime(hangScript()));
    const rec = await stack.app
      .inject({
        method: "POST",
        url: `/projects/${stack.handle.projectId}/executions`,
        payload: { instruction: "hang forever" },
      })
      .then((r) => r.json().execution);
    // FakeRuntime enforces request.timeoutMs (service default 10s here); poll longer
    expect(await waitForTerminal(stack.storage, rec.id, 15_000)).toBe("timeout");
    const row = stack.storage.executions.get(rec.id)!;
    expect(row.stoppedReason).toBe("budget_exceeded");
    await stack.app.close();
  });

  it("cancellation via API stops the run and persists cancelled", async () => {
    const stack = makeStack(() => new FakeRuntime(hangScript()));
    const res = await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "long task" },
    });
    const rec = res.json().execution;
    expect(res.statusCode).toBe(202);

    const cancelRes = await stack.app.inject({
      method: "POST",
      url: `/executions/${rec.id}/cancel`,
      payload: {},
    });
    expect(cancelRes.statusCode).toBe(202);
    expect(await waitForTerminal(stack.storage, rec.id)).toBe("cancelled");

    // cancelling an already-finished execution conflicts
    const second = await stack.app.inject({
      method: "POST",
      url: `/executions/${rec.id}/cancel`,
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    await stack.app.close();
  });

  it("rejects a second concurrent execution on the same project (409)", async () => {
    const stack = makeStack(() => new FakeRuntime(hangScript()));
    const first = await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "one" },
    });
    expect(first.statusCode).toBe(202);
    const second = await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "two" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("workspace/locked");
    await stack.app.close();
  });

  it("503 when no runtime is wired; GET endpoints still answer", async () => {
    const stack = makeStack();
    const start = await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "x" },
    });
    expect(start.statusCode).toBe(503);
    expect(start.json().error.code).toBe("runtime/not-configured");

    const list = await stack.app.inject({
      method: "GET",
      url: `/projects/${stack.handle.projectId}/executions`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().executions).toEqual([]);
    await stack.app.close();
  });

  it("interrupted reconciliation marks stale rows and raises events", async () => {
    const stack = makeStack();
    const rec = stack.storage.executions.insert({
      runId: "11111111-1111-4111-8111-111111111111" as never,
      projectId: stack.handle.projectId,
      taskId: null,
      agentId: "developer",
      role: "developer",
      runtime: "opencode",
      status: "running",
      failureKind: null,
      instruction: "orphaned by restart",
      sessionRef: null,
      exitCode: null,
      stoppedReason: null,
      errorMessage: null,
      stdoutTail: null,
      stderrTail: null,
      replyText: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      resultArtifactId: null,
      verificationArtifactId: null,
      structured: null,
      usage: null,
    });
    expect(reconcileInterrupted(stack.storage)).toBe(1);
    expect(stack.storage.executions.get(rec.id)?.status).toBe("interrupted");
    const events = [...stack.storage.events.listAfter(0)];
    const raised = events.find((e) => e.type === "error.raised") as
      | { scope?: string }
      | undefined;
    expect(raised?.scope).toBe("execution/interrupted");
    await stack.app.close();
  });
});

/**
 * CONTROLLED INTEGRATION TEST (Phase 2 requirement 15):
 * DevMesh task -> real OpencodeAdapter process mechanics (stub binary
 * speaking the verified `opencode run --format json` NDJSON contract) ->
 * workspace change in the managed git workspace -> SHA-256 verification.
 * No external LLM involved.
 */
describe("integration: execution through the real adapter mechanism", () => {
  it("runs the stub binary, captures the change, verifies hashes end-to-end", async () => {
    // stub binary: executable with shebang so the adapter can spawn it
    // directly (argv[0]), mirroring how it would spawn the real `opencode`.
    const binDir = mkdtempSync(join(tmpdir(), "devmesh-stubbin-"));
    const stubPath = join(binDir, "stub-opencode.mjs");
    writeFileSync(
      stubPath,
      `#!/usr/bin/env node
const instruction = JSON.parse(process.argv[process.argv.indexOf("--") + 1]);
const line = (o) => process.stdout.write(JSON.stringify({ timestamp: Date.now(), sessionID: "ses_it9", ...o }) + "\\n");
line({ type: "step_start" });
line({ type: "text", part: { type: "text", text: "writing file" }, time: { end: Date.now() } });
const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(instruction.dir, { recursive: true });
writeFileSync(instruction.file, instruction.content);
line({ type: "tool_use", part: { tool: "write", state: { status: "completed" } } });
line({ type: "step_finish" });
process.exit(0);
`,
    );
    chmodSync(stubPath, 0o755);

    const { OpencodeAdapter } = await import("@devmesh/opencode-adapter");
    const adapter = new OpencodeAdapter({ binaryPath: stubPath });
    const storage = createStorage({ path: join(dataRoot, "it.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(dataRoot, "workspaces"),
    });
    const handle = workspaces.create("integration");
    const git = new GitService();
    git.init(handle.root);

    const targetRel = "src/hello.txt";
    const targetAbs = join(handle.root, targetRel);
    const content = "verified by devmesh\n";
    const app = buildApp({
      config: {
        host: "127.0.0.1",
        port: 0,
        dataRoot,
        logLevel: "error",
        runtime: "opencode",
        opencodeBin: process.execPath,
        opencodeAutoApprove: false,
        execTimeoutMs: 15_000,
      } as Config,
      storage,
      workspaces,
      // bypass bootstrap wiring: hand the adapter to the neutral port directly.
      // The stub's action plan travels inside the instruction string; the
      // workspaceRoot passed by the service is still what pins its cwd.
      runtime: {
        name: "opencode",
        health: adapter.health.bind(adapter),
        start: (req: Parameters<typeof adapter.start>[0]) =>
          adapter.start({
            ...req,
            instruction: JSON.stringify({
              dir: join(handle.root, "src"),
              file: targetAbs,
              content,
            }),
          }),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/projects/${handle.projectId}/executions`,
      payload: { instruction: "create hello.txt" },
    });
    expect(res.statusCode).toBe(202);
    const rec = res.json().execution;
    expect(await waitForTerminal(storage, rec.id)).toBe("completed");

    // the agent's file really exists in the managed workspace...
    expect(existsSync(targetAbs)).toBe(true);
    expect(readFileSync(targetAbs, "utf8")).toBe(content);

    // ...and DevMesh recorded + verified exactly that file
    const row = storage.executions.get(rec.id)!;
    const verification = storage.artifacts.get(row.verificationArtifactId! as never)!;
    expect(isArtifactKind(verification, "verification")).toBe(true);
    if (isArtifactKind(verification, "verification")) {
      expect(verification.payload.verdict).toBe("verified");
      const hashCheck = verification.payload.checks[0] as {
        kind: string;
        path: string;
        passed: boolean;
      };
      expect(hashCheck.kind).toBe("file_hash");
      expect(hashCheck.path).toBe(targetRel);
      expect(hashCheck.passed).toBe(true);
    }

    // session ref captured from the NDJSON stream
    expect(row.sessionRef).toBe("ses_it9");
    await app.close();
    rmSync(binDir, { recursive: true, force: true });
  });
});


// ---------------------------------------------------------------------------
// Phase 3: agent registry integration, gates, classification, verification
// ---------------------------------------------------------------------------

import { classifyResult, classifyStartError, failureKinds } from "./executions/classify.js";
import { runVerificationCommand, splitSafeCommand } from "./executions/commands.js";
import { buildVerificationArtifacts, sha256File } from "./executions/verify.js";

function defWith(overrides: Partial<AgentDefinitionInput> = {}): AgentDefinitionInput {
  return {
    id: "dev-test",
    role: "developer",
    displayName: "Dev Test",
    systemInstructions: "test instructions ".repeat(4),
    permissions: { autoApprove: false },
    allowedOperations: ["read_files", "write_files"],
    runtime: "opencode",
    timeoutMs: 30_000,
    maxAttempts: 2,
    executable: true,
    ...overrides,
  };
}
void defWith;

describe("Phase 3: agent gating via the registry", () => {
  it("starts through the developer agent by default (agentId recorded)", async () => {
    const stack = makeStack((h) => new FakeRuntime(doneScript(h.root)));
    const res = await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "hello" },
    });
    expect(res.statusCode).toBe(202);
    const rec = res.json().execution;
    expect(rec.agentId).toBe("developer");
    expect(rec.role).toBe("developer");
    await waitForTerminal(stack.storage, rec.id);
    await stack.app.close();
  });

  it("rejects unknown agents with 400", async () => {
    const stack = makeStack(() => new FakeRuntime(hangScript()));
    const unknown = await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "x", agentId: "nope" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe("runtime/invalid-request");
    await stack.app.close();
  });

  it("enforces attempt limits (task/exhausted after maxAttempts)", async () => {
    const stack = makeStack((h) => new FakeRuntime(doneScript(h.root)));
    const card: TaskCard = makeTaskCard({
      projectId: stack.handle.projectId,
      runId: newRunId(),
      role: "developer",
      status: "ready",
      title: "limited",
      detail: "d",
      acceptanceCriteria: ["c"],
      dependsOn: [],
    });
    stack.storage.tasks.insert(card);
    stack.storage.tasks.update(
      taskCardSchema.parse({ ...card, attempts: 3, updatedAt: new Date().toISOString() }),
    );

    const res = await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "retry again", taskId: card.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("task/exhausted");
    // never reached the runtime: no execution row was even inserted
    expect(stack.storage.executions.listByProject(stack.handle.projectId)).toHaveLength(0);
    await stack.app.close();
  });

  it("denies a start at the HTTP layer with 422 permission/denied", async () => {
    const stack = makeStack(
      (h) => new FakeRuntime(doneScript(h.root)),
      {},
      (role) =>
        role === "developer" ? { read: "deny", edit: "allow" } : baselineProfile(role),
    );

    const res = await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "hello" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("permission/denied");
    // policy verdict arrived before any row was persisted or runtime was reached
    expect(stack.storage.executions.listByProject(stack.handle.projectId)).toHaveLength(0);
    await stack.app.close();
  });

  it("caps effective timeout at min(agent.timeoutMs, config budget)", async () => {
    let capturedTimeout = 999_999;
    class ProbeRuntime extends FakeRuntime {
      override start(req: Parameters<FakeRuntime["start"]>[0]) {
        capturedTimeout = req.timeoutMs;
        return super.start(req);
      }
    }
    const stack = makeStack((h) => new ProbeRuntime(doneScript(h.root)), {
      execTimeoutMs: 60_000,
    });
    const res = await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "hi" },
    });
    expect(res.statusCode).toBe(202);
    // developer definition budget is 300s; the 60s config budget must win
    expect(capturedTimeout).toBe(60_000);
    await waitForTerminal(stack.storage, res.json().execution.id);
    await stack.app.close();
  });

  it("composes system instructions from the registry definition", async () => {
    let capturedInstruction = "";
    class SpyRuntime extends FakeRuntime {
      override start(req: Parameters<FakeRuntime["start"]>[0]) {
        capturedInstruction = req.instruction;
        return super.start(req);
      }
    }
    const stack = makeStack((h) => new SpyRuntime(doneScript(h.root)));
    await stack.app.inject({
      method: "POST",
      url: `/projects/${stack.handle.projectId}/executions`,
      payload: { instruction: "MY TASK TEXT" },
    });
    expect(capturedInstruction).toContain("# Task");
    expect(capturedInstruction).toContain("MY TASK TEXT");
    expect(capturedInstruction.length).toBeGreaterThan(200); // system preamble present
    const started = stack.storage.executions.listByProject(stack.handle.projectId)[0]!;
    await waitForTerminal(stack.storage, started.id);
    await stack.app.close();
  });
});

describe("Phase 3: failure classification", () => {
  it("covers the full taxonomy", () => {
    expect([...failureKinds]).toEqual([
      "provider_failure",
      "process_failure",
      "timeout",
      "cancelled",
      "invalid_output",
      "verification_failed",
      "task_failed",
      "doom_loop",
      "internal",
    ]);
  });

  it("maps runtime outcomes to kinds", () => {
    expect(classifyResult({ status: "timeout" })).toBe("timeout");
    expect(classifyResult({ status: "cancelled" })).toBe("cancelled");
    expect(classifyResult({ status: "completed" })).toBeNull();
    expect(
      classifyResult({ status: "failed", failureReason: "connect ECONNREFUSED api.x" }),
    ).toBe("provider_failure");
    expect(classifyResult({ status: "failed", failureReason: "rate limit exceeded" })).toBe(
      "provider_failure",
    );
    expect(classifyResult({ status: "failed", failureReason: "exit code 1" })).toBe(
      "process_failure",
    );
  });

  it("maps start errors to kinds", () => {
    expect(classifyStartError({ code: "runtime/unavailable" })).toBe("process_failure");
    expect(classifyStartError({ code: "runtime/not-configured" })).toBe("task_failed");
    expect(classifyStartError({ code: "workspace/locked" })).toBe("task_failed");
    expect(classifyStartError({ code: "task/exhausted" })).toBe("task_failed");
    expect(classifyStartError({ code: "orchestrator/doom-loop" })).toBe("doom_loop");
    expect(classifyStartError(new Error("boom"))).toBe("internal");
  });

  it("persists process_failure when the runtime port rejects startup", async () => {
    const storage = createStorage({ path: join(dataRoot, "cls.db") });
    const workspaces = new WorkspaceService({
      store: storage.projects,
      workspacesRoot: join(dataRoot, "ws"),
    });
    const handle = workspaces.create("cls");
    const { ExecutionService } = await import("./executions/service.js");
    const svc = new ExecutionService({
      storage,
      workspaces,
      git: new GitService(),
      runtime: {
        name: "opencode",
        start: () => {
          throw Object.assign(new Error("spawn opencode ENOENT"), {
            code: "runtime/unavailable",
          });
        },
      },
      agents: createDefaultAgentRegistry(),
    });
    await expect(
      svc.start({ projectId: handle.projectId, instruction: "x" }),
    ).rejects.toMatchObject({ code: "runtime/unavailable" });

    // finalizeRuntimeFailure runs synchronously inside start()'s catch
    const row = storage.executions.listByProject(handle.projectId)[0]!;
    expect(row.status).toBe("failed");
    expect(row.failureKind).toBe("process_failure");
  });
});

describe("Phase 3: independent verification command replay", () => {
  it("validates command safety", () => {
    expect(splitSafeCommand("npm test")).toEqual(["npm", "test"]);
    expect(splitSafeCommand("node script.js --all")).toEqual(["node", "script.js", "--all"]);
    expect(splitSafeCommand("rm -rf $HOME")).toBeNull();
    expect(splitSafeCommand("a; b")).toBeNull();
    expect(splitSafeCommand("a && b")).toBeNull();
    expect(splitSafeCommand("`cmd`")).toBeNull();
  });

  it("replays a passing command and records a command_replay check", async () => {
    const root = mkdtempSync(join(tmpdir(), "replay-ok-"));
    try {
      writeFileSync(join(root, "check.js"), "process.exit(0);\n");
      const outcome = await runVerificationCommand(root, "node check.js");
      expect(outcome.passed).toBe(true);
      expect(outcome.exitCode).toBe(0);

      // wire it into the artifact builder
      writeFileSync(join(root, "out.txt"), "changed\n");
      const realSha = sha256File(join(root, "out.txt"));
      const built = buildVerificationArtifacts({
        root,
        observed: {
          branch: "master",
          filesChanged: [{ path: "out.txt", sha256: realSha, sizeBytes: 8 }],
          unreadable: [],
        },
        ctx: { runId: newRunId(), projectId: handle_id() },
        producedBy: "developer",
        extraChecks: [
          {
            kind: "command_replay",
            command: outcome.command,
            exitCode: outcome.exitCode,
            passed: outcome.passed,
            detail: outcome.detail,
          },
        ],
      });
      if (built.verification && isArtifactKind(built.verification, "verification")) {
        expect(built.verification.payload.verdict).toBe("verified");
        expect(built.verification.payload.checks.some((c) => c.kind === "command_replay")).toBe(true);
      } else {
        expect.unreachable();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("failing replay -> verdict rejected -> execution failed w/ verification_failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "replay-bad-"));
    try {
      writeFileSync(join(root, "check.js"), "console.error('tests broke'); process.exit(3);\n");
      const outcome = await runVerificationCommand(root, "node check.js");
      expect(outcome.passed).toBe(false);
      expect(outcome.exitCode).toBe(3);
      expect(outcome.detail).toContain("tests broke");

      writeFileSync(join(root, "out.txt"), "changed\n");
      const realSha = sha256File(join(root, "out.txt"));
      const built = buildVerificationArtifacts({
        root,
        observed: {
          branch: "master",
          filesChanged: [{ path: "out.txt", sha256: realSha, sizeBytes: 8 }],
          unreadable: [],
        },
        ctx: { runId: newRunId(), projectId: handle_id() },
        producedBy: "developer",
        extraChecks: [
          {
            kind: "command_replay",
            command: outcome.command,
            exitCode: outcome.exitCode,
            passed: outcome.passed,
            detail: outcome.detail,
          },
        ],
      });
      expect(built.failingChecks).toBe(1);
      if (built.verification && isArtifactKind(built.verification, "verification")) {
        expect(built.verification.payload.verdict).toBe("rejected");
      } else {
        expect.unreachable();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("service-level: rejected verification marks execution failed + task failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "svc-verify-"));
    try {
      // The fake agent claims success but DevMesh's replay fails.
      let started = false;
      const storage = createStorage({ path: join(root, "t.db") });
      const workspaces = new WorkspaceService({
        store: storage.projects,
        workspacesRoot: join(root, "ws"),
      });
      const handle = workspaces.create("verify-svc");
      const { ExecutionService } = await import("./executions/service.js");
      const svc = new ExecutionService({
        storage,
        workspaces,
        git: new GitService(),
        agents: createDefaultAgentRegistry(),
        runtime: new FakeRuntime({
          steps: [
            {
              effect: () => writeFileSync(join(handle.root, "feature.txt"), "v1\n"),
              events: [{ kind: "tool", tool: "write", status: "completed" }],
            },
          ],
          outcome: { status: "completed", sessionId: "ses_v", finalText: "done", exitCode: 0 },
          stepDelayMs: 5,
        }),
      });
      started = true;
      void started;
      const rec = await svc.start({
        projectId: handle.projectId,
        instruction: "write feature.txt",
        verificationCommand: "node -e require('node:fs').readFileSync('/nonexistent')",
      });
      const deadline = Date.now() + 8000;
      for (;;) {
        const row = storage.executions.get(rec.id);
        if (row && row.status !== "running") {
          expect(row.status).toBe("failed");
          expect(row.failureKind).toBe("verification_failed");
          break;
        }
        if (Date.now() > deadline) throw new Error("never finalized");
        await new Promise((r) => setTimeout(r, 25));
      }
      // artifacts still recorded (change_set + rejected verification)
      expect(storage.artifacts.listByRun(rec.runId as never)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** placeholder project id for pure-artifact tests */
const handle_id = (): ProjectId => projectIdSchema.parse(crypto.randomUUID());
