import { useState, useEffect, useRef, useCallback } from "react";
import type { DomainEvent } from "../api/types.js";
import { openPipelineStream } from "../api/client.js";

export const MAX_EVENTS = 50;
export const REFRESH_DEBOUNCE_MS = 300;

export type ConnectionStatus = "connecting" | "live" | "disconnected" | "closed";

export function isTerminalEvent(event: DomainEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled"
  );
}

/**
 * Prepend an event to a bounded recent-event list, newest first, deduplicated
 * by seq, capped at MAX_EVENTS. Pure and testable.
 */
export function pushRecentEvent(
  events: DomainEvent[],
  event: DomainEvent,
): DomainEvent[] {
  const next = [event, ...events.filter((e) => e.seq !== event.seq)];
  return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
}

const DATA_EVENT_TYPES = new Set([
  "task.created",
  "task.transitioned",
  "artifact.recorded",
  "verification.failed",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "checkpoint.created",
  "agent.session.opened",
  "agent.reply.completed",
]);

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

export function formatEventSummary(event: DomainEvent): string {
  switch (event.type) {
    case "run.started":
      return `Pipeline started: ${str(event.goal, 60)}`;
    case "run.completed":
      return `Pipeline completed${str(event.summary, 60) ? `: ${str(event.summary, 60)}` : ""}`;
    case "run.failed":
      return `Pipeline failed: ${str(event.reason, 80)}`;
    case "run.cancelled":
      return `Pipeline cancelled${str(event.reason, 60) ? `: ${str(event.reason, 60)}` : ""}`;
    case "task.created": {
      const card = event.card as { title?: unknown; role?: unknown } | undefined;
      return `Task created: ${str(card?.title, 60)} (${str(card?.role, 20)})`;
    }
    case "task.transitioned":
      return `Task ${str(event.from, 30)} → ${str(event.to, 30)}`;
    case "artifact.recorded":
      return `Artifact recorded: ${str(event.kind, 30)}`;
    case "verification.failed":
      return `Verification failed (${str(event.failingChecks, 20)} checks)`;
    case "checkpoint.created":
      return `Checkpoint: ${str(event.label, 60)}`;
    case "approval.requested":
      return `Approval requested: ${str(event.title, 60)}`;
    case "approval.resolved":
      return `Approval ${str(event.decision, 20)}`;
    case "permission.requested":
      return `Permission request: ${str(event.tool, 30)}`;
    case "permission.resolved":
      return `Permission ${str(event.decision, 20)}`;
    case "agent.session.opened":
      return `Agent ${str(event.role, 20)} session opened`;
    case "agent.reply.completed":
      return `Agent ${str(event.role, 20)} replied (${str(event.durationMs, 20)}ms)`;
    case "runtime.health.changed":
      return `Runtime ${str(event.runtimeId, 8)}: ${event.healthy ? "healthy" : "unhealthy"}`;
    case "error.raised":
      return `Error [${str(event.scope, 40)}]: ${str(event.message, 80)}`;
    default:
      return event.type;
  }
}

export interface UsePipelineStreamResult {
  connectionStatus: ConnectionStatus;
  recentEvents: DomainEvent[];
}

export function usePipelineStream(
  runId: string | null,
  onRefresh?: () => void,
): UsePipelineStreamResult {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [recentEvents, setRecentEvents] = useState<DomainEvent[]>([]);

  const esRef = useRef<EventSource | null>(null);
  const closedRef = useRef(false);
  const lastSeenSeq = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSeenSeq = useRef(0);

  const doRefresh = useCallback(async (triggerSeq: number) => {
    if (closedRef.current) return;
    if (triggerSeq < latestSeenSeq.current) return;
    try {
      await onRefresh?.();
    } finally {
      if (!closedRef.current) {
        lastSeenSeq.current = triggerSeq;
      }
    }
  }, [onRefresh]);

  const scheduleRefresh = useCallback((seq: number) => {
    if (closedRef.current) return;
    latestSeenSeq.current = seq;
    if (refreshTimer.current !== null) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void doRefresh(latestSeenSeq.current);
    }, REFRESH_DEBOUNCE_MS);
  }, [doRefresh]);

  const triggerImmediateRefresh = useCallback((seq: number) => {
    if (closedRef.current) return;
    latestSeenSeq.current = seq;
    if (refreshTimer.current !== null) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    void doRefresh(seq);
  }, [doRefresh]);

  useEffect(() => {
    closedRef.current = false;
    lastSeenSeq.current = 0;
    latestSeenSeq.current = 0;
    setConnectionStatus("connecting");
    setRecentEvents([]);

    if (!runId) {
      setConnectionStatus("closed");
      return;
    }

    const checkReadyState = (): void => {
      if (closedRef.current) return;
      const es = esRef.current;
      if (!es) return;
      if (es.readyState === EventSource.CLOSED) {
        setConnectionStatus((prev) =>
          prev === "live" ? "closed" : prev,
        );
      }
    };

    const onEvent = (event: DomainEvent): void => {
      if (closedRef.current) return;

      if (!event || typeof event.type !== "string") return;
      if (event.type === "__heartbeat") return;

      const isTerminal = isTerminalEvent(event);

      setConnectionStatus("live");

      if (event.seq > lastSeenSeq.current) {
        lastSeenSeq.current = event.seq;
        setRecentEvents((prev) => pushRecentEvent(prev, event));

        if (DATA_EVENT_TYPES.has(event.type)) {
          if (isTerminal) {
            triggerImmediateRefresh(event.seq);
          } else {
            scheduleRefresh(event.seq);
          }
        }
      }

      if (isTerminal) {
        setConnectionStatus("closed");
        // The server has closed the stream after this terminal event. Close the
        // native EventSource ourselves so the browser does not enter a reconnect
        // loop for a pipeline that can no longer emit events.
        esRef.current?.close();
      }
    };

    const onError = (): void => {
      if (closedRef.current) return;
      const es = esRef.current;
      if (!es) return;
      if (es.readyState === EventSource.CLOSED) {
        setConnectionStatus("closed");
      } else if (es.readyState === EventSource.CONNECTING) {
        setConnectionStatus("disconnected");
      }
    };

    setConnectionStatus("connecting");
    const es = openPipelineStream(runId, onEvent, { onError });
    esRef.current = es;

    const readyStateInterval = setInterval(checkReadyState, 1000);

    return () => {
      closedRef.current = true;
      clearInterval(readyStateInterval);
      if (refreshTimer.current !== null) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }

      es.removeEventListener("error", onError);
      for (const type of [
        "run.started", "run.completed", "run.failed", "run.cancelled",
        "task.created", "task.transitioned", "artifact.recorded",
        "verification.failed", "checkpoint.created",
        "approval.requested", "approval.resolved",
        "permission.requested", "permission.resolved",
        "agent.session.opened", "agent.reply.completed",
        "runtime.health.changed", "error.raised",
      ]) {
        es.removeEventListener(type, onEvent as unknown as EventListener);
      }
      es.close();
      esRef.current = null;
    };
  }, [runId, scheduleRefresh, triggerImmediateRefresh]);

  return { connectionStatus, recentEvents };
}
