import {
  canTransition,
  makeContextEntry,
  makeTaskCard,
  newRunId,
  TerminalStateError,
  type TaskCard,
  type TaskId,
  type ProjectId,
  type ArtifactId,
  type AgentRole,
  type Artifact,
  type ArtifactKind,
} from "@devmesh/contracts";
import type { Storage, ExecutionRecord, StageRecord } from "@devmesh/storage";
import type { WorkspaceService, GitService } from "@devmesh/workspace";
import type { ExecutionService } from "./executions/service.js";
import {
  buildSpecArtifact,
  buildPlanArtifact,
  buildTestReportArtifact,
  buildReviewArtifact,
  buildSpecArtifactFromPayload,
  buildPlanArtifactFromPayload,
  buildTestReportArtifactFromPayload,
  buildReviewArtifactFromPayload,
  ARTIFACT_OUTPUT_FORMATS,
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
  private _currentPipelineRunId: string | null = null;
  private _cancelled = false;
  /** Tracks terminal events emitted for the current run to prevent duplicates. */
  private _emittedTerminalEvents = new Set<string>();
  /** Whether git rollback has already been performed for the current run. */
  private _rollbackPerformed = false;

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

  /** Return the runId of the most recently started pipeline, or null. */
  get currentRunId(): string | null {
    return this._currentPipelineRunId;
  }

  /** Whether cancellation has been requested for the current pipeline run. */
  get isCancelled(): boolean {
    return this._cancelled;
  }

  /**
   * Request cancellation of the currently running pipeline.
   *
   * Safe to call multiple times (idempotent). Cancels the active execution
   * if one exists. The pipeline will transition to the terminal "cancelled"
   * state at the next stage boundary or after the active execution stops.
   */
  cancel(): void {
    if (this._cancelled) return;
    this._cancelled = true;
    const runId = this._currentPipelineRunId;
    if (!runId) return;
    const projectId = this._findProjectIdForRun(runId);
    if (!projectId) return;
    try {
      // ExecutionService enforces one active execution per project.
      const execs = this.storage.executions.listByProject(projectId);
      for (const exec of execs) {
        if (exec.status === "running") {
          // SAFETY: Fire-and-forget — the `_cancelled` flag already prevents further
          // stages from starting. Cancel failure is non-critical.
          void this.executionService.cancel(exec.id, "pipeline cancelled").catch(() => {});
          break;
        }
      }
    } catch (err) {
      // SAFETY: Non-critical side-effect — the `_cancelled` flag will still
      // prevent further stages from starting. Logging for observability but
      // not failing the pipeline.
      try {
        this.storage.events.append({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "error.raised",
          scope: "orchestrator/cancel-exec",
          message: `failed to cancel active execution: ${err instanceof Error ? err.message : String(err)}`,
          fatal: false,
        } as never);
      } catch {
        // SAFETY: If event persistence also fails after a cancel failure,
        // the pipeline cancellation flag is still set and no further stages
        // will start. Nothing more we can do.
      }
    }
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

    // --- Reset per-run state -----------------------------------------------
    this._emittedTerminalEvents.clear();
    this._rollbackPerformed = false;

    // --- Persist pipeline run identity ------------------------------------
    const pipelineRunId = runId;
    this._currentPipelineRunId = pipelineRunId;
    const pipelineRunCreatedAt = new Date().toISOString();
    try {
      this.storage.pipelineRuns.insert({
        id: pipelineRunId,
        projectId,
        status: "running",
        goal: userTask.slice(0, 8000),
        errorMessage: null,
        createdAt: pipelineRunCreatedAt,
        finishedAt: null,
        durationMs: null,
      });
    } catch (err) {
      // SAFETY: Non-critical side-effect — pipeline execution proceeds even
      // if persistence fails. The pipeline may not be queryable via API but
      // the agent work still happens.
      console.warn(
        "[orchestrator] failed to persist pipeline run start",
        { runId: pipelineRunId, error: err instanceof Error ? err.message : String(err) },
      );
    }

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

    // --- Insert initial stage rows (all pending) ---------------------------
    const stageRoles = ["architect", "developer", "tester", "reviewer"];
    const stageRows: StageRecord[] = stageRoles.map((role, idx) => ({
      id: crypto.randomUUID(),
      runId: pipelineRunId,
      projectId,
      stageIndex: idx,
      stageRole: role,
      status: "pending" as const,
      executionId: null,
      taskId: taskChain[idx]!.id,
      startedAt: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
    }));
    try {
      for (const sr of stageRows) {
        this.storage.stages.insert(sr);
      }
    } catch (err) {
      // SAFETY: Non-critical side-effect — stage persistence failure does not
      // block pipeline execution. The pipeline may not be queryable via API
      // but the agent work still happens.
      console.warn(
        "[orchestrator] failed to persist initial stage rows",
        { runId: pipelineRunId, error: err instanceof Error ? err.message : String(err) },
      );
    }

    // --- Pipeline execution loop ------------------------------------------

    let currentIdx = 0;
    let testerRevisions = 0;
    let reviewerRevisions = 0;
    let totalAttempts = 0;

    // Track artifact IDs for downstream reference
    let latestChangeSetId: ArtifactId | undefined;
    let latestTestReportId: ArtifactId | undefined;

    while (currentIdx < taskChain.length) {
      // --- Cancellation check at stage boundary ----------------------------
      if (this._cancelled) {
        this.cancelRemainingStages(stageRows);
        this.emitEvent({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.cancelled",
          reason: "pipeline cancelled",
        });
        return this.result("cancelled", taskChain[currentIdx]!.id, projectId, "pipeline cancelled");
      }

      const card = taskChain[currentIdx]!;
      const role = card.role;

      // Pipeline-level attempt budget check
      totalAttempts++;
      if (totalAttempts > this.maxTotalAttempts) {
        this.cancelRemainingStages(stageRows);
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
        this.cancelRemainingStages(stageRows);
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
          this.emitEvent({
            ts: new Date().toISOString(),
            runId,
            projectId,
            actor: "system",
            type: "run.started",
            goal: `git checkpoint created: ${cp.label}`,
          });
        } catch (err) {
          // SAFETY: Non-critical side-effect — checkpoint failure does not block
          // the pipeline. Git rollback on failure will be a no-op if no checkpoint
          // was created.
          console.warn(
            "[orchestrator] git checkpoint failed",
            { runId, error: err instanceof Error ? err.message : String(err) },
          );
        }
      }

      let rec: ExecutionRecord;

      // --- Update stage to "running" before execution ----------------------
      const currentStage = stageRows[currentIdx]!;
      try {
        currentStage.status = "running";
        currentStage.startedAt = new Date().toISOString();
        this.storage.stages.update(currentStage);
      } catch (err) {
        // SAFETY: Non-critical side-effect — stage persistence failure does not block execution.
        console.warn(
          "[orchestrator] failed to persist stage running",
          { runId, stageRole: role, error: err instanceof Error ? err.message : String(err) },
        );
      }

      try {
        rec = await this.executionService.start({
          projectId,
          instruction,
          taskId: card.id,
          agentId: role,
          ...(role === "architect" || role === "tester" || role === "reviewer"
            ? { outputFormat: ARTIFACT_OUTPUT_FORMATS[role] }
            : {}),
        });
      } catch (err) {
        this.finishStage(currentStage, "failed");
        this.cancelRemainingStages(stageRows);
        this.transitionTask(card, "failed");
        return this.result("failed", card.id, projectId,
          `failed to start ${role}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Wait for terminal state
      const terminal = await this.waitForTerminal(card.id, rec.id);

      // --- Cancellation check after execution completes --------------------
      if (this._cancelled) {
        this.finishStage(currentStage, "cancelled", rec.id);
        this.cancelRemainingStages(stageRows);
        this.emitEvent({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.cancelled",
          reason: "pipeline cancelled",
        });
        return this.result("cancelled", card.id, projectId, "pipeline cancelled");
      }

      const refreshed = this.storage.tasks.get(card.id as TaskId)!;

      if (refreshed.status === "in_review") {
        // Success — advance to next stage.  We intentionally leave the task
        // at "in_review" (not "done") so that revision logic can transition
        // it back to "revising → running" if a downstream agent fails.
        this.finishStage(currentStage, "completed", rec.id);
        currentIdx++;
        testerRevisions = 0;
        reviewerRevisions = 0;
        this.doomLoop.recordSuccess(role);

        // --- Produce structured artifacts from agent output ---------------
        // Prefer the agent's structured output (outputFormat) when valid;
        // otherwise fall back to parsing the free-text reply.
        const replyText = this.getTaskReplyText(card) ?? "";
        const produced = this.produceStageArtifacts(
          card,
          runId,
          projectId,
          role,
          replyText,
          latestChangeSetId,
          latestTestReportId,
        );
        if (produced.testReportId) latestTestReportId = produced.testReportId;

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
          // All stages are already marked completed via finishStage above
          this.emitEvent({
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
        this.finishStage(currentStage, "failed", rec.id);
        this.cancelRemainingStages(stageRows);
        this.emitEvent({
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
        this.finishStage(currentStage, "cancelled", rec.id);
        this.cancelRemainingStages(stageRows);
        this.emitEvent({
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
          this.finishStage(currentStage, "failed", rec.id);
          this.cancelRemainingStages(stageRows);
          this.transitionTask(testerTask, "blocked");
          this.emitEvent({
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
            this.finishStage(currentStage, "failed", rec.id);
            this.cancelRemainingStages(stageRows);
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
          this.finishStage(currentStage, "failed", rec.id);
          this.cancelRemainingStages(stageRows);
          this.transitionTask(reviewerTask, "blocked");
          this.emitEvent({
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
            this.finishStage(currentStage, "failed", rec.id);
            this.cancelRemainingStages(stageRows);
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
        this.finishStage(currentStage, "failed", rec.id);
        this.cancelRemainingStages(stageRows);
        this.transitionTask(developerTask, "blocked");
        this.emitEvent({
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
        this.finishStage(currentStage, "failed", rec.id);
        this.cancelRemainingStages(stageRows);
        this.transitionTask(architectTask, "blocked");
        this.emitEvent({
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
      this.finishStage(currentStage, "failed", rec.id);
      this.cancelRemainingStages(stageRows);
      this.emitEvent({
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

  /**
   * Resume a failed, cancelled, or timed-out pipeline from the last completed
   * stage.  Skips already-completed stages, creates new task cards for
   * remaining stages, and runs the orchestration loop for the tail of the
   * pipeline.
   */
  async resume(runId: string): Promise<PipelineResult> {
    // --- 1. Validate pipeline_runs.status ----------------------------------
    const pipelineRun = this.storage.pipelineRuns.get(runId as never);
    if (!pipelineRun) {
      throw new TerminalStateError({
        runId,
        currentStatus: "not-found",
        attemptedStatus: "running",
      });
    }
    const RESUMABLE: ReadonlySet<string> = new Set(["failed", "cancelled", "timeout"]);
    if (!RESUMABLE.has(pipelineRun.status)) {
      throw new TerminalStateError({
        runId,
        currentStatus: pipelineRun.status,
        attemptedStatus: "running",
      });
    }

    const projectId = pipelineRun.projectId as ProjectId;
    const handle = this.workspaces.get(projectId);

    // --- 2. Read stages and find last completed -----------------------------
    const stages = this.storage.stages.listByRun(runId);
    const lastCompleted = this.storage.stages.getLastCompleted(runId);
    const startIndex = lastCompleted ? lastCompleted.stageIndex + 1 : 0;

    if (startIndex >= stages.length) {
      // All stages already completed — nothing to resume.
      this.updateStatus("completed");
      return this.result("completed", "" as TaskId, projectId);
    }

    // --- 3. Classify stages ------------------------------------------------
    const STAGE_ROLES = ["architect", "developer", "tester", "reviewer"];
    const skippedIndices = new Set<number>();
    for (let i = 0; i < startIndex; i++) skippedIndices.add(i);

    // Look up original task cards for skipped stages (already persisted).
    const originalTasks: (TaskCard | null)[] = stages.map((s) => {
      const task = this.storage.tasks.get(s.taskId as TaskId);
      return task ?? null;
    });

    // Artifact IDs from completed stages (for downstream context assembly).
    let latestChangeSetId: ArtifactId | undefined;
    let latestTestReportId: ArtifactId | undefined;
    for (const idx of skippedIndices) {
      const task = originalTasks[idx];
      if (!task) continue;
      const role = STAGE_ROLES[idx];
      if (role === "developer") {
        const exec = this.getTaskExecution(task);
        if (exec?.resultArtifactId) latestChangeSetId = exec.resultArtifactId as ArtifactId;
      } else if (role === "tester") {
        const exec = this.getTaskExecution(task);
        if (exec?.resultArtifactId) latestTestReportId = exec.resultArtifactId as ArtifactId;
      }
    }

    // --- 4. Prepare orchestrator state for this run -------------------------
    this._userTask = pipelineRun.goal;
    this._currentPipelineRunId = runId;
    this._emittedTerminalEvents.clear();
    this._rollbackPerformed = false;
    this._cancelled = false;
    this.doomLoop.recordSuccess("architect");
    this.doomLoop.recordSuccess("developer");
    this.doomLoop.recordSuccess("tester");
    this.doomLoop.recordSuccess("reviewer");

    // --- 5. Transition skipped tasks to "done" (satisfies downstream deps) -
    for (const idx of skippedIndices) {
      const task = originalTasks[idx];
      if (task && canTransition(task.status, "done")) {
        this.transitionTask(task, "done");
      } else if (task) {
        console.warn(`[orchestrator/resume] cannot transition ${task.role} from ${task.status} to done`);
      }
    }

    // --- 6. Create new task cards for remaining stages ---------------------
    // Original dependency structure: architect=[], developer=[0], tester=[1], reviewer=[1,2]
    const STAGE_DEPS: readonly (readonly number[])[] = [[], [0], [1], [1, 2]];
    const newTasks: TaskCard[] = [];
    for (let idx = startIndex; idx < stages.length; idx++) {
      const role = STAGE_ROLES[idx] as TaskCard["role"];
      const depIds: TaskId[] = [];

      for (const depIdx of STAGE_DEPS[idx] ?? []) {
        if (depIdx < startIndex) {
          // Dependency was skipped — use original task (already transitioned to "done")
          if (originalTasks[depIdx]) depIds.push(originalTasks[depIdx]!.id as TaskId);
        } else {
          // Dependency is also being resumed — use the corresponding new task
          const newTaskIdx = depIdx - startIndex;
          if (newTasks[newTaskIdx]) depIds.push(newTasks[newTaskIdx]!.id as TaskId);
        }
      }

      const detail =
        role === "architect" ? pipelineRun.goal.slice(0, 4000)
        : role === "developer" ? "Implement the approved plan"
        : role === "tester" ? "Verify the implementation"
        : "Review the changes and test results";

      const title =
        role === "architect" ? "Architecture analysis"
        : role === "developer" ? "Implementation"
        : role === "tester" ? "Test verification"
        : "Code review";

      const card = this.createTask(runId as never, projectId, role, title, detail, depIds);
      newTasks.push(card);
    }

    // --- 7. Insert new stage rows for resumed stages -----------------------
    const newStageRows: StageRecord[] = [];
    for (let i = 0; i < newTasks.length; i++) {
      const idx = startIndex + i;
      const sr: StageRecord = {
        id: crypto.randomUUID(),
        runId,
        projectId,
        stageIndex: idx,
        stageRole: STAGE_ROLES[idx]!,
        status: "pending",
        executionId: null,
        taskId: newTasks[i]!.id,
        startedAt: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
      };
      try {
        this.storage.stages.insert(sr);
        newStageRows.push(sr);
      } catch (err) {
        console.warn(
          "[orchestrator] failed to persist resumed stage row",
          { stageId: sr.id, error: err instanceof Error ? err.message : String(err) },
        );
        newStageRows.push(sr);
      }
    }

    // Mark skipped stage rows as completed (they were already completed in
    // the original run — the rows should already have that status, but this
    // is defensive).
    for (const idx of skippedIndices) {
      const sr = stages[idx];
      if (sr && sr.status !== "completed") {
        try {
          sr.status = "completed";
          sr.completedAt = sr.completedAt ?? new Date().toISOString();
          this.storage.stages.update(sr);
        } catch { /* non-critical */ }
      }
    }

    // --- 8. Transition new tasks to "ready" --------------------------------
    for (const card of newTasks) {
      this.transitionTask(card, "ready");
    }

    // --- 9. Update pipeline_runs to running --------------------------------
    try {
      this.storage.pipelineRuns.update({
        ...pipelineRun,
        status: "running",
        errorMessage: null,
        finishedAt: null,
        durationMs: null,
      });
    } catch (err) {
      console.warn(
        "[orchestrator] failed to persist pipeline resume",
        { runId, error: err instanceof Error ? err.message : String(err) },
      );
    }

    // --- 10. Emit run.started with context entry ----------------------------
    this.emit({
      ts: new Date().toISOString(),
      runId,
      projectId,
      actor: "system",
      type: "run.started",
      goal: pipelineRun.goal.slice(0, 8000),
    });

    const resumeContext = makeContextEntry({
      namespace: "decision",
      key: "resumed_from",
      value: { runId, stageIndex: startIndex },
      createdBy: "system",
    });
    try {
      this.storage.context.put(resumeContext);
    } catch (err) {
      console.warn(
        "[orchestrator] failed to persist resume context entry",
        { runId, error: err instanceof Error ? err.message : String(err) },
      );
    }

    // --- 11. Execute remaining stages (loop over newStageRows) -------------
    const taskChain: TaskCard[] = newTasks;
    const stageRows: StageRecord[] = newStageRows;
    let currentIdx = 0;
    let testerRevisions = 0;
    let reviewerRevisions = 0;
    let totalAttempts = 0;

    while (currentIdx < taskChain.length) {
      if (this._cancelled) {
        this.cancelRemainingStages(stageRows);
        this.emitEvent({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.cancelled",
          reason: "pipeline cancelled",
        });
        return this.result("cancelled", taskChain[currentIdx]!.id, projectId, "pipeline cancelled");
      }

      const card = taskChain[currentIdx]!;
      const role = card.role;

      totalAttempts++;
      if (totalAttempts > this.maxTotalAttempts) {
        this.cancelRemainingStages(stageRows);
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
        return this.result("failed", card.id, projectId, "pipeline total attempt budget exhausted");
      }

      if (!this.areDependenciesSatisfied(card)) {
        this.cancelRemainingStages(stageRows);
        this.transitionTask(card, "blocked");
        return this.result("failed", card.id, projectId, `dependencies not satisfied for ${role}`);
      }

      this.transitionTask(card, "ready");
      const instruction = this.assembleInstruction(card, taskChain, handle.root);

      let rec: ExecutionRecord;

      const currentStage = stageRows[currentIdx]!;
      try {
        currentStage.status = "running";
        currentStage.startedAt = new Date().toISOString();
        this.storage.stages.update(currentStage);
      } catch (err) {
        console.warn(
          "[orchestrator] failed to persist stage running",
          { runId, stageRole: role, error: err instanceof Error ? err.message : String(err) },
        );
      }

      try {
        rec = await this.executionService.start({
          projectId,
          instruction,
          taskId: card.id,
          agentId: role,
          ...(role === "architect" || role === "tester" || role === "reviewer"
            ? { outputFormat: ARTIFACT_OUTPUT_FORMATS[role] }
            : {}),
        });
      } catch (err) {
        this.finishStage(currentStage, "failed");
        this.cancelRemainingStages(stageRows);
        this.transitionTask(card, "failed");
        return this.result("failed", card.id, projectId,
          `failed to start ${role}: ${err instanceof Error ? err.message : String(err)}`);
      }

      const terminal = await this.waitForTerminal(card.id, rec.id);

      if (this._cancelled) {
        this.finishStage(currentStage, "cancelled", rec.id);
        this.cancelRemainingStages(stageRows);
        this.emitEvent({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.cancelled",
          reason: "pipeline cancelled",
        });
        return this.result("cancelled", card.id, projectId, "pipeline cancelled");
      }

      const refreshed = this.storage.tasks.get(card.id as TaskId)!;

      if (refreshed.status === "in_review") {
        this.finishStage(currentStage, "completed", rec.id);
        currentIdx++;
        testerRevisions = 0;
        reviewerRevisions = 0;
        this.doomLoop.recordSuccess(role);

        const replyText = this.getTaskReplyText(card) ?? "";
        const produced = this.produceStageArtifacts(
          card,
          runId,
          projectId,
          role,
          replyText,
          latestChangeSetId,
          latestTestReportId,
        );
        if (produced.testReportId) latestTestReportId = produced.testReportId;

        if (role === "developer") {
          const execRec = this.getTaskExecution(card);
          if (execRec?.resultArtifactId) {
            latestChangeSetId = execRec.resultArtifactId as ArtifactId;
          }
        }

        if (role === "reviewer") {
          for (const t of taskChain) {
            this.transitionTask(t, "done");
          }
          this.emitEvent({
            ts: new Date().toISOString(),
            runId,
            projectId,
            actor: "system",
            type: "run.completed",
            summary: "pipeline completed successfully",
          });
          return this.result("completed", card.id, projectId);
        }
        continue;
      }

      // Failure/timeout path
      if (terminal === "timeout") {
        this.finishStage(currentStage, "failed", rec.id);
        this.cancelRemainingStages(stageRows);
        this.emitEvent({
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
        this.finishStage(currentStage, "cancelled", rec.id);
        this.cancelRemainingStages(stageRows);
        this.emitEvent({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.cancelled",
          reason: `${role} was cancelled`,
        });
        return this.result("cancelled", card.id, projectId, `${role} was cancelled`);
      }

      // --- Revision logic ---------------------------------------------------

      if (role === "tester" && refreshed.status === "failed") {
        testerRevisions++;
        if (testerRevisions > this.maxTesterRevisions) {
          this.finishStage(currentStage, "failed", rec.id);
          this.cancelRemainingStages(stageRows);
          this.transitionTask(card, "blocked");
          this.emitEvent({
            ts: new Date().toISOString(),
            runId,
            projectId,
            actor: "system",
            type: "run.failed",
            reason: "tester revision budget exhausted",
          });
          return this.result("failed", card.id, projectId, "tester revision budget exhausted");
        }
        const lastExec = this.getLatestTaskExecution(card);
        if (lastExec) {
          const sig = computeFailureSignature(lastExec);
          if (this.doomLoop.recordFailure("tester", sig)) {
            this.finishStage(currentStage, "failed", rec.id);
            this.cancelRemainingStages(stageRows);
            this.transitionTask(card, "blocked");
            this.emitEvent({
              ts: new Date().toISOString(),
              runId,
              projectId,
              actor: "system",
              type: "run.failed",
              reason: `tester doom-loop detected (identical failure ${this.doomLoop.getCount("tester")}×)`,
            });
            return this.result("failed", card.id, projectId, "tester doom-loop detected");
          }
        }
        // Retry developer
        const devIdx = taskChain.findIndex((c) => c.role === "developer");
        if (devIdx >= 0) {
          currentIdx = devIdx;
          this.finishStage(currentStage, "failed", rec.id);
          this.transitionTask(card, "revising");
          continue;
        }
        this.finishStage(currentStage, "failed", rec.id);
        this.cancelRemainingStages(stageRows);
        this.transitionTask(card, "blocked");
        this.emitEvent({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.failed",
          reason: "tester failed, no developer to retry",
        });
        return this.result("failed", card.id, projectId, "tester failed, no developer to retry");
      }

      if (role === "reviewer" && refreshed.status === "failed") {
        reviewerRevisions++;
        if (reviewerRevisions > this.maxReviewerRevisions) {
          this.finishStage(currentStage, "failed", rec.id);
          this.cancelRemainingStages(stageRows);
          this.transitionTask(card, "blocked");
          this.emitEvent({
            ts: new Date().toISOString(),
            runId,
            projectId,
            actor: "system",
            type: "run.failed",
            reason: "reviewer revision budget exhausted",
          });
          return this.result("failed", card.id, projectId, "reviewer revision budget exhausted");
        }
        const lastExec = this.getLatestTaskExecution(card);
        if (lastExec) {
          const sig = computeFailureSignature(lastExec);
          if (this.doomLoop.recordFailure("reviewer", sig)) {
            this.finishStage(currentStage, "failed", rec.id);
            this.cancelRemainingStages(stageRows);
            this.transitionTask(card, "blocked");
            this.emitEvent({
              ts: new Date().toISOString(),
              runId,
              projectId,
              actor: "system",
              type: "run.failed",
              reason: `reviewer doom-loop detected (identical failure ${this.doomLoop.getCount("reviewer")}×)`,
            });
            return this.result("failed", card.id, projectId, "reviewer doom-loop detected");
          }
        }
        const devIdx = taskChain.findIndex((c) => c.role === "developer");
        if (devIdx >= 0) {
          currentIdx = devIdx;
          this.finishStage(currentStage, "failed", rec.id);
          this.transitionTask(card, "revising");
          continue;
        }
        this.finishStage(currentStage, "failed", rec.id);
        this.cancelRemainingStages(stageRows);
        this.transitionTask(card, "blocked");
        this.emitEvent({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.failed",
          reason: "reviewer failed, no developer to retry",
        });
        return this.result("failed", card.id, projectId, "reviewer failed, no developer to retry");
      }

      if (role === "developer" && refreshed.status === "failed") {
        this.finishStage(currentStage, "failed", rec.id);
        this.cancelRemainingStages(stageRows);
        this.transitionTask(card, "blocked");
        this.emitEvent({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.failed",
          reason: "developer failed",
        });
        return this.result("failed", card.id, projectId, "developer failed");
      }

      if (role === "architect" && refreshed.status === "failed") {
        this.finishStage(currentStage, "failed", rec.id);
        this.cancelRemainingStages(stageRows);
        this.transitionTask(card, "blocked");
        this.emitEvent({
          ts: new Date().toISOString(),
          runId,
          projectId,
          actor: "system",
          type: "run.failed",
          reason: "architect failed",
        });
        return this.result("failed", card.id, projectId, "architect failed");
      }

      // Unknown terminal status — fail the pipeline
      this.finishStage(currentStage, "failed", rec.id);
      this.cancelRemainingStages(stageRows);
      this.transitionTask(card, "failed");
      this.emitEvent({
        ts: new Date().toISOString(),
        runId,
        projectId,
        actor: "system",
        type: "run.failed",
        reason: `agent ${role} ended in unexpected status: ${refreshed.status}`,
      });
      return this.result("failed", card.id, projectId,
        `agent ${role} ended in unexpected status: ${refreshed.status}`);
    }

    // Should not reach here
    return this.result("failed", taskChain[taskChain.length - 1]!.id, projectId,
      "pipeline fell through");
  }

  // --- Internal helpers ---------------------------------------------------

  /** Look up the projectId for a given runId from the pipeline_runs table. */
  private _findProjectIdForRun(runId: string): ProjectId | null {
    const rec = this.storage.pipelineRuns.get(runId);
    return rec ? (rec.projectId as ProjectId) : null;
  }

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

  /** Read the agent's structured output (outputFormat) from the execution record. */
  private getTaskStructured(task: TaskCard): unknown {
    const recs = this.storage.executions.listByProject(task.projectId);
    for (const rec of recs) {
      if (
        rec.taskId === task.id &&
        rec.status === "completed" &&
        rec.structured !== null &&
        rec.structured !== undefined
      ) {
        return rec.structured;
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
      // Check cancellation — don't wait for the execution to finish naturally
      if (this._cancelled) return "cancelled";
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
    // Attempt rollback on fatal failures if git is available (idempotent).
    if ((status === "failed" || status === "cancelled" || status === "timeout") && this.git && !this._rollbackPerformed) {
      this._rollbackPerformed = true;
      try {
        const handle = this.workspaces.get(projectId);
        const checkpoints = this.git.listCheckpoints(handle.root);
        if (checkpoints.length > 0) {
          // Clean untracked/modified files before rollback so the workspace is clean
          this.git.run(handle.root, ["checkout", "--", "."]);
          this.git.run(handle.root, ["clean", "-fd"]);
          this.git.rollbackTo(handle.root, checkpoints[0]!.sha);
        }
      } catch (err) {
        // SAFETY: Non-critical side-effect — git rollback failure does not affect
        // the pipeline status. The workspace may be dirty but the pipeline result
        // is what matters.
        console.warn(
          "[orchestrator] git rollback failed",
          { runId: this._currentPipelineRunId, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    // --- Update pipeline run persistence (centralized choke-point) -----------
    try {
      this.updateStatus(status, errorMessage);
    } catch (err) {
      // SAFETY: TerminalStateError means the pipeline is already in a terminal
      // state (race between cancel and completion). This is expected and
      // idempotent — the first writer wins.
      if (!(err instanceof TerminalStateError)) {
        throw err;
      }
    }

    return { status, taskId, projectId, errorMessage };
  }

  /**
   * Single choke-point for pipeline_runs.status writes. Performs a read-then-
   * write with an optimistic check: if the current status is already terminal,
   * the update is rejected with a TerminalStateError. Terminal event emission
   * is deduplicated per (runId, eventType).
   */
  private updateStatus(status: PipelineStatus, errorMessage?: string): void {
    const runId = this._currentPipelineRunId;
    if (!runId) return;

    const existing = this.storage.pipelineRuns.get(runId);
    if (!existing) return;

    // If already terminal, reject the update — no overwrite.
    const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "timeout"]);
    if (TERMINAL.has(existing.status)) {
      throw new TerminalStateError({
        runId,
        currentStatus: existing.status,
        attemptedStatus: status,
      });
    }

    const now = new Date().toISOString();
    const finishedAt = now;
    const durationMs = new Date(now).getTime() - new Date(existing.createdAt).getTime();
    try {
      this.storage.pipelineRuns.update({
        ...existing,
        status,
        errorMessage: errorMessage ?? existing.errorMessage,
        finishedAt,
        durationMs,
      });
    } catch (err) {
      // SAFETY: Non-critical side-effect — the in-memory pipeline state is
      // authoritative; persistence failure is logged but does not crash.
      console.warn(
        "[orchestrator] failed to persist pipeline status update",
        { runId, status, error: err instanceof Error ? err.message : String(err) },
      );
    }
    this._currentPipelineRunId = null;
  }

  private emit(event: Record<string, unknown>): void {
    try {
      this.storage.events.append(event as never);
    } catch (err) {
      // SAFETY: Non-critical side-effect — event persistence is best-effort.
      // Observability via console.warn but not fatal to the pipeline.
      console.warn(
        "[orchestrator] event persistence failed",
        { type: event.type, error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  /**
   * Emit an event with deduplication for terminal events. A second
   * `run.completed`, `run.failed`, or `run.cancelled` for the same runId
   * is suppressed (no-op) to prevent duplicate terminal events on the SSE
   * stream.
   */
  private emitEvent(event: Record<string, unknown>): void {
    const isTerminal =
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled";
    if (isTerminal) {
      const runId = String(event.runId ?? "");
      const key = `${runId}:${event.type}`;
      if (this._emittedTerminalEvents.has(key)) {
        return; // deduplicate
      }
      this._emittedTerminalEvents.add(key);
    }
    this.emit(event);
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

  /**
   * Produce and persist the structured artifacts for a completed stage.
   * Prefers the agent's structured output (validated against the artifact
   * schema); falls back to text-parsing (artifact-builder.ts) when structured
   * output is absent or fails validation. Returns the test_report artifact id
   * when a tester stage produced one (for downstream review context).
   */
  private produceStageArtifacts(
    card: TaskCard,
    runId: string,
    projectId: ProjectId,
    role: AgentRole,
    replyText: string,
    latestChangeSetId?: ArtifactId,
    latestTestReportId?: ArtifactId,
  ): { testReportId?: ArtifactId } {
    const actx = {
      runId: runId as never,
      projectId,
      taskId: card.id as TaskId,
      producedBy: role,
    };
    const structured = this.getTaskStructured(card);
    const structuredRecord =
      typeof structured === "object" && structured !== null
        ? (structured as Record<string, unknown>)
        : null;
    const toInsert: Artifact[] = [];
    // Build each artifact defensively: a failure to build one artifact (from
    // structured or from free text) is logged and skipped, never fatal.
    const build = (fn: () => Artifact): void => {
      try {
        toInsert.push(fn());
      } catch (err) {
        // SAFETY: Non-critical side-effect — a single artifact build failure
        // does not block the pipeline. The agent reply text / structured
        // output is still available via the execution record.
        console.warn(
          "[orchestrator] artifact build skipped",
          { runId, role, error: err instanceof Error ? err.message : String(err) },
        );
      }
    };

    if (role === "architect" && (replyText || structuredRecord)) {
      let specBuilt = false;
      let planBuilt = false;
      if (structuredRecord) {
        if ("spec" in structuredRecord) {
          build(() => {
            const a = buildSpecArtifactFromPayload(structuredRecord.spec, actx);
            specBuilt = true;
            return a;
          });
        }
        if ("plan" in structuredRecord) {
          build(() => {
            const a = buildPlanArtifactFromPayload(structuredRecord.plan, actx);
            planBuilt = true;
            return a;
          });
        }
      }
      if (!specBuilt && replyText) build(() => buildSpecArtifact(replyText, actx));
      if (!planBuilt && replyText) build(() => buildPlanArtifact(replyText, actx));
    } else if (role === "tester") {
      let built = false;
      if (structuredRecord) {
        build(() => {
          const a = buildTestReportArtifactFromPayload(structuredRecord, actx);
          built = true;
          return a;
        });
      }
      if (!built) build(() => buildTestReportArtifact(replyText || "Tests completed successfully.", actx));
    } else if (role === "reviewer" && (replyText || structuredRecord)) {
      let built = false;
      if (structuredRecord) {
        build(() => {
          const a = buildReviewArtifactFromPayload(structuredRecord, actx);
          built = true;
          return a;
        });
      }
      if (!built && replyText) {
        build(() =>
          buildReviewArtifact(
            replyText,
            latestChangeSetId ?? ("" as ArtifactId),
            latestTestReportId,
            actx,
          ),
        );
      }
    }

    for (const a of toInsert) {
      try {
        this.storage.artifacts.insert(a);
        this.emitArtifact(a, role);
      } catch (err) {
        // SAFETY: Non-critical side-effect — artifact creation failure does not
        // block the pipeline. The agent reply text is still available via the
        // execution record for downstream context assembly.
        console.warn(
          "[orchestrator] artifact creation failed",
          { runId, role, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    const tr = toInsert.find((a) => a.kind === "test_report");
    return tr ? { testReportId: tr.id } : {};
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

    // Attempt to roll back workspace to last checkpoint (idempotent).
    if (this.git) {
      try {
        const handle = this.workspaces.get(projectId);
        const checkpoints = this.git.listCheckpoints(handle.root);
        if (checkpoints.length > 0) {
          this.git.run(handle.root, ["checkout", "--", "."]);
          this.git.run(handle.root, ["clean", "-fd"]);
          this.git.rollbackTo(handle.root, checkpoints[0]!.sha);
        }
      } catch (err) {
        // SAFETY: Non-critical side-effect — rollback failure during recovery
        // does not prevent interrupted executions from being marked. The workspace
        // may be dirty but the pipeline state is correct.
        console.warn(
          "[orchestrator] recovery rollback failed",
          { projectId, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    return projectUnfinished.length;
  }

  // --- Stage persistence helpers -------------------------------------------

  /**
   * Update a stage row to a terminal status with execution_id and completed_at.
   * Non-critical side-effect — failures are logged but do not crash.
   */
  private finishStage(
    stage: StageRecord,
    status: StageRecord["status"],
    executionId?: string,
  ): void {
    try {
      stage.status = status;
      stage.executionId = executionId ?? stage.executionId;
      stage.completedAt = new Date().toISOString();
      this.storage.stages.update(stage);
    } catch (err) {
      console.warn(
        "[orchestrator] failed to persist stage completion",
        { stageId: stage.id, status, error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  /**
   * Cancel all stage rows that are still pending or running (non-terminal).
   * Called when the pipeline reaches a terminal state before all stages complete.
   */
  private cancelRemainingStages(stages: StageRecord[], executionId?: string): void {
    const now = new Date().toISOString();
    for (const s of stages) {
      if (s.status === "completed" || s.status === "failed" || s.status === "cancelled") continue;
      try {
        s.status = "cancelled";
        s.executionId = executionId ?? s.executionId;
        s.completedAt = now;
        this.storage.stages.update(s);
      } catch (err) {
        console.warn(
          "[orchestrator] failed to persist stage cancellation",
          { stageId: s.id, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }
}
