import {
  artifactSchema,
  contextEntrySchema,
  parseEvent,
  projectIdSchema,
  taskCardSchema,
  type Artifact,
  type ArtifactId,
  type ArtifactKind,
  type ContextEntry,
  type ContextEntryId,
  type DomainEvent,
  type EventInput,
  type PipelineRunStatus,
  type ProjectId,
  type RunId,
  type TaskCard,
  type TaskId,
} from "@devmesh/contracts";
import { StorageError, type Database } from "./db.js";

// ---------------------------------------------------------------------------
// Row shapes (snake_case DB columns)
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
}

export interface ProjectRecord {
  id: ProjectId;
  name: string;
  rootPath: string;
  createdAt: string;
}

const eventJson = <T>(json: string, what: string): T => {
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new StorageError("storage/corrupt-row", `corrupt ${what} json in database`, {
      cause: err,
    });
  }
};

function rowToProject(r: ProjectRow): ProjectRecord {
  return {
    id: projectIdSchema.parse(r.id),
    name: r.name,
    rootPath: r.root_path,
    createdAt: r.created_at,
  };
}

function rowToTask(r: Record<string, unknown>): TaskCard {
  const raw = r as {
    id: string;
    run_id: string;
    project_id: string;
    role: string;
    title: string;
    detail: string;
    acceptance_criteria: string;
    depends_on: string;
    status: string;
    attempts: number;
    max_attempts: number;
    created_at: string;
    updated_at: string;
    artifacts: string;
  };
  return taskCardSchema.parse({
    id: raw.id,
    runId: raw.run_id,
    projectId: raw.project_id,
    role: raw.role,
    title: raw.title,
    detail: raw.detail,
    acceptanceCriteria: eventJson<string[]>(raw.acceptance_criteria, "task"),
    dependsOn: eventJson<string[]>(raw.depends_on, "task"),
    status: raw.status,
    attempts: Number(raw.attempts),
    maxAttempts: Number(raw.max_attempts),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    artifacts: eventJson<string[]>(raw.artifacts, "task"),
  });
}

function rowToArtifact(r: { payload: string }): Artifact {
  return artifactSchema.parse(eventJson<unknown>(r.payload, "artifact"));
}

function rowToEvent(r: { payload: string; seq: number | bigint }): DomainEvent {
  const evt = parseEvent(eventJson<unknown>(r.payload, "event"));
  return { ...evt, seq: Number(r.seq) };
}

type ContextRow = {
  id: string;
  namespace: string;
  key: string;
  value: string;
  created_by: string;
  created_at: string;
  supersedes: string | null;
};

const CONTEXT_COLUMNS =
  "id, namespace, key, value, created_by, created_at, supersedes";

function rowToContextEntry(r: ContextRow): ContextEntry {
  return contextEntrySchema.parse({
    id: r.id,
    namespace: r.namespace,
    key: r.key,
    value: eventJson<unknown>(r.value, "context entry"),
    createdBy: r.created_by,
    createdAt: r.created_at,
    supersedes: r.supersedes ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  insert(p: ProjectRecord): void {
    projectIdSchema.parse(p.id);
    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(p.id, p.name, p.rootPath, p.createdAt);
  }

  get(id: ProjectId): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : null;
  }

  findByName(name: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as
      | ProjectRow
      | undefined;
    return row ? rowToProject(row) : null;
  }

  list(): ProjectRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY created_at")
      .all() as unknown as ProjectRow[];
    return rows.map(rowToProject);
  }
}

export class TaskRepository {
  constructor(private readonly db: Database) {}

