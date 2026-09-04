import { describe, expect, it } from "vitest";
import type { DomainEvent } from "../api/types.js";
import {
  formatEventSummary,
  isTerminalEvent,
  pushRecentEvent,
  MAX_EVENTS,
} from "./usePipelineStream.js";

function makeEvent(seq: number, type: string): DomainEvent {
  return { seq, ts: "2026-09-04T00:00:00.000Z", type };
}

describe("isTerminalEvent", () => {
  it("treats run terminal events as terminal", () => {
    expect(isTerminalEvent(makeEvent(1, "run.completed"))).toBe(true);
    expect(isTerminalEvent(makeEvent(2, "run.failed"))).toBe(true);
    expect(isTerminalEvent(makeEvent(3, "run.cancelled"))).toBe(true);
  });

  it("treats non-terminal events as non-terminal", () => {
    expect(isTerminalEvent(makeEvent(4, "run.started"))).toBe(false);
    expect(isTerminalEvent(makeEvent(5, "task.transitioned"))).toBe(false);
  });
});

describe("pushRecentEvent", () => {
  it("prepends the newest event first", () => {
    const list = pushRecentEvent(
      [makeEvent(1, "run.started")],
      makeEvent(2, "task.created"),
    );
    expect(list.map((e) => e.seq)).toEqual([2, 1]);
  });

  it("deduplicates by seq keeping the newest occurrence", () => {
    const first = makeEvent(1, "run.started");
    const replayed = makeEvent(1, "run.started");
    const list = pushRecentEvent([first], replayed);
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(replayed);
  });

  it("caps the list at MAX_EVENTS", () => {
    let list: DomainEvent[] = [];
    for (let i = 1; i <= MAX_EVENTS + 25; i++) {
      list = pushRecentEvent(list, makeEvent(i, "run.started"));
    }
    expect(list.length).toBe(MAX_EVENTS);
    // The most recent (highest seq) is kept first.
    expect(list[0]!.seq).toBe(MAX_EVENTS + 25);
  });

  it("newest events are easy to see (first element is newest)", () => {
    const list1 = pushRecentEvent([], makeEvent(10, "run.started"));
    const list = pushRecentEvent(list1, makeEvent(11, "task.created"));
    expect(list[0]!.seq).toBe(11);
  });
});

describe("formatEventSummary", () => {
  it("formats run.started", () => {
    expect(formatEventSummary(makeEvent(1, "run.started") as never)).toContain("Pipeline started");
  });

  it("formats run.failed with reason", () => {
    const evt = { ...makeEvent(2, "run.failed"), reason: "boom" } as never;
    expect(formatEventSummary(evt)).toBe("Pipeline failed: boom");
  });

  it("formats artifact.recorded", () => {
    const evt = { ...makeEvent(3, "artifact.recorded"), kind: "plan" } as never;
    expect(formatEventSummary(evt)).toBe("Artifact recorded: plan");
  });

  it("falls back to the raw type for unknown events", () => {
    expect(formatEventSummary(makeEvent(9, "some.unknown"))).toBe("some.unknown");
  });
});
