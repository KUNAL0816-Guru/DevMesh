import {
  canTransition,
  makeTaskCard,
  newRunId,
  type TaskCard,
  type TaskId,
  type ProjectId,
  type ArtifactId,
  type AgentRole,
  type Artifact,
} from "@devmesh/contracts";
import type { Storage, ExecutionRecord } from "@devmesh/storage";
import type { WorkspaceService } from "@devmesh/workspace";
import type { ExecutionService } from "./executions/service.js";
import {
  buildSpecArtifact,
  buildPlanArtifact,
  buildTestReportArtifact,
  buildReviewArtifact,
} from "./artifact-builder.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TESTER_REVISIONS = 2;
const MAX_REVIEWER_REVISIONS = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelineStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface PipelineResult {
  status: PipelineStatus;
  taskId: TaskId;
  projectId: ProjectId;
  errorMessage?: string;
}

export interface OrchestratorOptions {
  storage: Storage;
  workspaces: WorkspaceService;
  executionService: ExecutionService;
  /** Max tester revision cycles before blocking (default 2). */
  maxTesterRevisions?: number;
  /** Max reviewer revision cycles before blocking (default 1). */
  maxReviewerRevisions?: number;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Runtime-neutral DAG orchestrator for the multi-agent pipeline.
 *
 * Pipeline: architect -> developer -> tester -> reviewer -> done
 * Revision loops:
 *   tester fails -> developer retry -> tester (up to maxTesterRevisions)
 *   reviewer rejects -> developer retry -> tester -> reviewer (up to maxReviewerRevisions)
 *
 * All agent behavior comes from the AgentRegistry; nothing is hard-coded
 * inside this class beyond the pipeline topology and revision limits.
 */
export class Orchestrator {
  private readonly storage: Storage;
  private readonly workspaces: WorkspaceService;
  private readonly executionService: ExecutionService;
  private readonly maxTesterRevisions: number;
  private readonly maxReviewerRevisions: number;
  private _userTask = "";

  constructor(opts: OrchestratorOptions) {
    this.storage = opts.storage;
    this.workspaces = opts.workspaces;
    this.executionService = opts.executionService;
    this.maxTesterRevisions = opts.maxTesterRevisions ?? MAX_TESTER_REVISIONS;
    this.maxReviewerRevisions = opts.maxReviewerRevisions ?? MAX_REVIEWER_REVISIONS;
  }

