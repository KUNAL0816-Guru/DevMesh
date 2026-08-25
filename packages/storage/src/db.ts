import { DatabaseSync } from "node:sqlite";

/** Typed error for all storage-layer failures. */
export class StorageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: { cause?: unknown; details?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "StorageError";
    this.details = options?.details;
  }
  readonly details?: unknown;
}

export type Database = DatabaseSync;

/** Run `fn` inside BEGIN/COMMIT; rolls back on throw. Not nested. */
export function withTransaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // rollback of a dead transaction must not mask the original error
    }
    throw err;
  }
}

export interface OpenDatabaseOptions {
  /** File path or ':memory:'. Parent directory must exist. */
  path: string;
}

/**
 * Open (creating if needed) and initialize the DevMesh SQLite database:
 * WAL journaling where supported, foreign keys on, busy timeout.
 */
export function openDatabase(opts: OpenDatabaseOptions): Database {
  let db: Database;
  try {
    db = new DatabaseSync(opts.path);
  } catch (err) {
    throw new StorageError("storage/open-failed", `cannot open database at ${opts.path}`, {
      cause: err,
    });
  }

  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    // proot edge cases: fall back to the default rollback journal
    try {
      db.exec("PRAGMA journal_mode = DELETE;");
    } catch {
      /* keep whatever mode applied */
    }
  }
  return db;
}
