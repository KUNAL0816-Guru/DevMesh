import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeTaskCard,
  newProjectId,
  newRunId,
  type DomainEvent,
} from "@devmesh/contracts";
import { createStorage, type Storage } from "@devmesh/storage";
import { WorkspaceService } from "@devmesh/workspace";
import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";
import { PipelineEventStream } from "./pipeline-sse.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-sse-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

function testConfig() {
  return loadConfig({
    DEVMESH_DATA_ROOT: dataRoot,
    DEVMESH_LOG_LEVEL: "error",
    DEVMESH_PORT: "0",
  });
}

async function buildStack() {
  const config = testConfig();
  const storage = createStorage({ path: join(config.dataRoot, "test.db") });
  const workspaces = new WorkspaceService({
    store: storage.projects,
    workspacesRoot: join(config.dataRoot, "workspaces"),
  });
  const app = buildApp({ config, storage, workspaces });
  return { app, storage };
}

function seedPipeline(storage: Storage) {
  const projectId = newProjectId();
  const runId = newRunId();
  const now = "2026-08-01T10:00:00.000Z";

  storage.projects.insert({
    id: projectId,
    name: "sse-test",
    rootPath: "/tmp/sse-test",
    createdAt: now,
  });

  storage.pipelineRuns.insert({
    id: runId,
    projectId,
    status: "running",
    goal: "test SSE streaming",
    errorMessage: null,
    createdAt: now,
    finishedAt: null,
    durationMs: null,
  });

  return { projectId, runId };
}

function appendEvent(
  storage: Storage,
  runId: string,
  projectId: string,
  type: string,
  extra: Record<string, unknown> = {},
): DomainEvent {
  return storage.events.append({
    ts: new Date().toISOString(),
    runId,
    projectId,
    actor: "system",
    type: type as DomainEvent["type"],
    ...extra,
  } as never);
}

function appendTaskCreated(
  storage: Storage,
  runId: string,
  projectId: string,
): DomainEvent {
  const card = makeTaskCard({
    runId,
    projectId,
    role: "architect",
    title: "Test task",
    detail: "test detail",
    acceptanceCriteria: ["done"],
    dependsOn: [],
    status: "pending",
  });
  return appendEvent(storage, runId, projectId, "task.created", { card });
}

// ---------------------------------------------------------------------------
// Fastify inject tests (validation, 404)
// ---------------------------------------------------------------------------

