/**
 * REAL OpenCode end-to-end tests (Phase 3 req 6, 11, 12, 13).
 *
 * These run the actual `opencode` CLI through the actual OpencodeAdapter —
 * no stubs. They are skipped unless EXPLICITLY enabled:
 *
 *   DEVMESH_IT_OPENCODE=1 \
 *   DEVMESH_IT_MODEL=anthropic/claude-sonnet-4-5 \   # provider/model
 *   npm test -- opencode-real
 *
 * Requirements: `opencode auth login` has been run for the configured
 * provider (credentials live in opencode's own store; DevMesh never sees
 * them). If credentials are missing, these tests FAIL LOUDLY — they never
 * fake success.
 *
 * Progression (req 13):
 *   A. create a file with specified content
 *   B. create a tiny executable+tested project (DevMesh replays the test)
 *   C. modify an existing file
 *   D. fix a deliberately failing test (DevMesh replays it green)
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isArtifactKind, makeTaskCard, newRunId, type TaskCard } from "@devmesh/contracts";
import { createStorage, type ExecutionRecord, type Storage } from "@devmesh/storage";
import { GitService, WorkspaceService } from "@devmesh/workspace";
import type { AgentRuntime } from "@devmesh/runtime";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";

const ENABLED = process.env.DEVMESH_IT_OPENCODE === "1";
const MODEL = process.env.DEVMESH_IT_MODEL;
const BUDGET_MS = Number(process.env.DEVMESH_IT_TIMEOUT_MS ?? 240_000);

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-real-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

interface Stack {
  app: ReturnType<typeof buildApp>;
  storage: Storage;
  projectId: string;
  root: string;
}

async function makeStack(model?: string): Promise<Stack> {
  const { OpencodeAdapter } = await import("@devmesh/opencode-adapter");
  const storage = createStorage({ path: join(dataRoot, "real.db") });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(dataRoot, "workspaces"),
  });
  const handle = workspaces.create("real-run");
  const adapter = new OpencodeAdapter({ binaryPath: "opencode", model });
  const app = buildApp({
    config: {
      host: "127.0.0.1",
      port: 0,
      dataRoot,
      logLevel: "warn",
      runtime: "opencode",
      opencodeBin: "opencode",
      opencodeAutoApprove: true, // real runs need file-write permissions
      opencodeModel: model,
      execTimeoutMs: BUDGET_MS,
    } as Config,
    storage,
    workspaces,
    runtime: adapter as unknown as AgentRuntime,
  });
  return { app, storage, projectId: handle.projectId, root: handle.root };
}

async function startTask(
  stack: Stack,
  instruction: string,
  verificationCommand?: string,
): Promise<{ rec: ExecutionRecord; card: TaskCard }> {
  const card: TaskCard = makeTaskCard({
    projectId: stack.projectId as never,
    runId: newRunId(),
    role: "developer",
    status: "ready",
    title: instruction.slice(0, 60),
    detail: instruction,
    acceptanceCriteria: ["DevMesh verification passes"],
    dependsOn: [],
  });
  stack.storage.tasks.insert(card);
  const res = await stack.app.inject({
    method: "POST",
    url: `/projects/${stack.projectId}/executions`,
    payload: { instruction, taskId: card.id, verificationCommand },
  });
  expect(res.statusCode).toBe(202);
  return { rec: res.json().execution, card };
}

async function awaitTerminal(stack: Stack, id: string): Promise<ExecutionRecord> {
  const deadline = Date.now() + BUDGET_MS + 30_000;
  for (;;) {
    const row = stack.storage.executions.get(id);
    if (row && row.status !== "running") return row;
    if (Date.now() > deadline) throw new Error(`execution ${id} did not finish in time`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Shared assertions for every successful execution (req 14). */
function assertSuccessfulArtifacts(stack: Stack, rec: ExecutionRecord): void {
  expect(rec.status).toBe("completed");
  expect(rec.failureKind).toBeNull();
  expect(rec.resultArtifactId).toBeTruthy();
  expect(rec.verificationArtifactId).toBeTruthy();

  const changeSet = stack.storage.artifacts.get(rec.resultArtifactId! as never)!;
  expect(isArtifactKind(changeSet, "change_set")).toBe(true);
  const verification = stack.storage.artifacts.get(rec.verificationArtifactId! as never)!;
  expect(isArtifactKind(verification, "verification")).toBe(true);
  if (isArtifactKind(verification, "verification")) {
    expect(verification.payload.verdict).toBe("verified");
    expect(verification.payload.checks.every((c) => c.passed)).toBe(true);
  }

  const events = [...stack.storage.events.listAfter(0)];
  expect(events.some((e) => e.type === "agent.session.opened")).toBe(true);
  expect(events.some((e) => e.type === "artifact.recorded")).toBe(true);
  expect(events.some((e) => e.type === "agent.reply.completed")).toBe(true);

  // task card reached review
  if (rec.taskId) {
    expect(stack.storage.tasks.get(rec.taskId as never)?.status).toBe("in_review");
  }
}