  insert(card: TaskCard): void {
    const c = taskCardSchema.parse(card);
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, run_id, project_id, role, title, detail,
           acceptance_criteria, depends_on, status,
           attempts, max_attempts, created_at, updated_at, artifacts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id,
        c.runId,
        c.projectId,
        c.role,
        c.title,
        c.detail,
        JSON.stringify(c.acceptanceCriteria),
        JSON.stringify(c.dependsOn),
        c.status,
        c.attempts,
        c.maxAttempts,
        c.createdAt,
        c.updatedAt,
        JSON.stringify(c.artifacts),
      );
  }

  update(card: TaskCard): void {
    const c = taskCardSchema.parse(card);
    const res = this.db
      .prepare(
        `UPDATE tasks SET
           role = ?, title = ?, detail = ?,
           acceptance_criteria = ?, depends_on = ?, status = ?,
           attempts = ?, max_attempts = ?, updated_at = ?, artifacts = ?
         WHERE id = ?`,
      )
      .run(
        c.role,
        c.title,
        c.detail,
        JSON.stringify(c.acceptanceCriteria),
        JSON.stringify(c.dependsOn),
        c.status,
        c.attempts,
        c.maxAttempts,
        c.updatedAt,
        JSON.stringify(c.artifacts),
        c.id,
      );
    if (Number(res.changes) === 0) {
      throw new StorageError("storage/not-found", `task ${c.id} does not exist`);
    }
  }

  get(id: TaskId): TaskCard | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTask(row) : null;
  }

  listByRun(runId: RunId): TaskCard[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at")
      .all(runId) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  listByProject(projectId: ProjectId, limit = 200): TaskCard[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(projectId, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  countByStatus(projectId: ProjectId): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status")
      .all(projectId) as unknown as Array<{ status: string; n: number | bigint }>;
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }
}

export class EventRepository {
  constructor(private readonly db: Database) {}

  /** Append a validated event; returns the event with its assigned seq. */
  append(event: EventInput): DomainEvent {
    const evt = parseEvent({ ...event, seq: 0 });
    const res = this.db
      .prepare(
        `INSERT INTO events (ts, type, run_id, project_id, actor, payload)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(evt.ts, evt.type, evt.runId ?? null, evt.projectId ?? null, evt.actor ?? null, JSON.stringify(evt));
    const seq = Number(res.lastInsertRowid);
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw new StorageError("storage/insert-failed", `event append returned invalid seq ${seq}`);
    }
    return { ...evt, seq };
  }

  /** Events with seq strictly greater than `afterSeq`, ascending. */
  listAfter(afterSeq: number, limit = 500): DomainEvent[] {
    const rows = this.db
      .prepare("SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(afterSeq, limit) as unknown as Array<{ seq: number | bigint; payload: string }>;
    return rows.map(rowToEvent);
  }

  latestSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS m FROM events").get() as
      | { m?: number | bigint | null }
      | undefined;
    return Number(row?.m ?? 0);
  }

  listByRun(runId: RunId, limit = 1000): DomainEvent[] {
    const rows = this.db
      .prepare("SELECT seq, payload FROM events WHERE run_id = ? ORDER BY seq LIMIT ?")
      .all(runId, limit) as unknown as Array<{ seq: number | bigint; payload: string }>;
    return rows.map(rowToEvent);
  }

  /** Events for a specific run with seq strictly greater than `afterSeq`. */
  listByRunAfter(runId: RunId, afterSeq: number, limit = 100): DomainEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, payload FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(runId, afterSeq, limit) as unknown as Array<{
      seq: number | bigint;
      payload: string;
    }>;
    return rows.map(rowToEvent);
  }
}

export class ArtifactRepository {
  constructor(private readonly db: Database) {}

  insert(artifact: Artifact): void {
    const a = artifactSchema.parse(artifact);
    this.db
      .prepare(
        `INSERT INTO artifacts (
           id, kind, schema_version, run_id, project_id, task_id,
           produced_by, created_at, payload
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.kind,
        a.schemaVersion,
        a.runId,
        a.projectId,
        a.taskId ?? null,
        a.producedBy,
        a.createdAt,
        JSON.stringify(a),
      );
  }

  get(id: ArtifactId): Artifact | null {
    const row = this.db.prepare("SELECT payload FROM artifacts WHERE id = ?").get(id) as
      | { payload: string }
      | undefined;
    return row ? rowToArtifact(row) : null;
  }

  listByRun(runId: RunId, kind?: ArtifactKind): Artifact[] {
    const rows = (
      kind
        ? this.db
            .prepare(
              "SELECT payload FROM artifacts WHERE run_id = ? AND kind = ? ORDER BY created_at",
            )
            .all(runId, kind)
        : this.db
            .prepare("SELECT payload FROM artifacts WHERE run_id = ? ORDER BY created_at")
            .all(runId)
    ) as unknown as Array<{ payload: string }>;
    return rows.map(rowToArtifact);
  }

  listByProject(projectId: string, kind?: ArtifactKind): Artifact[] {
    const rows = (
      kind
        ? this.db
            .prepare(
              "SELECT payload FROM artifacts WHERE project_id = ? AND kind = ? ORDER BY created_at",
            )
            .all(projectId, kind)
        : this.db
            .prepare("SELECT payload FROM artifacts WHERE project_id = ? ORDER BY created_at")
            .all(projectId)
    ) as unknown as Array<{ payload: string }>;
    return rows.map(rowToArtifact);
  }
}

export class ContextRepository {
  constructor(private readonly db: Database) {}

  put(entry: ContextEntry): void {
    const e = contextEntrySchema.parse(entry);
    this.db
      .prepare(
        `INSERT INTO context_entries (id, namespace, key, value, created_by, created_at, supersedes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.namespace, e.key, JSON.stringify(e.value), e.createdBy, e.createdAt, e.supersedes ?? null);
  }

  get(id: ContextEntryId): ContextEntry | null {
    const row = this.db
      .prepare(`SELECT ${CONTEXT_COLUMNS} FROM context_entries WHERE id = ?`)
      .get(id) as unknown as ContextRow | undefined;
    return row ? rowToContextEntry(row) : null;
  }

  /** Latest entry per key within a namespace (superseded entries ignored). */
  latestByKey(namespace: string): Map<string, ContextEntry> {
    const rows = this.db
      .prepare(
        `SELECT ${CONTEXT_COLUMNS} FROM context_entries
         WHERE namespace = ?
           AND id NOT IN (SELECT supersedes FROM context_entries WHERE supersedes IS NOT NULL)
         ORDER BY created_at`,
      )
      .all(namespace) as unknown as ContextRow[];
    const map = new Map<string, ContextEntry>();
    for (const row of rows) {
      const entry = rowToContextEntry(row);
      map.set(entry.key, entry);
    }
    return map;
  }

  history(key: string, namespace: string): ContextEntry[] {
    const rows = this.db
      .prepare(
        `SELECT ${CONTEXT_COLUMNS} FROM context_entries WHERE namespace = ? AND key = ? ORDER BY created_at`,
      )
      .all(namespace, key) as unknown as ContextRow[];
    return rows.map(rowToContextEntry);
  }
}

// ---------------------------------------------------------------------------
// Executions (agent runs through a pluggable runtime)
// ---------------------------------------------------------------------------

export const executionStatuses = [
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
] as const;
export type ExecutionRowStatus = (typeof executionStatuses)[number];

export interface ExecutionRecord {
  id: string;
  runId: string;
  projectId: string;
  taskId: string | null;
  /** Agent definition id that drove this execution (e.g. "developer"). */
  agentId: string | null;
  role: string;
  runtime: string;
  status: ExecutionRowStatus;
  /**
   * Coarse failure classification (see classifyFailure in the server
   * package); null while running or on clean completion.
   */
  failureKind: string | null;
  instruction: string;
  sessionRef: string | null;
  exitCode: number | null;
  stoppedReason: string | null;
  errorMessage: string | null;
  stdoutTail: string | null;
  stderrTail: string | null;
  replyText: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  resultArtifactId: string | null;
  verificationArtifactId: string | null;
}

interface ExecutionRow {
  id: string;
  run_id: string;
  project_id: string;
  task_id: string | null;
  agent_id: string | null;
  role: string;
  runtime: string;
  status: string;
  failure_kind: string | null;
  instruction: string;
  session_ref: string | null;
  exit_code: number | null;
  stopped_reason: string | null;
  error_message: string | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
  reply_text: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  result_artifact_id: string | null;
  verification_artifact_id: string | null;
}

const EXECUTION_COLUMNS =
  "id, run_id, project_id, task_id, agent_id, role, runtime, status, " +
  "failure_kind, instruction, session_ref, exit_code, stopped_reason, " +
  "error_message, stdout_tail, stderr_tail, reply_text, started_at, finished_at, " +
  "duration_ms, result_artifact_id, verification_artifact_id";

function rowToExecution(r: ExecutionRow): ExecutionRecord {
  return {
    id: r.id,
    runId: r.run_id,
    projectId: r.project_id,
    taskId: r.task_id,
    agentId: r.agent_id,
    role: r.role,
    runtime: r.runtime,
    status: r.status as ExecutionRowStatus,
    failureKind: r.failure_kind,
    instruction: r.instruction,
    sessionRef: r.session_ref,
    exitCode: r.exit_code === null ? null : Number(r.exit_code),
    stoppedReason: r.stopped_reason,
    errorMessage: r.error_message,
    stdoutTail: r.stdout_tail,
    stderrTail: r.stderr_tail,
    replyText: r.reply_text,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    resultArtifactId: r.result_artifact_id,
    verificationArtifactId: r.verification_artifact_id,
  };
}

export class ExecutionRepository {
  constructor(private readonly db: Database) {}

  insert(rec: Omit<ExecutionRecord, "id"> & { id?: string }): ExecutionRecord {
    const row: ExecutionRecord = { id: rec.id ?? crypto.randomUUID(), ...rec } as ExecutionRecord;
    this.db
      .prepare(
        `INSERT INTO executions (
           id, run_id, project_id, task_id, agent_id, role, runtime, status,
           failure_kind, instruction, session_ref, exit_code, stopped_reason,
           error_message, stdout_tail, stderr_tail, reply_text, started_at, finished_at,
           duration_ms, result_artifact_id, verification_artifact_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.runId,
        row.projectId,
        row.taskId,
        row.agentId,
        row.role,
        row.runtime,
        row.status,
        row.failureKind,
        row.instruction,
        row.sessionRef,
        row.exitCode,
        row.stoppedReason,
        row.errorMessage,
        row.stdoutTail,
        row.stderrTail,
        row.replyText,
        row.startedAt,
        row.finishedAt,
        row.durationMs,
        row.resultArtifactId,
        row.verificationArtifactId,
      );
    return row;
  }

  update(rec: ExecutionRecord): void {
    const res = this.db
      .prepare(
        `UPDATE executions SET
           run_id = ?, project_id = ?, task_id = ?, agent_id = ?, role = ?,
           runtime = ?, status = ?, failure_kind = ?, instruction = ?,
           session_ref = ?, exit_code = ?, stopped_reason = ?, error_message = ?,
           stdout_tail = ?, stderr_tail = ?, reply_text = ?, started_at = ?, finished_at = ?,
           duration_ms = ?, result_artifact_id = ?, verification_artifact_id = ?
         WHERE id = ?`,
      )
      .run(
        rec.runId,
        rec.projectId,
        rec.taskId,
        rec.agentId,
        rec.role,
        rec.runtime,
        rec.status,
        rec.failureKind,
        rec.instruction,
        rec.sessionRef,
        rec.exitCode,
        rec.stoppedReason,
        rec.errorMessage,
        rec.stdoutTail,
        rec.stderrTail,
        rec.replyText,
        rec.startedAt,
        rec.finishedAt,
        rec.durationMs,
        rec.resultArtifactId,
        rec.verificationArtifactId,
        rec.id,
      );
    if (Number(res.changes) === 0) {
      throw new StorageError("storage/not-found", `execution ${rec.id} does not exist`);
    }
  }

  get(id: string): ExecutionRecord | null {
    const row = this.db
      .prepare(`SELECT ${EXECUTION_COLUMNS} FROM executions WHERE id = ?`)
      .get(id) as unknown as ExecutionRow | undefined;
    return row ? rowToExecution(row) : null;
  }

  listByProject(projectId: string, limit = 100): ExecutionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE project_id = ?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as unknown as Array<Record<string, unknown>>;
    return (rows as unknown as ExecutionRow[]).map(rowToExecution);
  }

  /** Rows still marked pending/running — evidence of an interrupted process. */
  findUnfinished(): ExecutionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${EXECUTION_COLUMNS} FROM executions
         WHERE status IN ('pending', 'running')`,
      )
      .all() as unknown as ExecutionRow[];
    return rows.map(rowToExecution);
  }

  /**
   * Restart reconciliation: any execution left pending/running by a dead
   * process is marked `interrupted`. Returns the reconciled records.
   */
  reconcileInterrupted(finishedAt: string): ExecutionRecord[] {
    const unfinished = this.findUnfinished();
    for (const rec of unfinished) {
      this.update({
        ...rec,
        status: "interrupted",
        finishedAt,
        errorMessage:
          rec.errorMessage ?? "DevMesh restarted while this execution was in flight",
      });
    }
    return unfinished.map((r) => ({ ...r, status: "interrupted" as const }));
  }
}

// ---------------------------------------------------------------------------
// RevisionCycleRepository
// ---------------------------------------------------------------------------

export interface RevisionCycleRecord {
  id: string;
  runId: RunId;
  projectId: ProjectId;
  taskId: TaskId;
  cycleType: "tester_failure" | "reviewer_rejection";
  attemptNumber: number;
  failureKind: string | null;
  failureSignature: string | null;
  createdAt: string;
}

interface RevisionCycleRow {
  id: string;
  run_id: string;
  project_id: string;
  task_id: string;
  cycle_type: string;
  attempt_number: number;
  failure_kind: string | null;
  failure_signature: string | null;
  created_at: string;
}

const RC_COLUMNS =
  "id, run_id, project_id, task_id, cycle_type, attempt_number, failure_kind, failure_signature, created_at";

function rowToRevisionCycle(row: RevisionCycleRow): RevisionCycleRecord {
  return {
    id: row.id,
    runId: row.run_id as RunId,
    projectId: row.project_id as ProjectId,
    taskId: row.task_id as TaskId,
    cycleType: row.cycle_type as RevisionCycleRecord["cycleType"],
    attemptNumber: row.attempt_number,
    failureKind: row.failure_kind,
    failureSignature: row.failure_signature,
    createdAt: row.created_at,
  };
}

export class RevisionCycleRepository {
  constructor(private readonly db: Database) {}

  insert(
    rec: Omit<RevisionCycleRecord, "id" | "createdAt"> & { id?: string },
  ): RevisionCycleRecord {
    const id = rec.id ?? crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO revision_cycles
         (id, run_id, project_id, task_id, cycle_type, attempt_number,
          failure_kind, failure_signature, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        rec.runId,
        rec.projectId,
        rec.taskId,
        rec.cycleType,
        rec.attemptNumber,
        rec.failureKind ?? null,
        rec.failureSignature ?? null,
        createdAt,
      );
    return { ...rec, id: id as string, createdAt } as RevisionCycleRecord;
  }

  listByTask(taskId: string, limit = 50): RevisionCycleRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${RC_COLUMNS} FROM revision_cycles
         WHERE task_id = ? ORDER BY attempt_number DESC LIMIT ?`,
      )
      .all(taskId, limit) as unknown as RevisionCycleRow[];
    return rows.map(rowToRevisionCycle);
  }

  listByRun(runId: string, limit = 100): RevisionCycleRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${RC_COLUMNS} FROM revision_cycles
         WHERE run_id = ? ORDER BY attempt_number ASC LIMIT ?`,
      )
      .all(runId, limit) as unknown as RevisionCycleRow[];
    return rows.map(rowToRevisionCycle);
  }

  /** Count failures with a given signature for a task (for doom-loop detection). */
  countBySignature(taskId: string, failureSignature: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM revision_cycles
         WHERE task_id = ? AND failure_signature = ?`,
      )
      .get(taskId, failureSignature) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  listByFailureKind(failureKind: string, projectId?: string, limit = 100): RevisionCycleRecord[] {
    let query = `SELECT ${RC_COLUMNS} FROM revision_cycles WHERE failure_kind = ?`;
    const params: (string | number)[] = [failureKind];
    if (projectId) {
      query += ` AND project_id = ?`;
      params.push(projectId);
    }
    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(query).all(...params) as unknown as RevisionCycleRow[];
    return rows.map(rowToRevisionCycle);
  }
}

