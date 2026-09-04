import { useState, useEffect, useCallback } from "react";
import type { Approval, ApprovalDecision } from "../api/types.js";
import { getProjectApprovals, resolveApproval } from "../api/client.js";
import {
  approvalStatusLabel,
  filterApprovalsForRun,
  isApprovalPending,
} from "../utils/format.js";

interface Props {
  runId: string;
  projectId: string;
  /** Bumped by the parent when SSE events indicate a refresh is warranted. */
  refreshToken: number;
}

export default function ApprovalSection({
  runId,
  projectId,
  refreshToken,
}: Props) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await getProjectApprovals(projectId);
      setApprovals(filterApprovalsForRun(list, runId));
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load approvals");
    } finally {
      setLoading(false);
    }
  }, [projectId, runId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load, refreshToken]);

  return (
    <section className="approval-section">
      <h3>Approvals ({approvals.length})</h3>

      {loading && <p className="muted">Loading approvals…</p>}
      {!loading && error && <p className="error">{error}</p>}
      {!loading && !error && approvals.length === 0 && (
        <p className="muted">No pending approvals for this pipeline run.</p>
      )}

      {approvals.length > 0 && (
        <ul className="approval-list">
          {approvals.map((a) => (
            <li key={a.id}>
              <ApprovalCard approval={a} onRefresh={load} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ApprovalCard({
  approval,
  onRefresh,
}: {
  approval: Approval;
  onRefresh: () => void;
}) {
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const actionable = isApprovalPending(approval.status);

  const act = async (decision: ApprovalDecision) => {
    // Avoid duplicate submissions while one is in flight.
    if (submitting) return;
    setSubmitting(decision);
    setActionError(null);
    try {
      await resolveApproval(approval.id, decision);
      // The persisted state changed; re-fetch so the UI reflects the decision.
      await onRefresh();
    } catch (err: unknown) {
      setActionError(
        err instanceof Error ? err.message : "Failed to resolve approval",
      );
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className={`approval-card approval-card--${approval.status}`}>
      <div className="approval-header">
        <span className={`status-badge approval-status--${approval.status}`}>
          {approvalStatusLabel(approval.status)}
        </span>
        <span className={`approval-risk approval-risk--${approval.risk}`}>
          {approval.risk}
        </span>
        <span className="approval-kind mono">{approval.kind}</span>
        <span className="approval-requested muted mono">
          {new Date(approval.requestedAt).toLocaleString()}
        </span>
      </div>

      <div className="approval-title">{approval.title}</div>

      {approval.detail && (
        <div className="approval-detail muted">{approval.detail}</div>
      )}

      {approval.taskId && (
        <div className="approval-meta muted mono" title={approval.taskId}>
          task {approval.taskId.slice(0, 8)}
        </div>
      )}

      {!actionable && approval.resolvedAt && (
        <div className="approval-meta muted">
          Resolved {new Date(approval.resolvedAt).toLocaleString()}
          {approval.decision ? ` — ${approval.decision}` : ""}
          {approval.decidedBy ? ` by ${approval.decidedBy}` : ""}
        </div>
      )}

      {actionable && (
        <div className="approval-actions">
          <button
            type="button"
            className="btn-approve"
            disabled={submitting !== null}
            onClick={() => void act("allow")}
          >
            {submitting === "allow" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            className="btn-deny"
            disabled={submitting !== null}
            onClick={() => void act("deny")}
          >
            {submitting === "deny" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      )}

      {actionError && <p className="error approval-error">{actionError}</p>}
    </div>
  );
}
