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
  type ArtifactKind,
} from "@devmesh/contracts";
import type { Storage, ExecutionRecord } from "@devmesh/storage";
import type { WorkspaceService, GitService } from "@devmesh/workspace";
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
const DEFAULT_DOOM_LOOP_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Doom-loop detection
// ---------------------------------------------------------------------------

/**
 * Detects repeated ineffective cycles where the same agent fails with the
 * identical signature multiple times in a row. When a doom-loop is detected,
 * the pipeline terminates with a stable failure reason.
 */
export class DoomLoopDetector {
  private readonly threshold: number;
  /** Map from agent role → consecutive failure count for the current signature. */
  private readonly consecutiveFailures = new Map<string, number>();
  /** Map from agent role → the last failure signature seen. */
  private readonly lastSignature = new Map<string, string | null>();

  constructor(threshold: number = DEFAULT_DOOM_LOOP_THRESHOLD) {
    this.threshold = threshold;
  }

  /**
   * Record a failure for the given agent role. Returns `true` if a doom-loop
   * is detected (threshold exceeded).
   */
  recordFailure(role: string, failureSignature: string): boolean {
    const prev = this.lastSignature.get(role);
    if (prev === failureSignature) {
      const count = (this.consecutiveFailures.get(role) ?? 0) + 1;
      this.consecutiveFailures.set(role, count);
      return count >= this.threshold;
    }
    // New or different signature — reset to 1
    this.lastSignature.set(role, failureSignature);
    this.consecutiveFailures.set(role, 1);
    return false;
  }

  /**
   * Call when an agent succeeds to reset its doom-loop counter.
   */
  recordSuccess(role: string): void {
    this.consecutiveFailures.delete(role);
    this.lastSignature.delete(role);
  }

  /** Get the current consecutive failure count for a role. */
  getCount(role: string): number {
    return this.consecutiveFailures.get(role) ?? 0;
  }

  /** Check if a doom-loop is currently active for a role. */
  isDoomLoop(role: string): boolean {
    return (this.consecutiveFailures.get(role) ?? 0) >= this.threshold;
  }
}

/**
 * Compute a compact failure signature from a runtime execution record.
 * Two failures with the same kind and similar message produce the same
 * signature, enabling doom-loop detection.
 */