// ---------------------------------------------------------------------------
// PipelineRunRepository
// ---------------------------------------------------------------------------

export interface PipelineRunRecord {
  id: string;
  projectId: string;
  status: PipelineRunStatus;
  goal: string;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

interface PipelineRunRow {
  id: string;
  project_id: string;
  status: string;
  goal: string;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

const PR_COLUMNS =
  "id, project_id, status, goal, error_message, created_at, finished_at, duration_ms";

function rowToPipelineRun(row: PipelineRunRow): PipelineRunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status as PipelineRunStatus,
    goal: row.goal,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  };
}

export class PipelineRunRepository {
  constructor(private readonly db: Database) {}

  insert(rec: PipelineRunRecord): PipelineRunRecord {
    this.db
      .prepare(
        `INSERT INTO pipeline_runs
         (id, project_id, status, goal, error_message, created_at, finished_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.projectId,
        rec.status,
        rec.goal,
        rec.errorMessage ?? null,
        rec.createdAt,
        rec.finishedAt ?? null,
        rec.durationMs ?? null,
      );
    return rec;
  }

  update(rec: PipelineRunRecord): void {
    const res = this.db
      .prepare(
        `UPDATE pipeline_runs SET
           status = ?, error_message = ?, finished_at = ?, duration_ms = ?
         WHERE id = ?`,
      )
      .run(
        rec.status,
        rec.errorMessage ?? null,
        rec.finishedAt ?? null,
        rec.durationMs ?? null,
        rec.id,
      );
    if (Number(res.changes) === 0) {
      throw new StorageError("storage/not-found", `pipeline run ${rec.id} does not exist`);
    }
  }

  get(id: string): PipelineRunRecord | null {
    const row = this.db
      .prepare(`SELECT ${PR_COLUMNS} FROM pipeline_runs WHERE id = ?`)
      .get(id) as unknown as PipelineRunRow | undefined;
    return row ? rowToPipelineRun(row) : null;
  }

  listByProject(projectId: string, limit = 100): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${PR_COLUMNS} FROM pipeline_runs WHERE project_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as unknown as PipelineRunRow[];
    return rows.map(rowToPipelineRun);
  }

  findRunning(): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${PR_COLUMNS} FROM pipeline_runs WHERE status = 'running'`,
      )
      .all() as unknown as PipelineRunRow[];
    return rows.map(rowToPipelineRun);
  }
}
