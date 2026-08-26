import type { DomainEvent, RunId } from "@devmesh/contracts";
import type { PipelineRunStatus } from "@devmesh/contracts";
import type { Storage } from "@devmesh/storage";

/** Pipeline states that should cause the SSE stream to close after delivery. */
const TERMINAL_STATES: ReadonlySet<PipelineRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timeout",
]);

export interface StreamCallbacks {
  /** Called for each event to deliver to the client. */
  onEvent(event: DomainEvent): void;
  /** Called when the stream should close (terminal event delivered or error). */
  onClose(): void;
}

export interface StreamOptions {
  storage: Storage;
  runId: RunId;
  afterSeq: number;
  heartbeatIntervalMs?: number;
  callbacks: StreamCallbacks;
}

/**
 * Handles replay of persisted events and live streaming for a single
 * SSE connection tied to one pipeline run.
 *
 * Ordering strategy:
 *   1. Subscribe to EventBus BEFORE querying SQLite (prevents gap).
 *   2. Query persisted events after Last-Event-ID.
 *   3. Send replayed events; skip any that arrived during query.
 *   4. Flush live buffer, then process ongoing events.
 *
 * SQLite is always the source of truth. The EventBus is a wake-up
 * mechanism only; missed notifications are recovered via Last-Event-ID
 * reconnection.
 */
export class PipelineEventStream {
  private readonly storage: Storage;
  private readonly runId: RunId;
  private readonly callbacks: StreamCallbacks;
  private readonly heartbeatMs: number;
  private sentSeq = new Set<number>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private liveListener: ((event: DomainEvent) => void) | null = null;
  private liveBuffer: DomainEvent[] = [];
  private bufferingLive = false;
  private closed = false;

  constructor(opts: StreamOptions) {
    this.storage = opts.storage;
    this.runId = opts.runId;
    this.callbacks = opts.callbacks;
    this.heartbeatMs = opts.heartbeatIntervalMs ?? 15_000;
  }

  /**
   * Start replay and live streaming. Resolves when the stream closes.
   * Must be called exactly once.
   */
  async start(afterSeq: number): Promise<void> {
    if (this.closed) return;

    // 1. Start buffering live events before querying SQLite to prevent gaps.
    this.bufferingLive = true;
    this.liveListener = (event: DomainEvent) => {
      if (event.runId !== this.runId) return;
      if (this.sentSeq.has(event.seq)) return;
      if (this.bufferingLive) {
        this.liveBuffer.push(event);
      } else {
        this.deliverEvent(event);
      }
    };
    this.storage.eventBus.on("event", this.liveListener);

    // 2. Replay persisted events from SQLite.
    const replayEvents = this.storage.events.listByRunAfter(this.runId, afterSeq, 10_000);
    let replayedTerminal = false;
    for (const event of replayEvents) {
      if (this.closed) break;
      this.deliverEvent(event);
      if (PipelineEventStream.isTerminalEvent(event)) {
        replayedTerminal = true;
      }
    }

    // 3. Flush live buffer (events that arrived during SQLite query).
    this.bufferingLive = false;
    const buffered = this.liveBuffer;
    this.liveBuffer = [];
    for (const event of buffered) {
      if (this.closed) break;
      this.deliverEvent(event);
      if (PipelineEventStream.isTerminalEvent(event)) {
        replayedTerminal = true;
      }
    }

    // 4. If a terminal event was replayed/delivered, close cleanly.
    if (replayedTerminal || this.closed) {
      this.close();
      return;
    }

    // 5. If pipeline already in terminal state (no terminal event found but
    //    pipeline_runs row says so), close. This covers the case where a
    //    client reconnects with Last-Event-ID past the terminal event.
    if (this.isTerminalAfterReplay()) {
      this.close();
      return;
    }

    // 6. Start keepalive heartbeat.
    this.startHeartbeat();
  }

  /** Forcefully stop the stream (e.g., on client disconnect). */
  stop(): void {
    this.close();
  }

  private deliverEvent(event: DomainEvent): void {
    if (this.sentSeq.has(event.seq)) return;
    this.sentSeq.add(event.seq);
    this.callbacks.onEvent(event);

    if (PipelineEventStream.isTerminalEvent(event)) {
      this.close();
    }
  }

  private startHeartbeat(): void {
    if (this.closed) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) {
        this.clearHeartbeat();
        return;
      }
      try {
        this.callbacks.onEvent({ type: "__heartbeat" } as unknown as DomainEvent);
      } catch {
        this.close();
      }
    }, this.heartbeatMs);
    // Allow Node.js to exit even if the timer is active.
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearHeartbeat();
    if (this.liveListener) {
      this.storage.eventBus.removeListener("event", this.liveListener);
      this.liveListener = null;
    }
    this.liveBuffer = [];
    this.callbacks.onClose();
  }

  private isTerminalAfterReplay(): boolean {
    const run = this.storage.pipelineRuns.get(this.runId);
    if (!run) return true;
    return TERMINAL_STATES.has(run.status);
  }

  static isTerminalEvent(event: DomainEvent): boolean {
    return (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    );
  }
}
