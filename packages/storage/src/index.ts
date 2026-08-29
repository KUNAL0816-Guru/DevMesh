import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase, type Database } from "./db.js";
import { migrate } from "./migrations.js";
import { EventBus } from "./event-bus.js";
import {
  ArtifactRepository,
  ContextRepository,
  EventRepository,
  ExecutionRepository,
  PipelineRunRepository,
  ProjectRepository,
  RevisionCycleRepository,
  StageRepository,
  TaskRepository,
} from "./repos.js";

export interface Storage {
  readonly db: Database;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly events: EventRepository;
  readonly artifacts: ArtifactRepository;
  readonly context: ContextRepository;
  readonly executions: ExecutionRepository;
  readonly revisionCycles: RevisionCycleRepository;
  readonly pipelineRuns: PipelineRunRepository;
  readonly stages: StageRepository;
  /** In-process event bus for SSE fan-out (fires AFTER SQLite persist). */
  readonly eventBus: EventBus;
  /** Applied schema version. */
  readonly schemaVersion: number;
  /** Flush WAL and close; safe to call once. */
  close(): void;
}

export interface CreateStorageOptions {
  /** File path for the SQLite database (created if missing) or ':memory:'. */
  path: string;
}

export type { ExecutionRecord, ExecutionRowStatus, ExecutionUsage, PipelineRunRecord, PipelineRunSummary, PipelineHealth, RevisionCycleRecord, ConsistencyViolation, StageRecord, StageStatus } from "./repos.js";
export { pipelineRunSummary, pipelineHealth, assertPipelineConsistency } from "./repos.js";
export { EventBus } from "./event-bus.js";

/**
 * Open the DevMesh control-plane database and apply pending migrations.
 * Persistent state survives process termination (WAL checkpointed on close).
 */
export function createStorage(opts: CreateStorageOptions): Storage {
  if (opts.path !== ":memory:") {
    mkdirSync(dirname(resolve(opts.path)), { recursive: true });
  }
  const db = openDatabase({ path: opts.path });
  const schemaVersion = migrate(db);
  const eventBus = new EventBus();
  const events = new EventRepository(db);
  events.attachBus(eventBus);

  return {
    db,
    schemaVersion,
    projects: new ProjectRepository(db),
    tasks: new TaskRepository(db),
    events,
    artifacts: new ArtifactRepository(db),
    context: new ContextRepository(db),
    executions: new ExecutionRepository(db),
    revisionCycles: new RevisionCycleRepository(db),
    pipelineRuns: new PipelineRunRepository(db),
    stages: new StageRepository(db),
    eventBus,
    close(): void {
      try {
        // best-effort WAL checkpoint so all state lands in the main file
        db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        /* ignore — close() must not throw over checkpointing */
      }
      db.close();
    },
  };
}
