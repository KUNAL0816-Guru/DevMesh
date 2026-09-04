import type { DomainEvent } from "../api/types.js";
import { formatEventSummary } from "../hooks/usePipelineStream.js";
import type { ConnectionStatus } from "../hooks/usePipelineStream.js";

export type { ConnectionStatus } from "../hooks/usePipelineStream.js";

interface Props {
  status: ConnectionStatus;
  events: DomainEvent[];
}

function statusLabel(status: ConnectionStatus): { text: string; cls: string } {
  switch (status) {
    case "connecting":
      return { text: "Connecting…", cls: "live-connecting" };
    case "live":
      return { text: "Live", cls: "live-live" };
    case "disconnected":
      return { text: "Reconnecting…", cls: "live-disconnected" };
    case "closed":
      return { text: "Closed", cls: "live-closed" };
  }
}

export default function PipelineActivity({ status, events }: Props) {
  const label = statusLabel(status);
  return (
    <div className="pipeline-activity">
      <div className="activity-header">
        <h3>Live Activity</h3>
        <span className={`live-badge ${label.cls}`} data-testid="live-status">
          <span className="live-dot" />
          {label.text}
        </span>
      </div>
      {events.length === 0 ? (
        <p className="muted activity-empty">
          Waiting for events…
        </p>
      ) : (
        <ul className="activity-list">
          {events.slice(0, 50).map((event) => (
            <li key={event.seq} className="activity-item">
              <span className="activity-type mono">{event.type}</span>
              <span className="activity-seq mono">#{event.seq}</span>
              <span className="activity-summary">
                {formatEventSummary(event)}
              </span>
              <span className="activity-time muted mono">
                {formatDate(event.ts)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDate(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "";
  }
}
