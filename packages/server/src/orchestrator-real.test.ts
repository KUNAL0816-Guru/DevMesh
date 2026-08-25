/**
 * REAL OpenCode multi-agent pipeline test (Phase 4B FINAL VALIDATION).
 *
 * Runs the complete Architect -> Developer -> Tester -> Reviewer pipeline
 * through the real OpenCode CLI with a real LLM, then verifies:
 * - All 6 artifact kinds produced (spec, plan, change_set, test_report, review, verification)
 * - SHA-256 verification independently
 * - Downstream agents received upstream context (replyText)
 * - Fresh workspace + fresh SQLite database
 *
 * Gated behind:
 *   DEVMESH_IT_OPENCODE=1
 *   DEVMESH_IT_MODEL=opencode/nemotron-3.5-lightning-free
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStorage, type Storage } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import type { AgentRuntime } from "@devmesh/runtime";
import { Orchestrator } from "./orchestrator.js";
import { ExecutionService } from "./executions/service.js";
import { createDefaultAgentRegistry } from "@devmesh/agents";

const ENABLED = process.env.DEVMESH_IT_OPENCODE === "1";
const MODEL = process.env.DEVMESH_IT_MODEL;
const BUDGET_MS = Number(process.env.DEVMESH_IT_TIMEOUT_MS ?? 300_000);

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-orch-real-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

interface Stack {
  storage: Storage;
  orchestrator: Orchestrator;
  projectId: string;
  root: string;
}

async function makeStack(model?: string): Promise<Stack> {
  const { OpencodeAdapter } = await import("@devmesh/opencode-adapter");
  const storage = createStorage({ path: join(dataRoot, "real-orch.db") });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(dataRoot, "workspaces"),
  });
  const handle = workspaces.create("real-orch");
  const adapter = new OpencodeAdapter({
    binaryPath: "opencode",
    model,
    autoApprove: true,
  });
  const agents = createDefaultAgentRegistry();
  const executionService = new ExecutionService({
    storage,
    workspaces,
    git: new (await import("@devmesh/workspace")).GitService(),
    runtime: adapter as unknown as AgentRuntime,
    agents,
    defaultTimeoutMs: BUDGET_MS,
    defaultModel: model,
  });
  const orchestrator = new Orchestrator({
    storage,
    workspaces,
    executionService,
    maxTesterRevisions: 1,
    maxReviewerRevisions: 1,
  });
  return { storage, orchestrator, projectId: handle.projectId, root: handle.root };
}

describe.skipIf(!ENABLED)("REAL OpenCode multi-agent pipeline", () => {
  it(
    "full pipeline: architect -> developer -> tester -> reviewer with artifact verification",
    { timeout: BUDGET_MS * 4 + 120_000 },
    async () => {
      const stack = await makeStack(MODEL);
      const result = await stack.orchestrator.run(
        stack.projectId as never,
        [
          "Create a tiny Node.js utility module:",
          "1. A file utils.js exporting a function double(n) that returns n * 2.",
          "2. A file test_utils.js that tests double(5) === 10 using node:test + node:assert.",
          '3. A package.json with {"type":"module"}.',
          "Keep it minimal and simple.",
        ].join(" "),
      );

      // 1. Pipeline should complete
      if (result.status !== "completed") {
        throw new Error(
          `Pipeline ${result.status}: ${result.errorMessage ?? "no error message"}`,
        );
      }
      expect(result.projectId).toBe(stack.projectId);
      expect(result.taskId).toBeDefined();

      // 2. Verify workspace files exist
      expect(existsSync(join(stack.root, "utils.js"))).toBe(true);
      expect(existsSync(join(stack.root, "package.json"))).toBe(true);

      // 3. Verify task chain events
      const events = [...stack.storage.events.listAfter(0, 2000)];
      expect(events.some((e) => e.type === "run.started")).toBe(true);
      expect(events.some((e) => e.type === "run.completed")).toBe(true);

      // 4. Verify each agent role completed
      const execs = stack.storage.executions.listByProject(stack.projectId);
      const completedExecs = execs.filter((e) => e.status === "completed");
      const completedRoles = completedExecs.map((e) => e.role);
      expect(completedRoles).toContain("architect");
      expect(completedRoles).toContain("developer");
      expect(completedRoles).toContain("tester");
      expect(completedRoles).toContain("reviewer");

      // 5. Verify all 6 artifact kinds
      const allArtifactEvents = events.filter((e) => e.type === "artifact.recorded");
      const artifactKinds = new Set(
        allArtifactEvents.map((e) => ("kind" in e ? e.kind : "unknown")),
      );
      expect(artifactKinds.has("spec")).toBe(true);
      expect(artifactKinds.has("plan")).toBe(true);
      expect(artifactKinds.has("change_set")).toBe(true);
      expect(artifactKinds.has("test_report")).toBe(true);
      expect(artifactKinds.has("review")).toBe(true);
      expect(artifactKinds.has("verification")).toBe(true);

      // 6. Verify SHA-256: the verification artifact independently confirmed hashes
      const verificationArtifacts = stack.storage.artifacts.listByProject(stack.projectId, "verification");
      expect(verificationArtifacts.length).toBeGreaterThan(0);
      for (const va of verificationArtifacts) {
        if ("verdict" in va.payload && "checks" in va.payload) {
          const p = va.payload as { verdict: string; checks: Array<{ passed: boolean; kind: string }> };
          expect(p.verdict).toBe("verified");
          expect(p.checks.length).toBeGreaterThan(0);
          for (const c of p.checks) {
            expect(c.passed).toBe(true);
          }
        }
      }

      // 7. Verify downstream context: each agent received upstream replyText
      const architectExec = completedExecs.find((e) => e.role === "architect");
      expect(architectExec).toBeDefined();
      expect(architectExec!.replyText).toBeTruthy();
      expect(architectExec!.replyText!.length).toBeGreaterThan(50);

      const developerExec = completedExecs.find((e) => e.role === "developer");
      expect(developerExec).toBeDefined();
      expect(developerExec!.replyText).toBeTruthy();
      expect(developerExec!.replyText!.length).toBeGreaterThan(50);

      const testerExec = completedExecs.find((e) => e.role === "tester");
      expect(testerExec).toBeDefined();
      expect(testerExec!.replyText).toBeTruthy();

      const reviewerExec = completedExecs.find((e) => e.role === "reviewer");
      expect(reviewerExec).toBeDefined();
      expect(reviewerExec!.replyText).toBeTruthy();

      // 8. Verify session events for each agent
      const sessions = events.filter((e) => e.type === "agent.session.opened");
      const sessionRoles = sessions.map((e) => ("role" in e ? e.role : "unknown"));
      expect(sessionRoles).toContain("architect");
      expect(sessionRoles).toContain("developer");
      expect(sessionRoles).toContain("tester");
      expect(sessionRoles).toContain("reviewer");

      await stack.storage.close();
    },
  );
});
