import { useState, useEffect, useCallback } from "react";
import type { RunUsage, ExecutionUsage } from "../api/types.js";
import { getPipelineUsage } from "../api/client.js";
import {
  formatTokenCount,
  formatCostUsdMicros,
  isKnown,
} from "../utils/format.js";

interface Props {
  runId: string;
  /** Bumped by the parent when SSE events indicate a refresh is warranted. */
  refreshToken: number;
}

export default function UsageSection({ runId, refreshToken }: Props) {
  const [usage, setUsage] = useState<RunUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getPipelineUsage(runId);
      setUsage(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load usage");
    } finally {
      setLoading(false);
    }
  }, [runId]);

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
    <section className="usage-section">
      <h3>Pipeline Usage</h3>

      {loading && <p className="muted">Loading usage…</p>}
      {!loading && error && <p className="error">{error}</p>}

      {!loading && !error && usage && (
        <UsageSummaryCard usage={usage} />
      )}
    </section>
  );
}

function UsageSummaryCard({ usage }: { usage: RunUsage }) {
  const t = usage.totals;
  const zeroUsage = usage.executionCount === 0;

  return (
    <div className="usage-card">
      {zeroUsage ? (
        <p className="muted">No usage recorded for this pipeline run.</p>
      ) : (
        <div className="usage-grid">
          <UsageTile
            label="Input tokens"
            value={formatTokenCount(t.inputTokens)}
            known={isKnown(t.inputTokens)}
          />
          <UsageTile
            label="Output tokens"
            value={formatTokenCount(t.outputTokens)}
            known={isKnown(t.outputTokens)}
          />
          <UsageTile label="Executions" value={String(usage.executionCount)} known={true} />
          <UsageTile
            label="Unknown usage executions"
            value={String(usage.unknownExecutionCount)}
            known={true}
          />
          <UsageCostTile cost={t.costUsdMicros} currency={t.currency} />
        </div>
      )}

      {!zeroUsage && usage.perTask.length > 0 && (
        <div className="usage-per-task">
          <h4 className="usage-subtitle">Per Task</h4>
          <table className="usage-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Role</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.perTask.map((task) => (
                <tr key={task.taskId}>
                  <td className="mono" title={task.taskId}>
                    {task.title || task.taskId.slice(0, 8)}
                  </td>
                  <td>{task.role}</td>
                  <td className="num">{formatTokenCount(task.totals.inputTokens)}</td>
                  <td className="num">{formatTokenCount(task.totals.outputTokens)}</td>
                  <td className="num">{formatCellCost(task.totals)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UsageTile({
  label,
  value,
  known,
}: {
  label: string;
  value: string;
  known: boolean;
}) {
  return (
    <div className="usage-tile">
      <span className="usage-label">{label}</span>
      <span className={`usage-value${known ? "" : " usage-value--unknown"}`}>{value}</span>
    </div>
  );
}

function UsageCostTile({
  cost,
  currency,
}: {
  cost: number | null;
  currency: string | null;
}) {
  const text = formatCostUsdMicros(cost, currency);
  return (
    <UsageTile label="Cost" value={text ?? "unknown"} known={text !== null} />
  );
}

function formatCellCost(totals: ExecutionUsage): string {
  return isKnown(totals.costUsdMicros)
    ? (formatCostUsdMicros(totals.costUsdMicros, totals.currency) ?? "unknown")
    : "unknown";
}