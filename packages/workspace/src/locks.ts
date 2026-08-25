import { WorkspaceError } from "./errors.js";

interface QueueNode {
  run: () => void;
  cancel: (err: WorkspaceError) => void;
}

/**
 * FIFO per-key async mutex. Mutation-critical workspace operations acquire
 * the lock for their key (the canonical workspace root), serializing writers
 * while leaving readers unblocked.
 */
export class MutexMap {
  private readonly locked = new Set<string>();
  private readonly queues = new Map<string, QueueNode[]>();

  /**
   * Acquire the lock for `key`. Rejects with workspace/locked when not
   * granted within `timeoutMs`. Returns the release function (idempotent).
   */
  async acquire(key: string, timeoutMs = 10_000): Promise<() => void> {
    if (!this.locked.has(key)) {
      this.locked.add(key);
      return this.releaseFn(key);
    }
    return new Promise<() => void>((res, rej) => {
      const queue = this.queues.get(key) ?? [];
      const node: QueueNode = {
        run: () => res(this.releaseFn(key)),
        cancel: (err) => rej(err),
      };
      queue.push(node);
      this.queues.set(key, queue);

      const timer = setTimeout(() => {
        this.dequeue(key, node);
        node.cancel(
          new WorkspaceError(
            "workspace/locked",
            `timed out after ${timeoutMs}ms waiting for mutation lock`,
          ),
        );
      }, timeoutMs);

      // wrap so cancellation clears the timer
      const origRun = node.run;
      const origCancel = node.cancel;
      node.run = () => {
        clearTimeout(timer);
        origRun();
      };
      node.cancel = (err) => {
        clearTimeout(timer);
        origCancel(err);
      };
    });
  }

  /** Run `fn` while holding the lock; releases on success and on throw. */
  async withLock<T>(key: string, fn: () => Promise<T> | T, timeoutMs?: number): Promise<T> {
    const release = await this.acquire(key, timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  isLocked(key: string): boolean {
    return this.locked.has(key);
  }

  private releaseFn(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.unlock(key);
    };
  }

  private unlock(key: string): void {
    const queue = this.queues.get(key);
    const next = queue?.shift();
    if (next) {
      next.run();
      return;
    }
    this.queues.delete(key);
    this.locked.delete(key);
  }

  private dequeue(key: string, node: QueueNode): void {
    const queue = this.queues.get(key);
    if (!queue) return;
    const idx = queue.indexOf(node);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) this.queues.delete(key);
  }
}
