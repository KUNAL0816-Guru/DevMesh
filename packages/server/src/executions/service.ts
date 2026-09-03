import {
  canTransition,
  newRunId,
  taskCardSchema,
  tokenUsageSchema,
  type AgentRole,
  type ArtifactProducer,
  type PricingRule,
  type ProjectId,
  type TaskId,
} from "@devmesh/contracts";
import type { Storage, ExecutionRecord, ExecutionUsage } from "@devmesh/storage";
import { WorkspaceError, type WorkspaceService, type GitService } from "@devmesh/workspace";
import {
  RuntimeError,
  type AgentRuntime,
  type RunningExecution,
} from "@devmesh/runtime";
import { AgentRegistryError, type AgentRegistry } from "@devmesh/agents";
import {
  summarizeTaskCommittedUsage,
  aggregateCommittedRunUsage,
} from "@devmesh/storage";
import {
  BudgetError,
  BudgetLedger,
  evaluateBudget,
  scopeKeyFor,
  type BudgetConfig,
  type BudgetProfile,
  type BudgetScopeKind,
} from "./budget.js";
import { usageWithDerivedCost, type PriceTable } from "./pricing.js";
import { buildVerificationArtifacts, observeChanges } from "./verify.js";
import { classifyResult, classifyStartError } from "./classify.js";
import { runVerificationCommand } from "./commands.js";

export interface StartExecutionInput {
  projectId: ProjectId;
  instruction: string;
  taskId?: TaskId;
  /** Agent definition id (default: the executable developer agent). */
  agentId?: string;
  /** Per-request model override (rarely needed; config default wins usually). */
  model?: string;
  /**
   * Operator-supplied command DevMesh replays itself after a successful run
   * (never model-supplied); recorded as a command_replay verification check.
   */
  verificationCommand?: string;
  /**
   * Ask the agent to produce structured JSON for this execution. When set,
   * it is forwarded to the runtime and the parsed result is stored on the
   * execution record's `structured` field.
   */
  outputFormat?: {
    name: string;
    schema: Record<string, unknown>;
  };
}

export interface ExecutionServiceOptions {
  storage: Storage;
  workspaces: WorkspaceService;
  git: GitService;
  /** Runtime-neutral port; null disables execution endpoints. */
  runtime: AgentRuntime | null;
  /** Registry of agent definitions — behavior lives there, not here. */
  agents: AgentRegistry;
  /** Global wall-clock budget; effective timeout = min(agent, this). */
  defaultTimeoutMs?: number;
  /**
   * Provider/model from CONFIGURATION (e.g. "anthropic/claude-...").
   * Precedence: request.model > this > agent definition hint.
   */
  defaultModel?: string;
  /** Optional per-scope budget configuration (Phase 8C). Absent = pre-8C. */
  budget?: BudgetConfig | null;
  /** Optional pricing table for derived cost. Absent = cost stays null. */
  pricing?: PriceTable | null;
  /** In-process reservation ledger; defaults to a fresh instance. */
  ledger?: BudgetLedger;
}

/** A scope a start must clear (task executions clear run AND task scopes). */
export interface BudgetScope {
  kind: BudgetScopeKind;
  id: string;
  profile: BudgetProfile;
}

/** Reservation created for a cleared scope, released on every terminal path. */
export interface Reservation {
  kind: BudgetScopeKind;
  id: string;
  tokens: number;
}

/** Empty committed aggregate (8B semantics: empty scope = truthful zeros). */
const EMPTY_USAGE: ExecutionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costUsdMicros: 0,
  currency: null,
  usageSource: null,
};

const EMPTY_SUMMARY = {
  totals: EMPTY_USAGE,
  unknownExecutionCount: 0,
};

/**
 * Restart reconciliation entry point used by the composition root: any
 * execution still marked pending/running was orphaned by a dead process
 * and is now marked `interrupted` (one error.raised event per row).
 */
export function reconcileInterrupted(storage: Storage): number {
  const rows = storage.executions.reconcileInterrupted(new Date().toISOString());
  for (const rec of rows) {
    storage.events.append({
      ts: new Date().toISOString(),
      runId: rec.runId,
      projectId: rec.projectId,
      actor: "system",
      type: "error.raised",
      scope: "execution/interrupted",
      message: `execution ${rec.id} was interrupted by a DevMesh restart`,
      fatal: false,
    } as never);
  }
  return rows.length;
}