export function computeFailureSignature(rec: ExecutionRecord): string {
  const kind = rec.failureKind ?? "unknown";
  const msg = (rec.errorMessage ?? "").slice(0, 200);
  // Strip dynamic parts (timestamps, UUIDs, line numbers) for fuzzy matching
  const normalized = msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?/g, "<ts>")
    .replace(/:\d+:\d+/g, ":L")
    .replace(/\s+/g, " ")
    .trim();
  return `${kind}:${normalized}`;
}

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
  git?: GitService;
  /** Max tester revision cycles before blocking (default 2). */
  maxTesterRevisions?: number;
  /** Max reviewer revision cycles before blocking (default 1). */
  maxReviewerRevisions?: number;
  /** Consecutive identical failures before doom-loop termination (default 3). */
  doomLoopThreshold?: number;
  /** Override default maxAttempts per role. */
  taskMaxAttempts?: Partial<Record<TaskCard["role"], number>>;
  /**
   * Hard cap on total execution attempts across all roles in a single
   * pipeline run. If exceeded, the pipeline terminates immediately.
   * Default: Infinity (no pipeline-level cap).
   */
  maxTotalAttempts?: number;
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
  private readonly git: GitService | null;
  private readonly maxTesterRevisions: number;
  private readonly maxReviewerRevisions: number;
  private readonly doomLoop: DoomLoopDetector;
  private readonly taskMaxAttempts: Partial<Record<TaskCard["role"], number>>;
  private readonly maxTotalAttempts: number;
  private _userTask = "";

  constructor(opts: OrchestratorOptions) {
    this.storage = opts.storage;
    this.workspaces = opts.workspaces;
    this.executionService = opts.executionService;
    this.git = opts.git ?? null;
    this.maxTesterRevisions = opts.maxTesterRevisions ?? MAX_TESTER_REVISIONS;
    this.maxReviewerRevisions = opts.maxReviewerRevisions ?? MAX_REVIEWER_REVISIONS;
    this.doomLoop = new DoomLoopDetector(opts.doomLoopThreshold ?? DEFAULT_DOOM_LOOP_THRESHOLD);
    this.taskMaxAttempts = opts.taskMaxAttempts ?? {};
    this.maxTotalAttempts = opts.maxTotalAttempts ?? Infinity;
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
    let totalAttempts = 0;

    // Track artifact IDs for downstream reference
    let latestChangeSetId: ArtifactId | undefined;
    let latestTestReportId: ArtifactId | undefined;

    while (currentIdx < taskChain.length) {
      const card = taskChain[currentIdx]!;
      const role = card.role;

      // Pipeline-level attempt budget check
      totalAttempts++;
      if (totalAttempts > this.maxTotalAttempts) {
        this.emit({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "error.raised",
          scope: "orchestrator/pipeline-budget",
          message: `pipeline total attempt budget exhausted (${this.maxTotalAttempts})`,
          fatal: true,
        });
        return this.result("failed", card.id, projectId,
          "pipeline total attempt budget exhausted");
      }

      // Unready tasks (deps not satisfied) — should not happen with our
      // linear chain, but guard against it.
      if (!this.areDependenciesSatisfied(card)) {
        this.transitionTask(card, "blocked");
        return this.result("failed", card.id, projectId,
          `dependencies not satisfied for ${role}`);
      }

      this.transitionTask(card, "ready");
      const instruction = this.assembleInstruction(card, taskChain, handle.root);

      // --- Git checkpoint before developer starts modifying files -----------
      if (role === "developer" && this.git && card.attempts <= 1) {
        try {
          const cp = this.git.checkpoint(handle.root, `pre-developer-${card.attempts}`);
          this.emit({
            ts: new Date().toISOString(),
            runId,
            projectId,
            actor: "system",
            type: "run.started",
            goal: `git checkpoint created: ${cp.label}`,
          });
        } catch {
          // Checkpoint failure is non-fatal — pipeline continues
        }
      }

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
        this.doomLoop.recordSuccess(role);

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
        // Doom-loop detection: check if tester keeps failing identically
        const lastExec = this.getLatestTaskExecution(testerTask);
        if (lastExec) {
          const sig = computeFailureSignature(lastExec);
          if (this.doomLoop.recordFailure("tester", sig)) {
            this.transitionTask(testerTask, "blocked");
            this.emit({
              ts: new Date().toISOString(),
              runId,
              projectId,
              actor: "system",
              type: "error.raised",
              scope: "orchestrator/doom-loop",
              message: `doom-loop: tester repeating identical failure (${this.doomLoop.getCount("tester")}x)`,
              fatal: true,
            });
            return this.result("failed", testerTask.id, projectId,
              `doom-loop: tester repeating identical failure`);
          }
          // Record the revision cycle for structured tracking
          this.storage.revisionCycles.insert({
            runId,
            projectId,
            taskId: testerTask.id,
            cycleType: "tester_failure",
            attemptNumber: testerRevisions,
            failureKind: lastExec.failureKind,
            failureSignature: sig,
          });
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
        // Doom-loop detection: check if reviewer keeps rejecting identically
        const lastExec = this.getLatestTaskExecution(reviewerTask);
        if (lastExec) {
          const sig = computeFailureSignature(lastExec);
          if (this.doomLoop.recordFailure("reviewer", sig)) {
            this.transitionTask(reviewerTask, "blocked");
            this.emit({
              ts: new Date().toISOString(),
              runId,
              projectId,
              actor: "system",
              type: "error.raised",
              scope: "orchestrator/doom-loop",
              message: `doom-loop: reviewer repeating identical rejection (${this.doomLoop.getCount("reviewer")}x)`,
              fatal: true,
            });
            return this.result("failed", reviewerTask.id, projectId,
              `doom-loop: reviewer repeating identical rejection`);
          }
          // Record the revision cycle for structured tracking
          this.storage.revisionCycles.insert({
            runId,
            projectId,
            taskId: reviewerTask.id,
            cycleType: "reviewer_rejection",
            attemptNumber: reviewerRevisions,
            failureKind: lastExec.failureKind,
            failureSignature: sig,
          });
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
    const defaultMax = role === "developer" ? 3 : 2;
    const maxAttempts = this.taskMaxAttempts[role] ?? defaultMax;
    const card = makeTaskCard({
      projectId,
      runId,
      role,
      status: "pending",
      title,
      detail,
      acceptanceCriteria: [`DevMesh verification passes`],
      dependsOn,
      maxAttempts,
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

    // For retries: include structured failure context from artifacts
    if (card.attempts > 0) {
      if (card.role === "developer") {
        // Check if tester failed — provide structured test report context
        const testerTask = this.findTaskByRole("tester");
        if (testerTask && testerTask.status === "failed") {
          const failureCtx = this.buildTesterFailureContext(testerTask);
          if (failureCtx) {
            snippets.push(failureCtx);
          } else {
            // Fallback to text artifact
            const latestText = this.getLatestTextArtifact(testerTask);
            if (latestText) {
              snippets.push(
                "## Tester's failure report (please fix these issues)",
                latestText.slice(0, 2000),
              );
            }
          }
        }
        // Check if reviewer rejected — provide structured review context
        const reviewerTask = this.findTaskByRole("reviewer");
        if (reviewerTask && reviewerTask.status === "failed") {
          const rejectionCtx = this.buildReviewerRejectionContext(reviewerTask);
          if (rejectionCtx) {
            snippets.push(rejectionCtx);
          } else {
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
    }

    return snippets.join("\n\n");
  }

  /** Build structured failure context from the tester's test_report.v1 artifact. */
  private buildTesterFailureContext(testerTask: TaskCard): string | null {
    const trArtifact = this.findLatestArtifactOfKind(testerTask, "test_report");
    if (!trArtifact) return null;
    const p = trArtifact.payload as Record<string, unknown>;
    const verdict = p.verdict as string | undefined;
    const failures = p.failures as Array<{ name?: string; message?: string }> | undefined;
    const totals = p.totals as { passed?: number; failed?: number } | undefined;
    const lines = ["## Tester's failure report (please fix these issues)"];
    lines.push(`Verdict: ${verdict ?? "fail"}`);
    if (totals) {
      lines.push(`Totals: ${totals.passed ?? 0} passed, ${totals.failed ?? 0} failed`);
    }
    if (failures && failures.length > 0) {
      lines.push("Failures:");
      for (const f of failures.slice(0, 10)) {
        const name = f.name ?? "unknown";
        const msg = f.message ? ` — ${f.message.slice(0, 300)}` : "";
        lines.push(`- ${name}${msg}`);
      }
      if (failures.length > 10) {
        lines.push(`... and ${failures.length - 10} more`);
      }
    }
    return lines.join("\n");
  }

  /** Build structured rejection context from the reviewer's review.v1 artifact. */
  private buildReviewerRejectionContext(reviewerTask: TaskCard): string | null {
    const rvArtifact = this.findLatestArtifactOfKind(reviewerTask, "review");
    if (!rvArtifact) return null;
    const p = rvArtifact.payload as Record<string, unknown>;
    const verdict = p.verdict as string | undefined;
    const findings = p.findings as Array<{ severity?: string; file?: string; message?: string }> | undefined;
    const summary = p.summary as string | undefined;
    const lines = ["## Reviewer's rejection (please address these issues)"];
    lines.push(`Verdict: ${verdict ?? "changes_requested"}`);
    if (summary) {
      lines.push(`Summary: ${summary.slice(0, 1000)}`);
    }
    if (findings && findings.length > 0) {
      // Filter to actionable findings (major/critical)
      const actionable = findings.filter((f) => f.severity === "major" || f.severity === "critical");
      const display = actionable.length > 0 ? actionable : findings;
      lines.push("Findings:");
      for (const f of display.slice(0, 10)) {
        const sev = f.severity ?? "info";
        const loc = f.file ? ` (${f.file})` : "";
        const msg = f.message ?? "";
        lines.push(`- [${sev}]${loc} ${msg.slice(0, 300)}`);
      }
      if (display.length > 10) {
        lines.push(`... and ${display.length - 10} more`);
      }
    }
    return lines.join("\n");
  }

  /** Find the latest artifact of a specific kind for a given task. */
  private findLatestArtifactOfKind(task: TaskCard, kind: ArtifactKind): Artifact | null {
    // Search across all runs for this project, filtered by task
    const recs = this.storage.executions.listByProject(task.projectId);
    for (const rec of [...recs].reverse()) {
      if (rec.taskId !== task.id) continue;
      if (rec.status !== "completed" && rec.status !== "failed") continue;
      if (!rec.runId) continue;
      const artifacts = this.storage.artifacts.listByRun(rec.runId as never);
      for (const a of [...artifacts].reverse()) {
        if (a.kind === kind) return a;
      }
    }
    return null;
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
    // Attempt rollback on fatal failures if git is available
    if ((status === "failed" || status === "cancelled" || status === "timeout") && this.git) {
      try {
        const handle = this.workspaces.get(projectId);
        const checkpoints = this.git.listCheckpoints(handle.root);
        if (checkpoints.length > 0) {
          // Clean untracked/modified files before rollback so the workspace is clean
          this.git.run(handle.root, ["checkout", "--", "."]);
          this.git.run(handle.root, ["clean", "-fd"]);
          this.git.rollbackTo(handle.root, checkpoints[0]!.sha);
        }
      } catch {
        // Rollback failure is non-fatal — the pipeline status is what matters
      }
    }
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

  /** Get the latest execution for a task, regardless of terminal status. */
  private getLatestTaskExecution(task: TaskCard): ExecutionRecord | null {
    const recs = this.storage.executions.listByProject(task.projectId);
    let latest: ExecutionRecord | null = null;
    for (const rec of recs) {
      if (rec.taskId === task.id && rec.status !== "running" && rec.status !== "pending") {
        if (!latest || (rec.startedAt ?? "") > (latest.startedAt ?? "")) {
          latest = rec;
        }
      }
    }
    return latest;
  }

  /**
   * Detect and report interrupted pipeline executions for a project.
   * Called on startup to surface any executions that were left in-flight
   * by a previous DevMesh process. Rolls back the workspace to the last
   * checkpoint if one exists.
   *
   * Returns the number of interrupted executions found.
   */
  recoverInterruptedPipelines(projectId: ProjectId): number {
    const unfinished = this.storage.executions.findUnfinished();
    const projectUnfinished = unfinished.filter((r) => r.projectId === projectId);
    if (projectUnfinished.length === 0) return 0;

    const now = new Date().toISOString();

    // Mark all unfinished executions as interrupted
    for (const rec of projectUnfinished) {
      this.storage.executions.update({
        ...rec,
        status: "interrupted",
        finishedAt: now,
        errorMessage: rec.errorMessage ?? "Pipeline was interrupted by a DevMesh restart",
      });
      this.emit({
        ts: now,
        runId: rec.runId,
        projectId,
        actor: "system",
        type: "error.raised",
        scope: "execution/interrupted",
        message: `execution ${rec.id} was interrupted by a DevMesh restart`,
        fatal: false,
      } as never);
    }

    // Attempt to roll back workspace to last checkpoint
    if (this.git) {
      try {
        const handle = this.workspaces.get(projectId);
        const checkpoints = this.git.listCheckpoints(handle.root);
        if (checkpoints.length > 0) {
          this.git.run(handle.root, ["checkout", "--", "."]);
          this.git.run(handle.root, ["clean", "-fd"]);
          this.git.rollbackTo(handle.root, checkpoints[0]!.sha);
        }
      } catch {
        // Rollback failure is non-fatal
      }
    }

    return projectUnfinished.length;
  }
}
