import { EventEmitter } from "node:events";
import type { DomainEvent } from "@devmesh/contracts";

/**
 * Lightweight in-process event notification bus.
 * Used by SSE subscribers to receive events after they have been persisted
 * to SQLite. SQLite remains the source of truth; this bus only wakes
 * active listeners.
 */
export class EventBus extends EventEmitter {
  emitEvent(event: DomainEvent): void {
    this.emit("event", event);
  }
}