const STOPPED_REASON: Record<string, "end_turn" | "aborted" | "error" | "budget_exceeded"> = {
  completed: "end_turn",
  cancelled: "aborted",
  failed: "error",
  timeout: "budget_exceeded",
};

/**
 * Validate runtime-reported usage at the persistence boundary. Returns the
 * stored shape with tokens only: cost is derived later from config pricing
 * (Phase 8C), so cost fields stay NULL — "tokens only, no cost yet" is
 * recorded as usage_source NULL. Invalid/malformed usage is dropped, never
 * persisted as fabricated zeros.
 */
function persistedUsage(usage: unknown): ExecutionUsage | null {
  const parsed = tokenUsageSchema.safeParse(usage);
  if (!parsed.success) return null;
  return {
    inputTokens: parsed.data.inputTokens,
    outputTokens: parsed.data.outputTokens,
    costUsdMicros: null,
    currency: null,
    usageSource: null,
  };
}

/**
 * Core-side orchestration of a single agent execution. Owns the lifecycle
 * (persist → resolve agent → start runtime → observe → verify → persist),
 * is fully runtime-neutral, and gets ALL agent behavior from the registry.
 */
export class ExecutionService {
  private readonly active = new Map<string, RunningExecution>();
  private readonly ledger: BudgetLedger;
  private readonly priceTable: PriceTable | null;

  constructor(private readonly opts: ExecutionServiceOptions) {
    this.ledger = opts.ledger ?? new BudgetLedger();
    this.priceTable = opts.pricing ?? null;
  }

  hasActive(projectId: string): boolean {
    return this.active.has(projectId);
  }

  get configured(): boolean {
    return this.opts.runtime !== null;
  }

  /**
   * Whether an agent (by id/role) is registered and executable. Non-throwing
   * gate used by the orchestrator to decide whether a plan role may run;
   * `requireExecutable` (via `start`) remains the final execution authority.
   */
  isAgentExecutable(agentId: string): boolean {
    const def = this.opts.agents.get(agentId);
    if (!def) return false;
    return def.executable && def.runtime !== "none";
  }

