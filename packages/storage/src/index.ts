import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase, type Database } from "./db.js";
import { migrate } from "./migrations.js";
import {
  ArtifactRepository,
  ContextRepository,
  EventRepository,
  ExecutionRepository,
  ProjectRepository,
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
  /** Applied schema version. */
  readonly schemaVersion: number;
  /** Flush WAL and close; safe to call once. */
  close(): void;
}

export interface CreateStorageOptions {
  /** File path for the SQLite database (created if missing) or ':memory:'. */
  path: string;
}

export type { ExecutionRecord, ExecutionRowStatus } from "./repos.js";

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

  return {
    db,
    schemaVersion,
    projects: new ProjectRepository(db),
    tasks: new TaskRepository(db),
    events: new EventRepository(db),
    artifacts: new ArtifactRepository(db),
    context: new ContextRepository(db),
    executions: new ExecutionRepository(db),
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