describe("SSE endpoint: validation and 404", () => {
  it("returns 404 for a missing pipeline run", async () => {
    const { app, storage } = await buildStack();
    seedPipeline(storage);
    const missingRun = newRunId();
    const res = await app.inject({ method: "GET", url: `/pipelines/${missingRun}/events/stream` });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("pipeline/not-found");
    await app.close();
  });

  it("returns 404 for an invalid run id (matches existing convention)", async () => {
    const { app } = await buildStack();
    const res = await app.inject({ method: "GET", url: "/pipelines/not-a-uuid/events/stream" });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("pipeline/not-found");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// PipelineEventStream unit tests (deterministic, no HTTP)
// ---------------------------------------------------------------------------

describe("PipelineEventStream", () => {
  it("replays existing events in ascending seq order", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    const e1 = appendEvent(storage, runId, projectId, "run.started", { goal: "test" });
    const e2 = appendEvent(storage, runId, projectId, "run.completed", { summary: "done" });

    const received: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => {},
      },
    });

    await stream.start(0);

    expect(received).toHaveLength(2);
    expect(received[0]!.seq).toBe(e1.seq);
    expect(received[1]!.seq).toBe(e2.seq);
    await storage.close();
  });

  it("returns 404-style behavior: empty stream for nonexistent run", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { projectId } = seedPipeline(storage);
    const missingRun = newRunId();

    // Seed some events for a different run.
    appendEvent(storage, missingRun, projectId, "run.started", { goal: "other" });

    const received: DomainEvent[] = [];
    let closed = false;
    const stream = new PipelineEventStream({
      storage,
      runId: newRunId(),
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => { closed = true; },
      },
    });

    await stream.start(0);
    expect(received).toHaveLength(0);
    expect(closed).toBe(true);
    await storage.close();
  });

  it("event id equals database seq", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);
    const evt = appendEvent(storage, runId, projectId, "run.started", { goal: "test" });

    const received: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => {},
      },
    });

    await stream.start(0);
    expect(received).toHaveLength(1);
    expect(received[0]!.seq).toBe(evt.seq);
    await storage.close();
  });

  it("event type matches DomainEvent type", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);
    appendTaskCreated(storage, runId, projectId);

    const received: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => {},
      },
    });

    await stream.start(0);
    expect(received[0]!.type).toBe("task.created");
    await storage.close();
  });

  it("replays events after Last-Event-ID (reconnection)", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    // Create 4 events.
    const _e1 = appendEvent(storage, runId, projectId, "run.started", { goal: "a" });
    const e2 = appendEvent(storage, runId, projectId, "run.started", { goal: "b" });
    const e3 = appendEvent(storage, runId, projectId, "run.started", { goal: "c" });
    const e4 = appendEvent(storage, runId, projectId, "run.completed", { summary: "done" });

    // Client reconnects with Last-Event-ID: e2.seq — should receive e3 and e4.
    const received: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: e2.seq,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => {},
      },
    });

    await stream.start(e2.seq);

    expect(received).toHaveLength(2);
    expect(received[0]!.seq).toBe(e3.seq);
    expect(received[1]!.seq).toBe(e4.seq);
    await storage.close();
  });

  it("Last-Event-ID equal to newest event returns no replay", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    appendEvent(storage, runId, projectId, "run.started", { goal: "t" });
    const lastEvt = appendEvent(storage, runId, projectId, "run.completed", { summary: "done" });

    // Update pipeline run to terminal status (matching what the orchestrator does).
    const pipelineRun = storage.pipelineRuns.get(runId)!;
    storage.pipelineRuns.update({ ...pipelineRun, status: "completed", finishedAt: new Date().toISOString() });

    const received: DomainEvent[] = [];
    let closed = false;
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: lastEvt.seq,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => { closed = true; },
      },
    });

    await stream.start(lastEvt.seq);

    // No new events to replay; pipeline is terminal so stream closes.
    expect(received).toHaveLength(0);
    expect(closed).toBe(true);
    await storage.close();
  });

  it("delivers live events created after connection", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    const received: DomainEvent[] = [];
    let closed = false;
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => { closed = true; },
      },
    });

    // Start the stream (no persisted events yet, pipeline is running).
    const startPromise = stream.start(0);

    // Give the listener time to attach.
    await new Promise((r) => setTimeout(r, 20));

    // Append events after the stream is live.
    const liveEvt1 = appendEvent(storage, runId, projectId, "run.started", { goal: "live" });
    await new Promise((r) => setTimeout(r, 20));
    const liveEvt2 = appendEvent(storage, runId, projectId, "run.completed", { summary: "done" });

    await startPromise;

    // Should have received both live events.
    const liveEvents = received.filter((e) => e.seq >= liveEvt1.seq);
    expect(liveEvents.length).toBeGreaterThanOrEqual(2);
    expect(liveEvents[0]!.seq).toBe(liveEvt1.seq);
    expect(liveEvents[1]!.seq).toBe(liveEvt2.seq);
    expect(closed).toBe(true);
    await storage.close();
  });

  it("multiple live events preserve seq ordering", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    const received: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => {},
      },
    });

    const startPromise = stream.start(0);
    await new Promise((r) => setTimeout(r, 20));

    // Fire multiple events rapidly.
    for (let i = 0; i < 5; i++) {
      appendEvent(storage, runId, projectId, "run.started", { goal: `goal-${i}` });
    }
    // Terminal event.
    appendEvent(storage, runId, projectId, "run.completed", { summary: "done" });

    await startPromise;

    // All events should be received in ascending seq order.
    const seqs = received.map((e) => e.seq);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    await storage.close();
  });

  it("events from another pipeline are not delivered", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId: runId1, projectId: projectId1 } = seedPipeline(storage);

    // Create a second pipeline.
    const projectId2 = newProjectId();
    const runId2 = newRunId();
    storage.projects.insert({ id: projectId2, name: "other", rootPath: "/other", createdAt: new Date().toISOString() });
    storage.pipelineRuns.insert({
      id: runId2, projectId: projectId2, status: "running",
      goal: "other", errorMessage: null, createdAt: new Date().toISOString(),
      finishedAt: null, durationMs: null,
    });

    // Add events to pipeline 2.
    appendEvent(storage, runId2, projectId2, "run.started", { goal: "other" });

    // Stream pipeline 1.
    const received: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId: runId1,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => {},
      },
    });

    const startPromise = stream.start(0);
    await new Promise((r) => setTimeout(r, 20));

    // Add event to pipeline 1.
    appendEvent(storage, runId1, projectId1, "run.started", { goal: "test" });
    // Add another event to pipeline 2.
    appendEvent(storage, runId2, projectId2, "run.completed", { summary: "done" });
    // Terminal for pipeline 1.
    appendEvent(storage, runId1, projectId1, "run.completed", { summary: "done" });

    await startPromise;

    // Only pipeline 1 events should be received.
    const runIds = received.map((e) => e.runId);
    expect(runIds.every((id) => id === runId1)).toBe(true);
    await storage.close();
  });

  it("disconnect removes the subscriber/listener", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId } = seedPipeline(storage);

    const received: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => {},
      },
    });

    await stream.start(0);

    // Verify the bus has a listener.
    expect(storage.eventBus.listenerCount("event")).toBeGreaterThan(0);

    // Stop (simulate disconnect).
    stream.stop();

    // Listener should be removed.
    expect(storage.eventBus.listenerCount("event")).toBe(0);
    await storage.close();
  });

  it("heartbeat does not create database events", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId } = seedPipeline(storage);

    const heartbeats: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      heartbeatIntervalMs: 50,
      callbacks: {
        onEvent: (e) => {
          if ((e as { type?: string }).type === "__heartbeat") {
            heartbeats.push(e);
          }
        },
        onClose: () => {},
      },
    });

    await stream.start(0);
    // Wait for at least one heartbeat.
    await new Promise((r) => setTimeout(r, 120));
    stream.stop();

    expect(heartbeats.length).toBeGreaterThanOrEqual(1);

    // Verify no heartbeat events were persisted to the database.
    const dbEvents = storage.events.listByRun(runId);
    const heartbeatInDb = dbEvents.filter((e) => e.type === "__heartbeat");
    expect(heartbeatInDb).toHaveLength(0);
    await storage.close();
  });

  it("terminal pipeline event is delivered and stream closes", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    const received: DomainEvent[] = [];
    let closed = false;
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => { closed = true; },
      },
    });

    const startPromise = stream.start(0);
    await new Promise((r) => setTimeout(r, 20));

    appendEvent(storage, runId, projectId, "run.completed", { summary: "done" });
    await startPromise;

    expect(closed).toBe(true);
    const terminalEvents = received.filter((e) => e.type === "run.completed");
    expect(terminalEvents).toHaveLength(1);
    await storage.close();
  });

  it("stream closes cleanly after terminal pipeline event", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    let closeCount = 0;
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: () => {},
        onClose: () => { closeCount++; },
      },
    });

    const startPromise = stream.start(0);
    await new Promise((r) => setTimeout(r, 20));

    appendEvent(storage, runId, projectId, "run.failed", { reason: "test" });
    await startPromise;

    // onClose should be called exactly once.
    expect(closeCount).toBe(1);
    await storage.close();
  });

  it("replay/live boundary does not lose an event", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    // Pre-seed event.
    appendEvent(storage, runId, projectId, "run.started", { goal: "test" });

    const received: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => {},
      },
    });

    // Start stream, then immediately append an event (racing the listener setup).
    const startPromise = stream.start(0);
    // Fire event as quickly as possible (may land during listener setup or replay).
    appendEvent(storage, runId, projectId, "run.completed", { summary: "done" });

    await startPromise;

    // We should have received all 2 events (no loss).
    expect(received.length).toBeGreaterThanOrEqual(2);
    await storage.close();
  });

  it("replay/live boundary does not duplicate an event", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    // Pre-seed events.
    appendEvent(storage, runId, projectId, "run.started", { goal: "test" });

    const received: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => {},
      },
    });

    await stream.start(0);

    // Append a new event after replay.
    appendEvent(storage, runId, projectId, "run.completed", { summary: "done" });
    await new Promise((r) => setTimeout(r, 30));

    // Each seq should appear at most once.
    const seqs = received.map((e) => e.seq);
    const uniqueSeqs = new Set(seqs);
    expect(seqs.length).toBe(uniqueSeqs.size);
    await storage.close();
  });

  it("multiple SSE clients receive the same events independently", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    const received1: DomainEvent[] = [];
    const received2: DomainEvent[] = [];

    const stream1 = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received1.push(e),
        onClose: () => {},
      },
    });

    const stream2 = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received2.push(e),
        onClose: () => {},
      },
    });

    const p1 = stream1.start(0);
    const p2 = stream2.start(0);
    await new Promise((r) => setTimeout(r, 20));

    appendEvent(storage, runId, projectId, "run.started", { goal: "test" });
    appendEvent(storage, runId, projectId, "run.completed", { summary: "done" });

    await Promise.all([p1, p2]);

    // Both streams should receive the same events.
    expect(received1.length).toBe(received2.length);
    expect(received1.map((e) => e.seq)).toEqual(received2.map((e) => e.seq));

    stream1.stop();
    stream2.stop();
    await storage.close();
  });

  it("multiple pipelines remain isolated", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId: runId1, projectId: projectId1 } = seedPipeline(storage);

    const projectId2 = newProjectId();
    const runId2 = newRunId();
    storage.projects.insert({ id: projectId2, name: "other", rootPath: "/o", createdAt: new Date().toISOString() });
    storage.pipelineRuns.insert({
      id: runId2, projectId: projectId2, status: "running",
      goal: "other", errorMessage: null, createdAt: new Date().toISOString(),
      finishedAt: null, durationMs: null,
    });

    const received1: DomainEvent[] = [];
    const received2: DomainEvent[] = [];

    const stream1 = new PipelineEventStream({
      storage,
      runId: runId1,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received1.push(e),
        onClose: () => {},
      },
    });

    const stream2 = new PipelineEventStream({
      storage,
      runId: runId2,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received2.push(e),
        onClose: () => {},
      },
    });

    const p1 = stream1.start(0);
    const p2 = stream2.start(0);
    await new Promise((r) => setTimeout(r, 20));

    appendEvent(storage, runId1, projectId1, "run.started", { goal: "pipeline1" });
    appendEvent(storage, runId2, projectId2, "run.started", { goal: "pipeline2" });
    appendEvent(storage, runId1, projectId1, "run.completed", { summary: "done1" });
    appendEvent(storage, runId2, projectId2, "run.completed", { summary: "done2" });

    await Promise.all([p1, p2]);

    expect(received1.every((e) => e.runId === runId1)).toBe(true);
    expect(received2.every((e) => e.runId === runId2)).toBe(true);
    expect(received1.length).toBeGreaterThanOrEqual(2);
    expect(received2.length).toBeGreaterThanOrEqual(2);

    stream1.stop();
    stream2.stop();
    await storage.close();
  });

  it("empty replay for new pipeline with no events yet", async () => {
    const storage = createStorage({ path: join(dataRoot, `sse-${crypto.randomUUID()}.db`) });
    const { runId, projectId } = seedPipeline(storage);

    const received: DomainEvent[] = [];
    const stream = new PipelineEventStream({
      storage,
      runId,
      afterSeq: 0,
      callbacks: {
        onEvent: (e) => received.push(e),
        onClose: () => {},
      },
    });

    // Start with no events. Pipeline is running, so stream stays open.
    const startPromise = stream.start(0);
    await new Promise((r) => setTimeout(r, 20));

    // Should have no events yet.
    expect(received).toHaveLength(0);

    // Now add events.
    const evt = appendEvent(storage, runId, projectId, "run.started", { goal: "t" });
    await new Promise((r) => setTimeout(r, 20));

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]!.seq).toBe(evt.seq);

    // Terminal.
    appendEvent(storage, runId, projectId, "run.completed", { summary: "done" });
    await startPromise;

    await storage.close();
  });
});