describe.skipIf(!ENABLED)("REAL OpenCode execution progression", () => {
  it("A: creates a file with the specified content", { timeout: BUDGET_MS + 60_000 }, async () => {
    const stack = await makeStack(MODEL);
    const content = `DEVSMOKE-${crypto.randomUUID()}\n`;
    const { rec } = await startTask(
      stack,
      [
        "Create a file named hello.txt in the workspace root.",
        `It must contain exactly this line: ${content.trim()}`,
      ].join(" "),
    );
    const row = await awaitTerminal(stack, rec.id);
    if (row.status !== "completed") {
      throw new Error(`A failed: ${row.status} kind=${row.failureKind} err=${row.errorMessage}`);
    }
    assertSuccessfulArtifacts(stack, row);
    expect(readFileSync(join(stack.root, "hello.txt"), "utf8").trim()).toBe(content.trim());
    await stack.app.close();
  });

  it("B: creates a tiny executable + tested project (DevMesh replays the test)",
    { timeout: BUDGET_MS + 60_000 }, async () => {
        const stack = await makeStack(MODEL);
      const { rec } = await startTask(
        stack,
        [
          "Create a tiny Node.js project in the workspace root:",
          "1. math.js exporting function add(a, b) that returns a+b.",
          "2. test_math.js using node:test + node:assert verifying add(2,3)===5.",
          'Add {"type":"module"} package.json.',
          "Run `node test_math.js` and make sure it passes.",
        ].join(" "),
        "node test_math.js", // DevMesh replays this itself afterwards
      );
      const row = await awaitTerminal(stack, rec.id);
      if (row.status !== "completed") {
        throw new Error(`B failed: ${row.status} kind=${row.failureKind} err=${row.errorMessage}`);
      }
      assertSuccessfulArtifacts(stack, row);
      // independent replay check recorded
      const verification = stack.storage.artifacts.get(row.verificationArtifactId! as never)!;
      if (isArtifactKind(verification, "verification")) {
        const replay = verification.payload.checks.find((c) => c.kind === "command_replay");
        expect(replay?.passed).toBe(true);
      }
      await stack.app.close();
    });

  it("C: modifies an existing file", { timeout: BUDGET_MS + 60_000 }, async () => {
    const stack = await makeStack(MODEL);
    writeFileSync(join(stack.root, "config.ini"), "mode = basic\nretries = 1\n");
    const git = new GitService();
    git.init(stack.root);
    git.add(stack.root, ["."]);
    git.commit(stack.root, "seed config");

    const { rec } = await startTask(
      stack,
      "In config.ini change the retries value to 5. Change nothing else.",
    );
    const row = await awaitTerminal(stack, rec.id);
    if (row.status !== "completed") {
      throw new Error(`C failed: ${row.status} kind=${row.failureKind} err=${row.errorMessage}`);
    }
    assertSuccessfulArtifacts(stack, row);
    const text = readFileSync(join(stack.root, "config.ini"), "utf8");
    expect(text).toContain("retries = 5");
    expect(text).toContain("mode = basic");
    await stack.app.close();
  });

  it("D: fixes a deliberately failing test (DevMesh replays it green)",
    { timeout: BUDGET_MS + 90_000 }, async () => {
        const stack = await makeStack(MODEL);
      writeFileSync(
        join(stack.root, "math.js"),
        "export function sub(a, b) {\n  return a - b - 1; // deliberate bug\n}\n",
      );
      writeFileSync(join(stack.root, "package.json"), '{"type":"module"}\n');
      writeFileSync(
        join(stack.root, "test_sub.js"),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert';",
          "import { sub } from './math.js';",
          "test('sub', () => { assert.strictEqual(sub(5, 2), 3); });",
        ].join("\n"),
      );
      const git = new GitService();
      git.init(stack.root);
      git.add(stack.root, ["."]);
      git.commit(stack.root, "seed broken project");

      // sanity: the seed really fails before the agent runs
      const { runVerificationCommand } = await import("./executions/commands.js");
      const pre = await runVerificationCommand(stack.root, "node test_sub.js", 30_000);
      expect(pre.passed).toBe(false);

      const { rec } = await startTask(
        stack,
        [
          "`node test_sub.js` currently fails.",
          "Fix math.js so the test passes WITHOUT changing test_sub.js.",
        ].join(" "),
        "node test_sub.js",
      );
      const row = await awaitTerminal(stack, rec.id);
      if (row.status !== "completed") {
        throw new Error(`D failed: ${row.status} kind=${row.failureKind} err=${row.errorMessage}`);
      }
      assertSuccessfulArtifacts(stack, row);
      expect(existsSync(join(stack.root, "math.js"))).toBe(true);
      const verification = stack.storage.artifacts.get(row.verificationArtifactId! as never)!;
      if (isArtifactKind(verification, "verification")) {
        const replay = verification.payload.checks.find((c) => c.kind === "command_replay");
        expect(replay?.passed).toBe(true); // DevMesh proved the fix itself
      }
      await stack.app.close();
    });
});
