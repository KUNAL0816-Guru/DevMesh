import type { DatabaseSync } from "node:sqlite";
import { StorageError, withTransaction } from "./db.js";

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: readonly string[];
}

/**
 * Ordered, append-only migration list. Never edit an applied migration;
 * add a new one and bump the list.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial-control-plane",
    up: [
      `CREATE TABLE projects (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         root_path TEXT NOT NULL UNIQUE,
         created_at TEXT NOT NULL
       );`,
      `CREATE TABLE tasks (
         id TEXT PRIMARY KEY,
         run_id TEXT NOT NULL,
         project_id TEXT NOT NULL REFERENCES projects(id),
         role TEXT NOT NULL,
         title TEXT NOT NULL,
         detail TEXT NOT NULL,
         acceptance_criteria TEXT NOT NULL, -- json string[]
         depends_on TEXT NOT NULL,          -- json taskId[]
         status TEXT NOT NULL,
         attempts INTEGER NOT NULL DEFAULT 0,
         max_attempts INTEGER NOT NULL DEFAULT 3,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         artifacts TEXT NOT NULL            -- json artifactId[]
       );
       CREATE INDEX idx_tasks_run ON tasks(run_id);
       CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);`,
      `CREATE TABLE events (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         ts TEXT NOT NULL,
         type TEXT NOT NULL,
         run_id TEXT,
         project_id TEXT,
         actor TEXT,
         payload TEXT NOT NULL              -- full validated event json
       );
       CREATE INDEX idx_events_run ON events(run_id);
       CREATE INDEX idx_events_project ON events(project_id);`,
      `CREATE TABLE artifacts (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         schema_version INTEGER NOT NULL,
         run_id TEXT NOT NULL,
         project_id TEXT NOT NULL REFERENCES projects(id),
         task_id TEXT,
         produced_by TEXT NOT NULL,
         created_at TEXT NOT NULL,
         payload TEXT NOT NULL              -- full validated artifact json
       );
       CREATE INDEX idx_artifacts_run ON artifacts(run_id);
       CREATE INDEX idx_artifacts_kind ON artifacts(kind);`,
      `CREATE TABLE context_entries (
         id TEXT PRIMARY KEY,
         namespace TEXT NOT NULL,
         key TEXT NOT NULL,
         value TEXT NOT NULL,               -- json
         created_by TEXT NOT NULL,
         created_at TEXT NOT NULL,
         supersedes TEXT
       );
       CREATE INDEX idx_context_ns_key ON context_entries(namespace, key, created_at);`,
    ],
  },
  {
    version: 2,
    name: "agent-executions",
    up: [
      `CREATE TABLE executions (
         id TEXT PRIMARY KEY,
         run_id TEXT NOT NULL,
         project_id TEXT NOT NULL REFERENCES projects(id),
         task_id TEXT,
         role TEXT NOT NULL,
         runtime TEXT NOT NULL,
         status TEXT NOT NULL,
           -- pending | running | completed | failed | timeout | cancelled
           -- | interrupted (detected after restart)
         instruction TEXT NOT NULL,
         session_ref TEXT,                 -- runtime-native session id
         exit_code INTEGER,
         stopped_reason TEXT,
         error_message TEXT,
         stdout_tail TEXT,
         stderr_tail TEXT,
         started_at TEXT NOT NULL,
         finished_at TEXT,
         duration_ms INTEGER,
         result_artifact_id TEXT,
         verification_artifact_id TEXT
       );
       CREATE INDEX idx_executions_project ON executions(project_id, started_at);
       CREATE INDEX idx_executions_status ON executions(status);`,
    ],
  },
  {
    version: 3,
    name: "execution-agent-attribution",
    up: [
      `ALTER TABLE executions ADD COLUMN agent_id TEXT;`,
      `ALTER TABLE executions ADD COLUMN failure_kind TEXT;
       -- null while running/ok | provider_failure | process_failure |
       -- timeout | cancelled | invalid_output | verification_failed |
       -- task_failed | internal
       CREATE INDEX idx_executions_failure ON executions(failure_kind);`,
    ],
  },
  {
    version: 4,
    name: "execution-reply-text",
    up: [
      `ALTER TABLE executions ADD COLUMN reply_text TEXT;`,
    ],
  },
];

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version;").get() as
    | { user_version?: number | null }
    | undefined;
  return row?.user_version ?? 0;
}

function setVersion(db: DatabaseSync, version: number): void {
  db.prepare(`PRAGMA user_version = ${Number(version)};`).run();
}

/** Apply all pending migrations in order, each in its own transaction.
 *  Returns the resulting schema version. */
export function migrate(db: DatabaseSync): number {
  let from = currentVersion(db);

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    try {
      withTransaction(db, () => {
        for (const stmt of m.up) db.exec(stmt);
        setVersion(db, m.version);
      });
      from = m.version;
    } catch (err) {
      throw new StorageError(
        "storage/migration-failed",
        `migration ${m.version} (${m.name}) failed`,
        { cause: err },
      );
    }
  }
  return from;
}
