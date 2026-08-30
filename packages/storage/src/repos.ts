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
import type { EventBus } from "./event-bus.js";

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
  private bus: EventBus | null = null;

  constructor(private readonly db: Database) {}

  /** Attach an in-process event bus for SSE fan-out (optional). */
  attachBus(bus: EventBus): void {
    this.bus = bus;
  }

  /** Detach the in-process event bus; events will no longer be emitted. */
  detachBus(): void {
    this.bus = null;
  }

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
    const persisted = { ...evt, seq };
    // Notify in-process subscribers AFTER SQLite persist (SQLite is source of truth).
    this.bus?.emitEvent(persisted);
    return persisted;
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

  /** Latest entry per key across all namespaces (superseded entries ignored). */
  latestAll(): Map<string, ContextEntry> {
    const rows = this.db
      .prepare(
        `SELECT ${CONTEXT_COLUMNS} FROM context_entries
         WHERE id NOT IN (SELECT supersedes FROM context_entries WHERE supersedes IS NOT NULL)
         ORDER BY namespace, created_at`,
      )
      .all() as unknown as ContextRow[];
    const map = new Map<string, ContextEntry>();
    for (const row of rows) {
      const entry = rowToContextEntry(row);
      map.set(`${entry.namespace}:${entry.key}`, entry);
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

export interface ExecutionUsage {
  /**
   * Token usage reported by the runtime adapter. Null when the runtime
   * could not measure — never a fabricated or estimated number.
   */
  inputTokens: number | null;
  outputTokens: number | null;
  /** Nominal cost in micro-USD; null until a pricing rule exists (Phase 8C). */
  costUsdMicros: number | null;
  /** ISO 4217 currency code (default "USD"); null while cost is unknown. */
  currency: string | null;
  /**
   * How cost was obtained: "reported" (runtime supplied) | "derived"
   * (computed by DevMesh from config pricing) | null (tokens only).
   */
  usageSource: "reported" | "derived" | null;
}

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
  /** Parsed structured JSON output from the agent (outputFormat), or null. */
  structured: unknown;
  /**
   * Token/cost usage. Null when nothing was measured — an old row and a
   * clean-zero report are NOT the same thing.
   */
  usage: ExecutionUsage | null;
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
  structured: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd_micros: number | null;
  cost_currency: string | null;
  usage_source: string | null;
}

const EXECUTION_COLUMNS =
  "id, run_id, project_id, task_id, agent_id, role, runtime, status, " +
  "failure_kind, instruction, session_ref, exit_code, stopped_reason, " +
  "error_message, stdout_tail, stderr_tail, reply_text, started_at, finished_at, " +
  "duration_ms, result_artifact_id, verification_artifact_id, structured, " +
  "input_tokens, output_tokens, cost_usd_micros, cost_currency, usage_source";

/** Parse a stored JSON structured value; malformed JSON degrades to null. */
function parseStructured(raw: string | null): unknown {
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rowToExecution(r: ExecutionRow): ExecutionRecord {
  const measuredUsage =
    r.input_tokens !== null || r.output_tokens !== null || r.cost_usd_micros !== null;
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
    structured: parseStructured(r.structured),
    usage: measuredUsage
      ? {
          inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
          outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
          costUsdMicros: r.cost_usd_micros === null ? null : Number(r.cost_usd_micros),
          currency: r.cost_currency,
          usageSource:
            r.usage_source === "reported" || r.usage_source === "derived"
              ? r.usage_source
              : null,
        }
      : null,
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
           duration_ms, result_artifact_id, verification_artifact_id, structured,
           input_tokens, output_tokens, cost_usd_micros, cost_currency, usage_source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.structured === null || row.structured === undefined
          ? null
          : JSON.stringify(row.structured),
        row.usage?.inputTokens ?? null,
        row.usage?.outputTokens ?? null,
        row.usage?.costUsdMicros ?? null,
        row.usage?.currency ?? null,
        row.usage?.usageSource ?? null,
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
           duration_ms = ?, result_artifact_id = ?, verification_artifact_id = ?, structured = ?,
           input_tokens = ?, output_tokens = ?, cost_usd_micros = ?, cost_currency = ?, usage_source = ?
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
        rec.structured === null || rec.structured === undefined
          ? null
          : JSON.stringify(rec.structured),
        rec.usage?.inputTokens ?? null,
        rec.usage?.outputTokens ?? null,
        rec.usage?.costUsdMicros ?? null,
        rec.usage?.currency ?? null,
        rec.usage?.usageSource ?? null,
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

  listByRun(runId: string, limit = 100): ExecutionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE run_id = ?
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(runId, limit) as unknown as ExecutionRow[];
    return rows.map(rowToExecution);
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

// ---------------------------------------------------------------------------
// PipelineStageRepository
// ---------------------------------------------------------------------------

export const stageStatuses = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type StageStatus = (typeof stageStatuses)[number];

export interface StageRecord {
  id: string;
  runId: string;
  projectId: string;
  stageIndex: number;
  stageRole: string;
  status: StageStatus;
  executionId: string | null;
  taskId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface StageRow {
  id: string;
  run_id: string;
  project_id: string;
  stage_index: number;
  stage_role: string;
  status: string;
  execution_id: string | null;
  task_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

const STAGE_COLUMNS =
  "id, run_id, project_id, stage_index, stage_role, status, " +
  "execution_id, task_id, started_at, completed_at, created_at";

function rowToStage(row: StageRow): StageRecord {
  return {
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id,
    stageIndex: row.stage_index,
    stageRole: row.stage_role,
    status: row.status as StageStatus,
    executionId: row.execution_id,
    taskId: row.task_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

export class StageRepository {
  constructor(private readonly db: Database) {}

  insert(rec: StageRecord): StageRecord {
    this.db
      .prepare(
        `INSERT INTO pipeline_stages
         (id, run_id, project_id, stage_index, stage_role, status,
          execution_id, task_id, started_at, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.runId,
        rec.projectId,
        rec.stageIndex,
        rec.stageRole,
        rec.status,
        rec.executionId ?? null,
        rec.taskId ?? null,
        rec.startedAt ?? null,
        rec.completedAt ?? null,
        rec.createdAt,
      );
    return rec;
  }

  update(rec: StageRecord): void {
    const res = this.db
      .prepare(
        `UPDATE pipeline_stages SET
           status = ?, execution_id = ?, task_id = ?,
           started_at = ?, completed_at = ?
         WHERE id = ?`,
      )
      .run(
        rec.status,
        rec.executionId ?? null,
        rec.taskId ?? null,
        rec.startedAt ?? null,
        rec.completedAt ?? null,
        rec.id,
      );
    if (Number(res.changes) === 0) {
      throw new StorageError("storage/not-found", `stage ${rec.id} does not exist`);
    }
  }

  get(id: string): StageRecord | null {
    const row = this.db
      .prepare(`SELECT ${STAGE_COLUMNS} FROM pipeline_stages WHERE id = ?`)
      .get(id) as unknown as StageRow | undefined;
    return row ? rowToStage(row) : null;
  }

  listByRun(runId: string): StageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${STAGE_COLUMNS} FROM pipeline_stages
         WHERE run_id = ? ORDER BY stage_index`,
      )
      .all(runId) as unknown as StageRow[];
    return rows.map(rowToStage);
  }

  /** Return the last stage with status 'completed' for a run, or null. */
  getLastCompleted(runId: string): StageRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${STAGE_COLUMNS} FROM pipeline_stages
         WHERE run_id = ? AND status = 'completed'
         ORDER BY stage_index DESC LIMIT 1`,
      )
      .get(runId) as unknown as StageRow | undefined;
    return row ? rowToStage(row) : null;
  }
}

// ---------------------------------------------------------------------------
// Approvals (Phase 9A) — user-visible approval requests that pause sensitive
// actions. `status` is a small state machine: pending → approved|denied once,
// resolved atomically via a guarded single UPDATE (never double-resolved).
// ---------------------------------------------------------------------------

export const approvalStatuses = ["pending", "approved", "denied"] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

export const approvalDecisions = ["allow", "deny"] as const;
export type ApprovalDecision = (typeof approvalDecisions)[number];

export interface ApprovalRecord {
  id: string;
  projectId: string;
  runId: string;
  taskId: string | null;
  kind: string;
  title: string;
  detail: string;
  risk: "low" | "medium" | "high" | "critical";
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
  decision: ApprovalDecision | null;
  decidedBy: string | null;
}

interface ApprovalRow {
  id: string;
  project_id: string;
  run_id: string;
  task_id: string | null;
  kind: string;
  title: string;
  detail: string;
  risk: string;
  status: string;
  requested_at: string;
  resolved_at: string | null;
  decision: string | null;
  decided_by: string | null;
}

const APPROVAL_COLUMNS =
  "id, project_id, run_id, task_id, kind, title, detail, risk, status, " +
  "requested_at, resolved_at, decision, decided_by";

function rowToApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    taskId: row.task_id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    risk: row.risk as ApprovalRecord["risk"],
    status: row.status as ApprovalStatus,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
    decision: row.decision as ApprovalDecision | null,
    decidedBy: row.decided_by,
  };
}

export class ApprovalRepository {
  constructor(private readonly db: Database) {}

  insert(rec: ApprovalRecord): ApprovalRecord {
    this.db
      .prepare(
        `INSERT INTO approvals
         (id, project_id, run_id, task_id, kind, title, detail, risk, status,
          requested_at, resolved_at, decision, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.projectId,
        rec.runId,
        rec.taskId ?? null,
        rec.kind,
        rec.title,
        rec.detail,
        rec.risk,
        rec.status,
        rec.requestedAt,
        rec.resolvedAt ?? null,
        rec.decision ?? null,
        rec.decidedBy ?? null,
      );
    return rec;
  }

  get(id: string): ApprovalRecord | null {
    const row = this.db
      .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`)
      .get(id) as unknown as ApprovalRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  listByProject(projectId: string, limit = 200): ApprovalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${APPROVAL_COLUMNS} FROM approvals
         WHERE project_id = ? ORDER BY requested_at DESC LIMIT ?`,
      )
      .all(projectId, limit) as unknown as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  listByRun(runId: string, limit = 200): ApprovalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT ${APPROVAL_COLUMNS} FROM approvals
         WHERE run_id = ? ORDER BY requested_at DESC LIMIT ?`,
      )
      .all(runId, limit) as unknown as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  /** List approval requests still awaiting a decision, across all projects or
   *  scoped to a single project. Ordered oldest-first so upstream consumers
   *  see the longest-waiting request first. */
  listPending(projectId?: string): ApprovalRecord[] {
    const rows = projectId
      ? (this.db
          .prepare(
            `SELECT ${APPROVAL_COLUMNS} FROM approvals
             WHERE project_id = ? AND status = 'pending'
             ORDER BY requested_at`,
          )
          .all(projectId) as unknown as ApprovalRow[])
      : (this.db
          .prepare(
            `SELECT ${APPROVAL_COLUMNS} FROM approvals
             WHERE status = 'pending' ORDER BY requested_at`,
          )
          .all() as unknown as ApprovalRow[]);
    return rows.map(rowToApproval);
  }

  /**
   * Atomically transition a pending approval to approved/denied. The single
   * guarded UPDATE (WHERE status = 'pending') is atomic, so concurrent
   * resolutions cannot double-resolve. Throws:
   *  - `storage/not-found` when the id does not exist
   *  - `storage/approval-resolved` when it is already resolved
   * On success returns the updated record.
   */
  resolve(id: string, decision: ApprovalDecision, decidedBy: string): ApprovalRecord {
    const res = this.db
      .prepare(
        `UPDATE approvals SET
           status = ?, decision = ?, decided_by = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(
        decision === "allow" ? "approved" : "denied",
        decision,
        decidedBy,
        new Date().toISOString(),
        id,
      );

    if (Number(res.changes) === 0) {
      const existing = this.get(id);
      if (!existing) {
        throw new StorageError("storage/not-found", `approval ${id} does not exist`);
      }
      throw new StorageError(
        "storage/approval-resolved",
        `approval ${id} is already resolved as "${existing.status}"`,
      );
    }
    return this.get(id)!;
  }
}

// ---------------------------------------------------------------------------
// Diagnostic queries (read-only, no new tables)
// ---------------------------------------------------------------------------

export interface PipelineRunSummary {
  id: string;
  projectId: string;
  status: PipelineRunStatus;
  goal: string;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  eventCount: number;
  executionCount: number;
  artifactCount: number;
  stageTimings: Array<{
    executionId: string;
    role: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
  }>;
}

/**
 * Returns stage timings, total duration, event count, artifact count for
 * a specific run. Read-only diagnostic; does not introduce new tables.
 */
export function pipelineRunSummary(db: Database, runId: string): PipelineRunSummary | null {
  const row = db
    .prepare(`SELECT ${PR_COLUMNS} FROM pipeline_runs WHERE id = ?`)
    .get(runId) as unknown as PipelineRunRow | undefined;
  if (!row) return null;

  const eventCountRow = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ?")
    .get(runId) as { n: number | bigint } | undefined;

  const executionRows = db
    .prepare(
      `SELECT id, role, status, started_at, finished_at, duration_ms
       FROM executions WHERE run_id = ? ORDER BY started_at`,
    )
    .all(runId) as unknown as Array<{
    id: string;
    role: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    duration_ms: number | bigint | null;
  }>;

  const artifactCountRow = db
    .prepare("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ?")
    .get(runId) as { n: number | bigint } | undefined;

  return {
    ...rowToPipelineRun(row),
    eventCount: Number(eventCountRow?.n ?? 0),
    executionCount: executionRows.length,
    artifactCount: Number(artifactCountRow?.n ?? 0),
    stageTimings: executionRows.map((r) => ({
      executionId: r.id,
      role: r.role,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    })),
  };
}

export interface PipelineHealth {
  projectId: string;
  totalRuns: number;
  statusCounts: Record<string, number>;
  averageDurationMs: number | null;
  failureRate: number;
}

/**
 * Returns counts of runs by status, average duration, failure rate for a
 * project. Read-only diagnostic; does not introduce new tables.
 */
export function pipelineHealth(db: Database, projectId: string): PipelineHealth {
  const allRuns = db
    .prepare(`SELECT ${PR_COLUMNS} FROM pipeline_runs WHERE project_id = ?`)
    .all(projectId) as unknown as PipelineRunRow[];

  const statusCounts: Record<string, number> = {};
  let totalDuration = 0;
  let durationCount = 0;
  let terminalCount = 0;
  let failureCount = 0;

  for (const row of allRuns) {
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
    if (row.finished_at) {
      terminalCount++;
      if (row.status === "failed") failureCount++;
    }
    if (row.duration_ms !== null) {
      totalDuration += Number(row.duration_ms);
      durationCount++;
    }
  }

  return {
    projectId,
    totalRuns: allRuns.length,
    statusCounts,
    averageDurationMs: durationCount > 0 ? totalDuration / durationCount : null,
    failureRate: terminalCount > 0 ? failureCount / terminalCount : 0,
  };
}

// ---------------------------------------------------------------------------
// Usage aggregation (Phase 8B) — read-only accounting. No budgets, no pricing,
// no reservations: this layer only sums what the runtime actually reported.
// ---------------------------------------------------------------------------

export interface TaskUsageSummary {
  taskId: string;
  runId: string;
  role: string;
  title: string;
  executionCount: number;
  unknownExecutionCount: number;
  totals: ExecutionUsage;
}

export interface RunUsageSummary {
  runId: string;
  projectId: string;
  executionCount: number;
  unknownExecutionCount: number;
  totals: ExecutionUsage;
  /** Per-task breakdown, one entry per task belonging to the run. */
  perTask: TaskUsageSummary[];
}

/**
 * Aggregate token/cost usage across executions.
 *
 * Unknown semantics (per requirement):
 * - A NULL/missing `usage` is UNKNOWN, never zero.
 * - Mixing a known and an unknown value for a dimension makes that aggregate
 *   dimension null (nothing fabricated, never a partial sum presented as truth).
 * - An execution with `usage === null` increments `unknownExecutionCount`.
 * - An empty scope has zero totals with `unknownExecutionCount: 0` — nothing
 *   was consumed, so zero is truthful.
 * - All arithmetic is integer-only (token and micro-USD counts).
 * `currency`/`usageSource` are a single common value when the cost is fully
 * known and homogeneous, otherwise null.
 */
function aggregateUsage(
  executions: ReadonlyArray<Pick<ExecutionRecord, "usage">>,
): { totals: ExecutionUsage; unknownExecutionCount: number } {
  const unknownExecutionCount = executions.reduce(
    (n, e) => (e.usage === null ? n + 1 : n),
    0,
  );

  let inputSum = 0;
  let outputSum = 0;
  let costSum = 0;
  let inputKnown = true;
  let outputKnown = true;
  let costKnown = true;
  const currencies = new Set<string>();
  const sources = new Set<"reported" | "derived">();

  for (const e of executions) {
    const u = e.usage;
    if (u === null) {
      inputKnown = false;
      outputKnown = false;
      costKnown = false;
      continue;
    }
    if (u.inputTokens === null) {
      inputKnown = false;
    } else if (inputKnown) {
      inputSum += u.inputTokens;
    }
    if (u.outputTokens === null) {
      outputKnown = false;
    } else if (outputKnown) {
      outputSum += u.outputTokens;
    }
    if (u.costUsdMicros === null) {
      costKnown = false;
    } else {
      if (costKnown) costSum += u.costUsdMicros;
      if (u.currency !== null) currencies.add(u.currency);
      if (u.usageSource !== null) sources.add(u.usageSource);
    }
  }

  const empty = executions.length === 0;
  const costFullyKnown = !empty && costKnown;
  return {
    totals: {
      inputTokens: empty ? 0 : inputKnown ? inputSum : null,
      outputTokens: empty ? 0 : outputKnown ? outputSum : null,
      costUsdMicros: empty ? 0 : costKnown ? costSum : null,
      currency:
        costFullyKnown && currencies.size === 1 ? [...currencies][0]! : null,
      usageSource:
        costFullyKnown && sources.size === 1 ? [...sources][0]! : null,
    },
    unknownExecutionCount,
  };
}

/** Terminal execution statuses only. */
const COMMITTED_STATUS_FILTER = "AND status IN ('completed', 'failed', 'timeout', 'cancelled')";

function taskUsageSummary(
  db: Database,
  task: { id: string; run_id: string; role: string; title: string },
  onlyCommitted = false,
): TaskUsageSummary {
  const rows = db
    .prepare(
      `SELECT ${EXECUTION_COLUMNS} FROM executions
       WHERE task_id = ? ${onlyCommitted ? COMMITTED_STATUS_FILTER : ""}
       ORDER BY started_at`,
    )
    .all(task.id) as unknown as ExecutionRow[];
  const executions = rows.map(rowToExecution);
  const { totals, unknownExecutionCount } = aggregateUsage(executions);
  return {
    taskId: task.id,
    runId: task.run_id,
    role: task.role,
    title: task.title,
    executionCount: executions.length,
    unknownExecutionCount,
    totals,
  };
}

/** Every execution belonging to a pipeline run (see summarizeRunUsage). */
function runUsageExecutions(
  db: Database,
  runId: string,
  onlyCommitted = false,
): ExecutionRow[] {
  return db
    .prepare(
      `SELECT ${EXECUTION_COLUMNS} FROM executions
       WHERE id IN (
         SELECT id FROM executions WHERE run_id = ?
         UNION
         SELECT e.id FROM executions e
         INNER JOIN tasks t ON e.task_id = t.id
         WHERE t.run_id = ?
       )
       ${onlyCommitted ? COMMITTED_STATUS_FILTER : ""}
       ORDER BY started_at`,
    )
    .all(runId, runId) as unknown as ExecutionRow[];
}

export interface CommittedRunAggregate {
  executionCount: number;
  unknownExecutionCount: number;
  totals: ExecutionUsage;
}

/**
 * Committed (terminal-only) usage aggregate over every execution matching a
 * run linkage by EITHER convention (task-link or legacy run_id). Unlike
 * summarizeRunUsage it does NOT require a pipeline_runs row, so it also works
 * for transient direct/API executions that have no pipeline run of their own.
 */
export function aggregateCommittedRunUsage(db: Database, runId: string): CommittedRunAggregate {
  const rows = runUsageExecutions(db, runId, true);
  const executions = rows.map(rowToExecution);
  const { totals, unknownExecutionCount } = aggregateUsage(executions);
  return { executionCount: executions.length, unknownExecutionCount, totals };
}

/**
 * Aggregate usage for every execution belonging to a pipeline run, plus a
 * per-task breakdown. An execution belongs to the run when it matches either
 * linkage convention:
 * - normal pipeline linkage: `executions.task_id -> tasks.id -> tasks.run_id`
 * - legacy/seeded linkage:   `executions.run_id === pipelineRunId`
 * Set-union semantics: an execution matching both conventions is counted
 * exactly once. Returns null when the pipeline run does not exist.
 */
export function summarizeRunUsage(db: Database, runId: string): RunUsageSummary | null {
  const run = db
    .prepare(`SELECT ${PR_COLUMNS} FROM pipeline_runs WHERE id = ?`)
    .get(runId) as unknown as PipelineRunRow | undefined;
  if (!run) return null;

  const rows = runUsageExecutions(db, runId);
  const executions = rows.map(rowToExecution);
  const { totals, unknownExecutionCount } = aggregateUsage(executions);

  const taskRows = db
    .prepare(
      "SELECT id, run_id, role, title FROM tasks WHERE run_id = ? ORDER BY created_at",
    )
    .all(runId) as unknown as Array<{ id: string; run_id: string; role: string; title: string }>;

  return {
    runId,
    projectId: run.project_id,
    executionCount: executions.length,
    unknownExecutionCount,
    totals,
    perTask: taskRows.map((t) => taskUsageSummary(db, t)),
  };
}

/**
 * Committed-only variant of summarizeRunUsage: aggregates usage over terminal
 * executions (completed / failed / timeout / cancelled) and their terminal
 * per-task breakdowns. In-flight executions are excluded, making this stable
 * for budget reconciliation. Returns null when the pipeline run does not exist.
 */
export function summarizeRunCommittedUsage(db: Database, runId: string): RunUsageSummary | null {
  const run = db
    .prepare(`SELECT ${PR_COLUMNS} FROM pipeline_runs WHERE id = ?`)
    .get(runId) as unknown as PipelineRunRow | undefined;
  if (!run) return null;

  const rows = runUsageExecutions(db, runId, true);
  const executions = rows.map(rowToExecution);
  const { totals, unknownExecutionCount } = aggregateUsage(executions);

  const taskRows = db
    .prepare(
      "SELECT id, run_id, role, title FROM tasks WHERE run_id = ? ORDER BY created_at",
    )
    .all(runId) as unknown as Array<{ id: string; run_id: string; role: string; title: string }>;

  return {
    runId,
    projectId: run.project_id,
    executionCount: executions.length,
    unknownExecutionCount,
    totals,
    perTask: taskRows.map((t) => taskUsageSummary(db, t, true)),
  };
}

/**
 * Aggregate usage for every execution attributed to a single task via
 * `executions.task_id`. Returns null when the task does not exist.
 */
export function summarizeTaskUsage(db: Database, taskId: string): TaskUsageSummary | null {
  const task = db
    .prepare("SELECT id, run_id, role, title FROM tasks WHERE id = ?")
    .get(taskId) as unknown as { id: string; run_id: string; role: string; title: string } | undefined;
  if (!task) return null;
  return taskUsageSummary(db, task);
}

/**
 * Committed-only variant of summarizeTaskUsage: aggregates usage over terminal
 * executions attributed to the task. Returns null when the task does not exist.
 */
export function summarizeTaskCommittedUsage(db: Database, taskId: string): TaskUsageSummary | null {
  const task = db
    .prepare("SELECT id, run_id, role, title FROM tasks WHERE id = ?")
    .get(taskId) as unknown as { id: string; run_id: string; role: string; title: string } | undefined;
  if (!task) return null;
  return taskUsageSummary(db, task, true);
}

// ---------------------------------------------------------------------------
// Cross-entity consistency check (test utility)
// ---------------------------------------------------------------------------

export interface ConsistencyViolation {
  check: string;
  message: string;
}

/**
 * Verify cross-entity consistency for a pipeline run. Returns an array of
 * violations (empty = consistent). Used in tests to catch schema drift or
 * inconsistent writes.
 */
export function assertPipelineConsistency(db: Database, runId: string): ConsistencyViolation[] {
  const violations: ConsistencyViolation[] = [];

  const run = db
    .prepare(`SELECT id, status, finished_at, duration_ms FROM pipeline_runs WHERE id = ?`)
    .get(runId) as { id: string; status: string; finished_at: string | null; duration_ms: number | null } | undefined;

  if (!run) {
    return [{ check: "pipeline_run_exists", message: `pipeline run ${runId} not found` }];
  }

  const tasks = db
    .prepare("SELECT id, run_id FROM tasks WHERE run_id = ?")
    .all(runId) as Array<{ id: string; run_id: string }>;

  const taskIds = new Set(tasks.map((t) => t.id));

  // Executions are linked to pipeline runs via task_id (each execution gets
  // its own run_id from the ExecutionService, not the pipeline run id).
  const executions = db
    .prepare("SELECT id, run_id, task_id FROM executions WHERE task_id IN (SELECT id FROM tasks WHERE run_id = ?)")
    .all(runId) as Array<{ id: string; run_id: string; task_id: string | null }>;

  for (const t of tasks) {
    const match = executions.find((e) => e.task_id === t.id);
    if (!match) {
      violations.push({ check: "task_execution_link", message: `task ${t.id} has no matching execution` });
    }
  }

  const events = db
    .prepare("SELECT run_id FROM events WHERE run_id = ?")
    .all(runId) as Array<{ run_id: string }>;
  if (events.length > 0 && events[0]!.run_id !== runId) {
    violations.push({ check: "event_run_reference", message: `events reference non-existent run ${runId}` });
  }

  const artifacts = db
    .prepare("SELECT id, task_id FROM artifacts WHERE run_id = ?")
    .all(runId) as Array<{ id: string; task_id: string | null }>;
  for (const a of artifacts) {
    if (a.task_id && !taskIds.has(a.task_id)) {
      violations.push({ check: "artifact_task_reference", message: `artifact ${a.id} references non-existent task ${a.task_id}` });
    }
  }

  const terminalStatuses = ["completed", "failed", "cancelled", "timeout"];
  if (terminalStatuses.includes(run.status)) {
    if (!run.finished_at) {
      violations.push({ check: "terminal_finished_at", message: `terminal run ${runId} has null finished_at` });
    }
    if (run.duration_ms === null) {
      violations.push({ check: "terminal_duration_ms", message: `terminal run ${runId} has null duration_ms` });
    }
  }

  return violations;
}