  async start(input: StartExecutionInput): Promise<ExecutionRecord> {
    const runtime = this.opts.runtime;
    if (!runtime) {
      throw new RuntimeError("runtime/not-configured", "no agent runtime is wired up");
    }
    if (this.active.has(input.projectId)) {
      throw new WorkspaceError(
        "workspace/locked",
        `project ${input.projectId} already has a running execution`,
      );
    }
    // -- agent resolution (registry-driven; nothing hard-coded here) --------
    let def;
    try {
      def = this.opts.agents.requireExecutable(input.agentId ?? "developer");
    } catch (err) {
      if (err instanceof AgentRegistryError && err.code === "agent/unknown") {
        throw new RuntimeError("runtime/invalid-request", err.message);
      }
      throw err;
    }
    const runtimeCompatible =
      runtime.name === def.runtime ||
      (runtime.supportsAgent?.(def.runtime) ?? false);
    if (!runtimeCompatible) {
      throw new RuntimeError(
        "runtime/not-configured",
        `agent '${def.id}' requires runtime '${def.runtime}' but '${runtime.name}' is wired`,
      );
    }

    // -- attempt budget -----------------------------------------------------
    const handle = this.opts.workspaces.get(input.projectId);
    const card = input.taskId ? this.opts.storage.tasks.get(input.taskId) : null;
    if (card) {
      if (card.projectId !== handle.projectId) {
        throw new RuntimeError("runtime/invalid-request", "task belongs to another project");
      }
      const effectiveMax = Math.min(card.maxAttempts, def.maxAttempts);
      if (card.attempts >= effectiveMax) {
        throw new WorkspaceError(
          "task/exhausted",
          `task ${card.id} exhausted its ${effectiveMax} attempt(s)`,
        );
      }
    }

    // -- cost/token budget gate (Phase 8C) ---------------------------------
    // Authoritative for every execution path: direct/API executions and both
    // orchestrator schedulers land here. Throws BudgetError (HTTP 409
    // budget/exhausted) before anything is persisted or started.
    const runId = newRunId();
    const scopes = this.resolveBudgetScopes(card, runId);
    this.evaluateBudgetGate(scopes, runId, handle.projectId);
    const reservation = this.reservationsFor(scopes);

    this.opts.git.init(handle.root);
    const timeoutMs = Math.min(def.timeoutMs, this.opts.defaultTimeoutMs ?? def.timeoutMs);
    const model = input.model ?? this.opts.defaultModel ?? def.model;
    const priceRule = this.priceTable?.lookup(model) ?? null;

    // The ONLY composition point for agent behavior: system instructions
    // come from the registry definition, task text stays verbatim.
    const fullInstruction = `${def.systemInstructions}\n\n# Task\n\n${input.instruction}`;

    const rec = this.opts.storage.executions.insert({
      runId,
      projectId: handle.projectId,
      taskId: input.taskId ?? null,
      agentId: def.id,
      role: def.role,
      runtime: runtime.name,
      status: "running",
      failureKind: null,
      instruction: input.instruction,
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

    // Optional TaskCard integration: ready -> running.
    this.tryStartTaskCard(rec);

    this.emit({
      ts: rec.startedAt,
      runId,
      projectId: handle.projectId,
      actor: "system",
      type: "agent.session.opened",
      role: def.role,
      sessionId: rec.id,
    });

    // Reserve budget capacity BEFORE starting the runtime; the reservation is
    // released on every terminal path (finalize / runtime failure / internal
    // error) so an in-flight execution never leaks its token reservation.
    for (const r of reservation) this.ledger.reserve(r.kind, r.id, r.tokens);

    let running: RunningExecution;
    try {
      running = runtime.start({
        executionId: rec.id,
        projectId: handle.projectId,
        workspaceRoot: handle.root, // approved realpath only — never model output
        instruction: fullInstruction,
        timeoutMs,
        model,
        ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
      });
    } catch (err) {
      this.finalizeRuntimeFailure(rec, err, reservation);
      throw err instanceof RuntimeError ? err : new RuntimeError("runtime/unavailable", String(err));
    }
    this.active.set(handle.projectId, running);

    void running.result
      .then((result) => this.finalize(rec, handle.root, result, input.verificationCommand, reservation, priceRule))
      .catch((err: unknown) => this.finalizeRuntimeFailure(rec, err, reservation))
      .finally(() => {
        this.active.delete(handle.projectId);
      });

    return rec;
  }

  async cancel(executionId: string, reason?: string): Promise<ExecutionRecord> {
    const rec = this.opts.storage.executions.get(executionId);
    if (!rec) {
      throw new WorkspaceError("workspace/not-found", `no execution ${executionId}`);
    }
    const running = [...this.active.values()].find((r) => r.executionId === executionId);
    if (!running) {
      throw new WorkspaceError(
        "workspace/locked",
        `execution ${executionId} is not active (status: ${rec.status})`,
      );
    }
    await running.cancel(reason ?? "cancelled via API");
    return this.opts.storage.executions.get(executionId) ?? rec;
  }

  get(executionId: string): ExecutionRecord {
    const rec = this.opts.storage.executions.get(executionId);
    if (!rec) {
      throw new WorkspaceError("workspace/not-found", `no execution ${executionId}`);
    }
    return rec;
  }

  listByProject(projectId: string): ExecutionRecord[] {
    return this.opts.storage.executions.listByProject(projectId);
  }

  // -- internals -------------------------------------------------------------

  private tryStartTaskCard(rec: ExecutionRecord): boolean {
    if (!rec.taskId) return false;
    const card = this.opts.storage.tasks.get(rec.taskId as never);
    if (!card || card.projectId !== rec.projectId) return false;
    if (!canTransition(card.status, "running")) return false;
    const updated = taskCardSchema.parse({
      ...card,
      status: "running",
      attempts: card.attempts + 1,
      updatedAt: new Date().toISOString(),
    });
    this.opts.storage.tasks.update(updated);
    this.emit({
      ts: new Date().toISOString(),
      runId: rec.runId,
      projectId: rec.projectId,
      actor: "system",
      type: "task.transitioned",
      taskId: updated.id,
      from: card.status,
      to: "running",
    });
    return true;
  }

  private tryFinishTaskCard(rec: ExecutionRecord, outcome: "in_review" | "failed"): void {
    if (!rec.taskId) return;
    const card = this.opts.storage.tasks.get(rec.taskId as never);
    if (!card || !canTransition(card.status, outcome)) return;
    const updated = taskCardSchema.parse({
      ...card,
      status: outcome,
      updatedAt: new Date().toISOString(),
    });
    this.opts.storage.tasks.update(updated);
    this.emit({
      ts: new Date().toISOString(),
      runId: rec.runId,
      projectId: rec.projectId,
      actor: "system",
      type: "task.transitioned",
      taskId: updated.id,
      from: card.status,
      to: outcome,
    });
  }

  private async finalize(
    rec: ExecutionRecord,
    workspaceRoot: string,
    result: Awaited<RunningExecution["result"]>,
    verificationCommand?: string,
    reservation: Reservation[] = [],
    priceRule: PricingRule | null = null,
  ): Promise<void> {
    try {
      const finishedAt = new Date().toISOString();
      let failureKind = classifyResult(result);

      // Ground-truth capture + verification against the real workspace.
      let changeSetId: string | null = null;
      let verificationId: string | null = null;
      if (result.status === "completed") {
        const status = this.opts.git.status(workspaceRoot);
        const observed = observeChanges(workspaceRoot, status);

        // Invalid-output rule: the runtime claims success but produced no
        // session, no reply text and no workspace change.
        if (
          failureKind === null &&
          !result.sessionId &&
          observed.filesChanged.length === 0 &&
          result.finalText.trim() === ""
        ) {
          failureKind = "invalid_output";
        }

        if (failureKind === null || failureKind === "invalid_output") {
          // Independent replay of an operator-specified verification command.
          const extraChecks: Array<Record<string, unknown>> = [];
          if (verificationCommand && observed.filesChanged.length > 0) {
            const replay = await runVerificationCommand(workspaceRoot, verificationCommand);
            extraChecks.push({
              kind: "command_replay",
              command: replay.command,
              exitCode: replay.exitCode,
              passed: replay.passed,
              detail: replay.detail.slice(0, 2000),
            });
          }
          const built = buildVerificationArtifacts({
            root: workspaceRoot,
            observed,
            ctx: { runId: rec.runId, projectId: rec.projectId, taskId: rec.taskId ?? undefined },
            producedBy: rec.role as ArtifactProducer,
            extraChecks,
          });
          for (const artifact of [built.changeSet, built.verification]) {
            if (!artifact) continue;
            this.opts.storage.artifacts.insert(artifact);
            this.emit({
              ts: finishedAt,
              runId: rec.runId,
              projectId: rec.projectId,
              actor: "system",
              type: "artifact.recorded",
              artifactId: artifact.id,
              kind: artifact.kind,
              producedBy: artifact.kind === "verification" ? "system" : rec.role as never,
            });
          }
          changeSetId = built.changeSet?.id ?? null;
          verificationId = built.verification?.id ?? null;
          if (built.verification && built.failingChecks > 0) {
            this.emit({
              ts: finishedAt,
              runId: rec.runId,
              projectId: rec.projectId,
              actor: "system",
              type: "verification.failed",
              artifactId: built.verification.id,
              failingChecks: built.failingChecks,
            });
            // Claims rejected by DevMesh's own verification.
            failureKind = "verification_failed";
          }
        }
      }

      const current =
        this.opts.storage.executions.get(rec.id) ??
        ({ ...rec } as ExecutionRecord);
      const terminalFailure = failureKind ?? null;
      const storedUsage = usageWithDerivedCost(persistedUsage(result.usage), priceRule);
      this.opts.storage.executions.update({
        ...current,
        // invalid_output / verification_failed downgrade task-level success
        status:
          terminalFailure === "invalid_output" || terminalFailure === "verification_failed"
            ? "failed"
            : result.status === "failed"
              ? "failed"
              : result.status === "timeout"
                ? "timeout"
                : result.status === "cancelled"
                  ? "cancelled"
                  : "completed",
        failureKind: terminalFailure,
        sessionRef: result.sessionId ?? current.sessionRef,
        exitCode: result.exitCode,
        stoppedReason: STOPPED_REASON[result.status] ?? "error",
        errorMessage:
          terminalFailure === "invalid_output"
            ? "invalid output: no session id, no reply text, no workspace change"
            : terminalFailure === "verification_failed"
              ? "verification failed: DevMesh rejected the claimed changes"
              : result.failureReason ?? null,
        stderrTail: result.stderrTail.slice(0, 16_000) || null,
        replyText: result.finalText.slice(0, 16_000) || null,
        finishedAt,
        durationMs: result.durationMs,
        resultArtifactId: changeSetId,
        verificationArtifactId: verificationId,
        structured: result.structured ?? null,
        usage: storedUsage,
      });

      this.emit({
        ts: finishedAt,
        runId: rec.runId,
        projectId: rec.projectId,
        actor: "system",
        type: "agent.reply.completed",
        role: rec.role as AgentRole,
        sessionId: result.sessionId ?? rec.id,
        durationMs: result.durationMs,
        stoppedReason: STOPPED_REASON[result.status] ?? "error",
      });

      const taskOutcome =
        terminalFailure === "verification_failed" ||
        terminalFailure === "invalid_output" ||
        result.status === "failed" ||
        result.status === "timeout"
          ? "failed"
          : result.status === "completed"
            ? "in_review"
            : null;
      if (taskOutcome) this.tryFinishTaskCard(rec, taskOutcome);

      // Post-completion reconciliation: release reservations, recompute the
      // committed scopes, and surface any budget concern (warn or overshoot)
      // as an error.raised observability event.
      this.reconcileBudget(rec, reservation);
    } catch (err) {
      this.finalizeInternalError(rec, err, reservation);
    }
  }

  private finalizeRuntimeFailure(
    rec: ExecutionRecord,
    err: unknown,
    reservation: Reservation[] = [],
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    const kind = classifyStartError(err);
    try {
      const current =
        this.opts.storage.executions.get(rec.id) ?? ({ ...rec } as ExecutionRecord);
      this.opts.storage.executions.update({
        ...current,
        status: "failed",
        failureKind: kind,
        finishedAt: new Date().toISOString(),
        errorMessage: message.slice(0, 2000),
        stoppedReason: "error",
      });
    } catch {
      // SAFETY: Persistence of the failure itself failed — the execution is
      // already in a terminal failure state. Nothing more we can do.
    }
    this.emit({
      ts: new Date().toISOString(),
      runId: rec.runId,
      projectId: rec.projectId,
      actor: "system",
      type: "error.raised",
      scope: "runtime",
      message: message.slice(0, 2000),
      fatal: false,
    });
    // The execution never ran: its reservation is released immediately.
    this.releaseReservations(reservation);
  }

  private finalizeInternalError(
    rec: ExecutionRecord,
    err: unknown,
    reservation: Reservation[] = [],
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const current =
        this.opts.storage.executions.get(rec.id) ?? ({ ...rec } as ExecutionRecord);
      this.opts.storage.executions.update({
        ...current,
        status: "failed",
        failureKind: "internal",
        finishedAt: new Date().toISOString(),
        errorMessage: `internal: ${message}`.slice(0, 2000),
        stoppedReason: "error",
      });
    } catch {
      // SAFETY: Persistence of the internal error state failed — the error
      // event will still be emitted below for observability.
    }
    this.emit({
      ts: new Date().toISOString(),
      runId: rec.runId,
      projectId: rec.projectId,
      actor: "system",
      type: "error.raised",
      scope: "executions/finalize",
      message: message.slice(0, 2000),
      fatal: false,
    });
    // SAFETY on reservation release even when persistence failed above.
    this.releaseReservations(reservation);
  }

  // -- budget helpers (Phase 8C) ------------------------------------------

  /**
   * Resolve the scopes a start must clear. Task executions land in BOTH the
   * task scope and the pipeline-run scope; a direct/API execution lands in
   * its own transient execution-run scope. No budget configured => empty.
   */
  private resolveBudgetScopes(
    card: { id: string; runId: string } | null,
    runId: string,
  ): BudgetScope[] {
    const cfg = this.opts.budget;
    if (!cfg) return [];
    const scopes: BudgetScope[] = [];
    if (card && cfg.task) {
      scopes.push({ kind: "task" as const, id: card.id, profile: cfg.task });
    }
    if (cfg.run) {
      scopes.push({
        kind: "run" as const,
        id: card ? (card.runId as string) : runId,
        profile: cfg.run,
      });
    }
    return scopes;
  }

  /**
   * Pure decision step of the gate. Throws BudgetError (block) or emits a
   * warning event (warn) for every scope that would be violated.
   */
  private evaluateBudgetGate(scopes: BudgetScope[], runId: string, projectId: string): void {
    const warnings: Array<{ scopeKey: string; detail: string }> = [];
    for (const scope of scopes) {
      const { totals, unknownExecutionCount } =
        scope.kind === "run"
          ? aggregateCommittedRunUsage(this.opts.storage.db, scope.id)
          : summarizeTaskCommittedUsage(this.opts.storage.db, scope.id) ?? EMPTY_SUMMARY;
      const decision = evaluateBudget({
        profile: scope.profile,
        totals,
        unknownExecutionCount,
        reservedTokens: this.ledger.reservedTokens(scope.kind, scope.id),
        additionalTokens: scope.profile.reservationTokens ?? 0,
      });
      if (decision.outcome === "reject") {
        throw new BudgetError(
          `${scopeKeyFor(scope.kind, scope.id)}: ${decision.detail}`,
          scope.kind,
          scope.id,
        );
      }
      if (decision.outcome === "warn") {
        warnings.push({ scopeKey: scopeKeyFor(scope.kind, scope.id), detail: decision.detail });
      }
    }
    for (const w of warnings) {
      this.emit({
        ts: new Date().toISOString(),
        runId,
        projectId,
        actor: "system",
        type: "error.raised",
        scope: `budget/${w.scopeKey}`,
        message: w.detail.slice(0, 2000),
        fatal: false,
      });
    }
  }

  private reservationsFor(scopes: BudgetScope[]): Reservation[] {
    return scopes.map((s) => ({
      kind: s.kind,
      id: s.id,
      tokens: s.profile.reservationTokens ?? 0,
    }));
  }

  private releaseReservations(reservation: Reservation[]): void {
    for (const r of reservation) this.ledger.release(r.kind, r.id, r.tokens);
  }

  /**
   * Post-execution reconciliation. The execution just committed to the DB, so
   * its reservation is consumed — release it first and re-evaluate each scope
   * against the durable committed aggregate. Anything but "allow" surfaces as
   * an error.raised event (warn level under "warn" behavior, otherwise the
   * overshoot concern); completion is never undone.
   */
  private reconcileBudget(rec: ExecutionRecord, reservation: Reservation[]): void {
    this.releaseReservations(reservation);
    for (const r of reservation) {
      const { totals, unknownExecutionCount } =
        r.kind === "run"
          ? aggregateCommittedRunUsage(this.opts.storage.db, r.id)
          : summarizeTaskCommittedUsage(this.opts.storage.db, r.id) ?? EMPTY_SUMMARY;
      const decision = evaluateBudget({
        profile:
          r.kind === "run"
            ? this.opts.budget?.run ?? { behavior: "block" }
            : this.opts.budget?.task ?? { behavior: "block" },
        totals: totals,
        unknownExecutionCount: unknownExecutionCount,
        reservedTokens: this.ledger.reservedTokens(r.kind, r.id),
        additionalTokens: 0,
      });
      if (decision.outcome === "allow") continue;
      const label = r.kind === "run" ? `run:${r.id}` : `task:${r.id}`;
      this.emit({
        ts: new Date().toISOString(),
        runId: rec.runId,
        projectId: rec.projectId,
        actor: "system",
        type: "error.raised",
        scope: `budget/${label}`,
        message: `budget concern after execution: ${decision.detail}`.slice(0, 2000),
        fatal: false,
      });
    }
  }

  private emit(event: Record<string, unknown>): void {
    try {
      this.opts.storage.events.append(event as never);
    } catch {
      // SAFETY: Event persistence is best-effort; failures must never escape
      // finalize paths as they would leave the execution in a stuck state.
    }
  }
}
