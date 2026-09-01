import {
  newApprovalId,
  type ProjectId,
  type RunId,
  type TaskId,
} from "@devmesh/contracts";
import type {
  ApprovalRecord,
  ApprovalDecision,
  Storage,
} from "@devmesh/storage";

/**
 * Human-facing intent of an approval-gated action plus the risk level used to
 * render it in a review queue. `kind` is a stable machine-readable category
 * (e.g. "destructive_git", "network_egress", "cost_release").
 */
export interface ApprovalSpec {
  kind: string;
  title: string;
  detail: string;
  risk: "low" | "medium" | "high" | "critical";
}

export interface CommonRequestApproval {
  projectId: ProjectId;
  runId: RunId;
  taskId: TaskId | null;
  spec: ApprovalSpec;
}

/**
 * The single owner of the approval lifecycle for the control plane. Both the
 * REST layer and the orchestrator go through here so created/resolved approval
 * events are emitted exactly once and persisted state stays authoritative.
 *
 * Persistence is delegated to the atomic `ApprovalRepository` (Phase 9A): a
 * single guarded UPDATE rejects unknown ids and double-resolution. No in-memory
 * promise is ever the source of truth — resolution is read from the durable
 * `approvals` table.
 */
export class ApprovalGate {
  constructor(private readonly storage: Storage) {}

  /**
   * Create and persist an approval request and emit `approval.requested`.
   *
   * Idempotent by identity: when an approval already exists for the same
   * (runId, taskId) — e.g. the pipeline was restarted and the gate is being
   * reconstructed from persisted storage — the existing record is returned and
   * NO duplicate row or `approval.requested` event is created. An already
   * approved/denied record is returned as-is (never re-requested).
   *
   * Resumability: Phase 7C resume recreates task cards under NEW ids for the
   * same logical stage, so the (runId, taskId) match can miss. In that case the
   * lookup falls back to the gate identity `kind` (deterministic for a given
   * gated action, e.g. "destructive_git"), which lets a resumed pipeline pick
   * up the decision made before it was cancelled instead of re-requesting.
   */
  request(input: CommonRequestApproval): ApprovalRecord {
    // Reconstruct from persisted state first (resumability).
    const existing = this.findExisting(input.runId, input.taskId, input.spec.kind);
    if (existing) return existing;

    const record: ApprovalRecord = {
      id: newApprovalId(),
      projectId: input.projectId,
      runId: input.runId,
      taskId: input.taskId,
      kind: input.spec.kind,
      title: input.spec.title,
      detail: input.spec.detail,
      risk: input.spec.risk,
      status: "pending",
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      decision: null,
      decidedBy: null,
    };
    this.storage.approvals.insert(record);
    this.emit({
      ts: record.requestedAt,
      runId: record.runId,
      projectId: record.projectId,
      actor: "system",
      type: "approval.requested",
      approvalId: record.id,
      title: record.title,
      detail: record.detail,
      risk: record.risk,
    });
    return record;
  }

  /** True when the approval is in a terminal (approved/denied) state. */
  isResolved(id: string): boolean {
    const rec = this.storage.approvals.get(id);
    return rec !== null && rec.status !== "pending";
  }

  /**
   * Resolve a pending approval. Delegates to the atomic repository `resolve`,
   * which throws `storage/not-found` (unknown id) or `storage/approval-resolved`
   * (already resolved) — so a double resolution is impossible. Emits the
   * existing `approval.resolved` event ONLY after the persisted resolution
   * succeeds.
   */
  resolve(id: string, decision: ApprovalDecision): ApprovalRecord {
    const updated = this.storage.approvals.resolve(id, decision, "user");
    this.emit({
      ts: updated.resolvedAt ?? new Date().toISOString(),
      runId: updated.runId,
      projectId: updated.projectId,
      actor: "system",
      type: "approval.resolved",
      approvalId: updated.id,
      decision,
      decidedBy: "user",
    });
    return updated;
  }

  /**
   * Wait for a persisted approval to leave `pending`. Returns the final
   * record, or the current record when `timeoutMs` (default: no timeout)
   * elapses without a decision. Polls the durable table — mirrors the
   * orchestrator's existing `waitForTerminal` approach, no busy spinning and
   * no in-memory promise.
   */
  async waitForResolution(
    id: string,
    timeoutMs: number | null = null,
  ): Promise<ApprovalRecord> {
    const deadline =
      timeoutMs === null ? Infinity : Date.now() + timeoutMs;
    for (;;) {
      const rec = this.storage.approvals.get(id);
      if (rec && rec.status !== "pending") return rec;
      if (Date.now() > deadline) {
        return this.storage.approvals.get(id) ?? {
          id,
          projectId: "" as ProjectId,
          runId: "" as RunId,
          taskId: null,
          kind: "",
          title: "",
          detail: "",
          risk: "medium",
          status: "pending",
          requestedAt: new Date().toISOString(),
          resolvedAt: null,
          decision: null,
          decidedBy: null,
        };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * Wait until ANY of the given approval ids reaches a decision. Returns that
   * record, or `null` when the caller's cancellation/abort flag flips first.
   */
  async waitAnyResolution(
    ids: string[],
    isAborted: () => boolean,
  ): Promise<ApprovalRecord | null> {
    for (;;) {
      if (isAborted()) return null;
      for (const id of ids) {
        const rec = this.storage.approvals.get(id);
        if (rec && rec.status !== "pending") return rec;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * Find an earlier approval for the same gate so a re-request (pipeline
   * restart, resumed run with a recreated task card) never duplicates a row or
   * re-emits `approval.requested`. Precise (runId, taskId) match first; falls
   * back to (runId, kind) because resume mints new task ids for the same stage.
   */
  private findExisting(
    runId: string,
    taskId: TaskId | null,
    kind: string,
  ): ApprovalRecord | null {
    const approvals = this.storage.approvals.listByRun(runId);
    const byTask = approvals.find((a) => a.runId === runId && a.taskId === taskId);
    if (byTask) return byTask;
    return approvals.find((a) => a.runId === runId && a.kind === kind) ?? null;
  }

  private emit(event: Record<string, unknown>): void {
    try {
      this.storage.events.append(event as never);
    } catch {
      // SAFETY: best-effort — matches the rest of the control plane.
    }
  }
}
