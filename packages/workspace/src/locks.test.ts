import { describe, expect, it } from "vitest";
import { MutexMap } from "./locks.js";

describe("MutexMap", () => {
  it("serializes holders on the same key", async () => {
    const m = new MutexMap();
    const events: string[] = [];

    const first = m.withLock("k", async () => {
      events.push("first:start");
      await new Promise((r) => setTimeout(r, 20));
      events.push("first:end");
    });
    const second = m.withLock("k", async () => {
      events.push("second:start");
      events.push("second:end");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("allows independent keys concurrently", async () => {
    const m = new MutexMap();
    let inside = 0;
    let overlap = false;
    const job = (key: string) =>
      m.withLock(key, async () => {
        inside++;
        if (inside > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 10));
        inside--;
      });
    await Promise.all([job("a"), job("b")]);
    expect(overlap).toBe(true);
  });

  it("grants queued waiters in FIFO order", async () => {
    const m = new MutexMap();
    const order: number[] = [];
    const release = await m.acquire("k");
    const waiters = [1, 2, 3].map((n) =>
      m.acquire("k", 5000).then((rel) => {
        order.push(n);
        rel();
      }),
    );
    // give every waiter time to enqueue before releasing
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
    expect(m.isLocked("k")).toBe(false);
  });

  it("rejects on timeout with a typed locked error", async () => {
    const m = new MutexMap();
    const release = await m.acquire("k");
    await expect(m.acquire("k", 25)).rejects.toMatchObject({
      code: "workspace/locked",
    });
    release();
    const again = await m.acquire("k", 25);
    expect(typeof again).toBe("function");
    again();
  });

  it("releases when the callback throws", async () => {
    const m = new MutexMap();
    await expect(
      m.withLock("k", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(m.isLocked("k")).toBe(false);
    await m.withLock("k", () => undefined);
  });

  it("release is idempotent", async () => {
    const m = new MutexMap();
    const release = await m.acquire("k");
    release();
    expect(() => release()).not.toThrow();
    expect(m.isLocked("k")).toBe(false);
  });
});