  /**
   * Execute the full multi-agent pipeline for a user task.
   * Returns when the pipeline reaches a terminal state.
   */
  async run(
    projectId: ProjectId,
    userTask: string,
  ): Promise<PipelineResult> {
    this._userTask = userTask;
    const handle = this.workspaces.get(projectId);
    const runId = newRunId();

    this.emit({
      ts: new Date().toISOString(),
      runId,
      projectId,
      actor: "system",
      type: "run.started",
      goal: userTask.slice(0, 8000),
    });

    // --- Create the task chain (all persisted before any execution) --------

    const architectTask = this.createTask(runId, projectId, "architect",
      "Architecture analysis", userTask, []);
    const developerTask = this.createTask(runId, projectId, "developer",
      "Implementation", "Implement the approved plan", [architectTask.id]);
    const testerTask = this.createTask(runId, projectId, "tester",
      "Test verification", "Verify the implementation", [developerTask.id]);
    const reviewerTask = this.createTask(runId, projectId, "reviewer",
      "Code review", "Review the changes and test results",
      [developerTask.id, testerTask.id]);

    const taskChain: TaskCard[] = [architectTask, developerTask, testerTask, reviewerTask];

    // --- Pipeline execution loop ------------------------------------------

    let currentIdx = 0;
    let testerRevisions = 0;
    let reviewerRevisions = 0;

    // Track artifact IDs for downstream reference
    let latestChangeSetId: ArtifactId | undefined;
    let latestTestReportId: ArtifactId | undefined;

    while (currentIdx < taskChain.length) {
      const card = taskChain[currentIdx]!;
      const role = card.role;

      // Unready tasks (deps not satisfied) — should not happen with our
      // linear chain, but guard against it.
      if (!this.areDependenciesSatisfied(card)) {
        this.transitionTask(card, "blocked");
        return this.result("failed", card.id, projectId,
          `dependencies not satisfied for ${role}`);
      }

      this.transitionTask(card, "ready");
      const instruction = this.assembleInstruction(card, taskChain, handle.root);

      let rec: ExecutionRecord;
      try {
        rec = await this.executionService.start({
          projectId,
          instruction,
          taskId: card.id,
          agentId: role,
        });
      } catch (err) {
        this.transitionTask(card, "failed");
        return this.result("failed", card.id, projectId,
          `failed to start ${role}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Wait for terminal state
      const terminal = await this.waitForTerminal(card.id, rec.id);
      const refreshed = this.storage.tasks.get(card.id as TaskId)!;

      if (refreshed.status === "in_review") {
        // Success — advance to next stage.  We intentionally leave the task
        // at "in_review" (not "done") so that revision logic can transition
        // it back to "revising → running" if a downstream agent fails.
        currentIdx++;
        testerRevisions = 0;
        reviewerRevisions = 0;

        // --- Produce structured artifacts from agent text reply -----------
        const replyText = this.getTaskReplyText(card) ?? "";
        const actx = { runId, projectId, taskId: card.id as TaskId, producedBy: role as AgentRole };
        try {
          if (role === "architect" && replyText) {
            const spec = buildSpecArtifact(replyText, actx);
            const plan = buildPlanArtifact(replyText, actx);
            this.storage.artifacts.insert(spec);
            this.storage.artifacts.insert(plan);
            this.emitArtifact(spec, "architect");
            this.emitArtifact(plan, "architect");
          } else if (role === "tester") {
            const tr = buildTestReportArtifact(replyText || "Tests completed successfully.", actx);
            this.storage.artifacts.insert(tr);
            this.emitArtifact(tr, "tester");
            latestTestReportId = tr.id;
          } else if (role === "reviewer" && replyText) {
            const rv = buildReviewArtifact(
              replyText, latestChangeSetId ?? ("" as ArtifactId), latestTestReportId, actx,
            );
            this.storage.artifacts.insert(rv);
            this.emitArtifact(rv, "reviewer");
          }
        } catch {
          // Artifact creation failure is non-fatal — pipeline continues
        }

        // Capture the changeSetId from the latest execution for reviewer
        if (role === "developer") {
          const execRec = this.getTaskExecution(card);
          if (execRec?.resultArtifactId) {
            latestChangeSetId = execRec.resultArtifactId as ArtifactId;
          }
        }

        if (role === "reviewer") {
          // Pipeline complete — transition all tasks to "done"
          for (const t of taskChain) {
            this.transitionTask(t, "done");
          }
          this.emit({
            ts: new Date().toISOString(),
            runId,
            projectId,
            actor: "system",
            type: "run.completed",
            summary: "pipeline completed successfully",
          });
          return this.result("completed", reviewerTask.id, projectId);
        }
        continue;
      }

      // Failure/timeout path
      if (terminal === "timeout") {
        this.emit({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.failed",
          reason: `${role} timed out`,
        });
        return this.result("timeout", card.id, projectId, `${role} timed out`);
      }

      if (terminal === "cancelled") {
        this.emit({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.cancelled",
          reason: `${role} was cancelled`,
        });
        return this.result("cancelled", card.id, projectId, `${role} was cancelled`);
      }

      // --- Revision logic -------------------------------------------------

      if (role === "tester" && refreshed.status === "failed") {
        testerRevisions++;
        if (testerRevisions > this.maxTesterRevisions) {
          this.transitionTask(testerTask, "blocked");
          this.emit({
            ts: new Date().toISOString(),
            runId,
            projectId,
            actor: "system",
            type: "run.failed",
            reason: "tester revision budget exhausted",
          });
          return this.result("failed", testerTask.id, projectId,
            "tester revision budget exhausted");
        }
        // Retry developer
        this.transitionTask(developerTask, "revising");
        this.transitionTask(developerTask, "running");
        currentIdx = taskChain.indexOf(developerTask);
        continue;
      }

      if (role === "reviewer" && refreshed.status === "failed") {
        reviewerRevisions++;
        if (reviewerRevisions > this.maxReviewerRevisions) {
          this.transitionTask(reviewerTask, "blocked");
          this.emit({
            ts: new Date().toISOString(),
            runId,
            projectId,
            actor: "system",
            type: "run.failed",
            reason: "reviewer revision budget exhausted",
          });
          return this.result("failed", reviewerTask.id, projectId,
            "reviewer revision budget exhausted");
        }
        // Retry developer -> tester -> reviewer
        this.transitionTask(developerTask, "revising");
        this.transitionTask(developerTask, "running");
        currentIdx = taskChain.indexOf(developerTask);
        continue;
      }

      // Developer failed — block the pipeline
      if (role === "developer" && refreshed.status === "failed") {
        this.transitionTask(developerTask, "blocked");
        this.emit({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.failed",
          reason: "developer failed",
        });
        return this.result("failed", developerTask.id, projectId,
          "developer failed");
      }

      // Architect failed — block the pipeline
      if (role === "architect" && refreshed.status === "failed") {
        this.transitionTask(architectTask, "blocked");
        this.emit({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.failed",
          reason: "architect failed",
        });
        return this.result("failed", architectTask.id, projectId,
          "architect failed");
      }

      // Unexpected state
      this.emit({
        ts: new Date().toISOString(),
        runId,
        projectId,
        actor: "system",
        type: "run.failed",
        reason: `unexpected state for ${role}: ${refreshed.status}`,
      });
      return this.result("failed", card.id, projectId,
        `unexpected state for ${role}: ${refreshed.status}`);
    }

    // Should not reach here
    return this.result("failed", taskChain[taskChain.length - 1]!.id, projectId,
      "pipeline fell through");
  }

  // --- Internal helpers ---------------------------------------------------

  private createTask(
    runId: ReturnType<typeof newRunId>,
    projectId: ProjectId,
    role: TaskCard["role"],
    title: string,
    detail: string,
    dependsOn: TaskId[],
  ): TaskCard {
    const card = makeTaskCard({
      projectId,
      runId,
      role,
      status: "pending",
      title,
      detail,
      acceptanceCriteria: [`DevMesh verification passes`],
      dependsOn,
      maxAttempts: role === "developer" ? 3 : 2,
    });
    this.storage.tasks.insert(card);
    this.emit({
      ts: card.createdAt,
      runId,
      projectId,
      actor: "system",
      type: "task.created",
      card,
    });
    return card;
  }

  private transitionTask(card: TaskCard, to: TaskCard["status"]): void {
    const current = this.storage.tasks.get(card.id as TaskId);
    if (!current) return;
    if (!canTransition(current.status, to)) return;
    const now = new Date().toISOString();
    const updated = {
      ...current,
      status: to,
      attempts: to === "running" ? current.attempts + 1 : current.attempts,
      updatedAt: now,
    };
    this.storage.tasks.update(updated);
    this.emit({
      ts: now,
      runId: current.runId,
      projectId: current.projectId,
      actor: "system",
      type: "task.transitioned",
      taskId: current.id,
      from: current.status,
      to,
    });
  }

  private areDependenciesSatisfied(
    card: TaskCard,
  ): boolean {
    for (const depId of card.dependsOn) {
      const dep = this.storage.tasks.get(depId as TaskId);
      if (!dep) return false;
      // "in_review" = successfully completed, "done" = pipeline complete
      if (dep.status !== "done" && dep.status !== "in_review") return false;
    }
    return true;
  }

  private assembleInstruction(
    card: TaskCard,
    _chain: TaskCard[],
    workspaceRoot: string,
  ): string {
    const parts: string[] = [card.detail];

    // Inject the original user task for downstream agents so they know the goal
    if (card.role !== "architect" && this._userTask) {
      parts.push("", "# Original request", "", this._userTask.slice(0, 4000));
    }

    // Inject artifact context from completed predecessor tasks
    if (card.role !== "architect") {
      const contextSnippets = this.buildContextSnippets(card);
      if (contextSnippets) {
        parts.push("", "# Context from previous stages", "", contextSnippets);
      }
    }

    parts.push(
      "",
      "# Workspace",
      `Working directory: ${workspaceRoot}`,
      "",
      "# Rules",
      "- Do not claim results you haven't verified.",
      "- Only modify files in the working directory.",
    );

    return parts.join("\n");
  }

  private buildContextSnippets(card: TaskCard): string {
    const snippets: string[] = [];

    if (card.role === "developer" || card.role === "tester" || card.role === "reviewer") {
      const architectTask = this.findCompletedTask("architect");
      if (architectTask) {
        const replyText = this.getTaskReplyText(architectTask);
        const latestArtifact = this.getLatestTextArtifact(architectTask);
        if (replyText) {
          snippets.push(
            "## Architect's analysis",
            replyText.slice(0, 4000),
          );
        } else if (latestArtifact) {
          snippets.push(
            "## Architect's analysis",
            latestArtifact,
          );
        }
      }
    }

    if (card.role === "reviewer") {
      const developerTask = this.findCompletedTask("developer");
      if (developerTask) {
        const text = this.getTaskReplyText(developerTask) ?? this.getLatestTextArtifact(developerTask);
        if (text) {
          snippets.push(
            "## Developer's implementation notes",
            text.slice(0, 2000),
          );
        }
      }
      const testerTask = this.findCompletedTask("tester");
      if (testerTask) {
        const text = this.getTaskReplyText(testerTask) ?? this.getLatestTextArtifact(testerTask);
        if (text) {
          snippets.push(
            "## Tester's results",
            text.slice(0, 2000),
          );
        }
      }
    }

    if (card.role === "tester") {
      const developerTask = this.findCompletedTask("developer");
      if (developerTask) {
        const text = this.getTaskReplyText(developerTask) ?? this.getLatestTextArtifact(developerTask);
        if (text) {
          snippets.push(
            "## Developer's implementation",
            text.slice(0, 2000),
          );
        }
      }
    }

    // For retries: include failure context
    if (card.attempts > 0) {
      if (card.role === "developer") {
        // Check if tester or reviewer failed previously
        const testerTask = this.findTaskByRole("tester");
        if (testerTask && testerTask.status === "failed") {
          const latestText = this.getLatestTextArtifact(testerTask);
          if (latestText) {
            snippets.push(
              "## Tester's failure report (please fix these issues)",
              latestText.slice(0, 2000),
            );
          }
        }
        const reviewerTask = this.findTaskByRole("reviewer");
        if (reviewerTask && reviewerTask.status === "failed") {
          const latestText = this.getLatestTextArtifact(reviewerTask);
          if (latestText) {
            snippets.push(
              "## Reviewer's rejection (please address these issues)",
              latestText.slice(0, 2000),
            );
          }
        }
      }
    }

    return snippets.join("\n\n");
  }

  private findCompletedTask(role: string): TaskCard | null {
    const task = this.findTaskByRole(role);
    if (task && task.status === "in_review") return task;
    return null;
  }

  private findTaskByRole(role: string): TaskCard | null {
    const runId = this.findCurrentRunId();
    if (!runId) return null;
    const tasks = this.storage.tasks.listByRun(runId as never);
    return tasks.find((t) => t.role === role) ?? null;
  }

  private findCurrentRunId(): string | null {
    const events = this.storage.events.listAfter(0, 200);
    for (const evt of [...events].reverse()) {
      if (evt.type === "run.started" && "goal" in evt && evt.runId) {
        return evt.runId;
      }
    }
    return null;
  }

  private getTaskReplyText(task: TaskCard): string | null {
    const recs = this.storage.executions.listByProject(task.projectId);
    for (const rec of recs) {
      if (rec.taskId === task.id && rec.status === "completed" && rec.replyText) {
        return rec.replyText;
      }
    }
    return null;
  }

  private getLatestTextArtifact(task: TaskCard): string | null {
    // Find the most recent text-type artifact for this task
    if (!task.runId) return null;
    const artifacts = this.storage.artifacts.listByRun(task.runId as never);
    // Look for change_set or test_report or review artifacts
    for (const a of [...artifacts].reverse()) {
      if (a.kind === "change_set" && "filesChanged" in a.payload) {
        const files = (a.payload as { filesChanged?: Array<{ path: string }> }).filesChanged;
        if (files && files.length > 0) {
          return `Changed files: ${files.map((f) => f.path).join(", ")}`;
        }
      }
      if (a.kind === "test_report" && "verdict" in a.payload) {
        const p = a.payload as { verdict: string; totals?: { passed: number; failed: number } };
        return `Test verdict: ${p.verdict} (passed: ${p.totals?.passed ?? 0}, failed: ${p.totals?.failed ?? 0})`;
      }
      if (a.kind === "review" && "verdict" in a.payload) {
        const p = a.payload as { verdict: string; summary?: string };
        return `Review: ${p.verdict} — ${p.summary ?? "no summary"}`;
      }
    }
    return null;
  }

  private async waitForTerminal(
    _taskId: TaskId,
    executionId: string,
    timeoutMs = 360_000,
  ): Promise<ExecutionRecord["status"]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rec = this.storage.executions.get(executionId);
      if (rec && rec.status !== "running") return rec.status;
      if (Date.now() > deadline) return "timeout";
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private result(
    status: PipelineStatus,
    taskId: TaskId,
    projectId: ProjectId,
    errorMessage?: string,
  ): PipelineResult {
    return { status, taskId, projectId, errorMessage };
  }

  private emit(event: Record<string, unknown>): void {
    try {
      this.storage.events.append(event as never);
    } catch {
      /* event persistence is best-effort */
    }
  }

  private emitArtifact(artifact: Artifact, role: string): void {
    this.emit({
      ts: new Date().toISOString(),
      runId: artifact.runId,
      projectId: artifact.projectId,
      actor: "system",
      type: "artifact.recorded",
      artifactId: artifact.id,
      kind: artifact.kind,
      producedBy: role,
    });
  }

  private getTaskExecution(task: TaskCard): ExecutionRecord | null {
    const recs = this.storage.executions.listByProject(task.projectId);
    for (const rec of recs) {
      if (rec.taskId === task.id && rec.status === "completed") {
        return rec;
      }
    }
    return null;
  }
}
