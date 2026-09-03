# DevMesh Development Plan

> Status: active
> Last updated: 2026-09-03 (post Phase 12 — Phases 0–12 complete; Phases 13–14 planned)
> Reference: docs/adr/0001-approved-architecture.md
> Test baseline: 607 passed, 5 skipped, 0 failed (Phase 12; historical: Phase 11 was 590 passed, Phase 10 was 574 passed)

---

## Current State Summary

DevMesh is a multi-agent AI software engineering platform. A user describes a
project; four specialized agents (architect, developer, tester, reviewer)
collaborate to build it inside a git workspace. The control plane is a single
Node.js process (hexagonal modular monolith) with seven packages. The initial
agent runtime is OpenCode behind a swappable adapter port.

**What works today:**
- Full pipeline execution: architect → developer → tester → reviewer
- Dynamic DAG execution driven by the plan artifact (Phase 7F)
- Revision loops: tester failures and reviewer rejections route back to developer
- Doom-loop detection with configurable threshold (works per-plan-task)
- Git checkpoint/rollback around developer stages (incl. DAG developer tasks)
- Execution verification: SHA-256 re-hashing of claimed file changes
- Independent test replay (Phase 7E): DevMesh re-runs the tester's command to verify claims
- Structured agent output (Phase 7D): agents return schema-validated JSON, text-parsing fallback
- Pipeline persistence, query API, SSE event streaming, cancellation, resumption
- Pipeline stage persistence + stage-progress tracking (Phase 7B)
- Context blackboard REST API (Phase 7A)
- Terminal-state-safe lifecycle mutations and classified error handling (Phase 6E)
- 4 agent definitions with role-specific permissions and system prompts
- SQLite storage with 8 migrations, 8+ repositories
- Workspace service with symlink escape protection and FIFO mutex locking
- Usage reporting + persistence (Phase 8A): runtime-reported tokens recorded per execution
- Usage aggregation (Phase 8B): read-only run/task rollups with correct unknown semantics
- Cost pricing + budget enforcement (Phase 8C): config-driven pricing derives `costUsdMicros`
  (stamped `derived`, reported cost preserved), and per-run/per-task token & micro-USD gates
  reject over-limit starts before they run (HTTP 409 `budget/exhausted`)
- Approval workflow (Phase 9): user-visible approval requests pause gated actions
  (destructive git ops, network egress, cost cap releases). `ApprovalGate` persists
  `approval.requested`/`approval.resolved` via the durable `approvals` table; the
  orchestrator blocks a gated task as `blocked` until a human approves (resume) or
  denies (fail), and re-enters the gate on resume so blocked state survives a restart

---

## Package Map

```
packages/
  contracts/       Zod schemas, branded IDs, task state machine, event catalog,
                   artifact types, context entries, prompts, pipeline run schema,
                   plan integrity validation
  runtime/         AgentRuntime port interface (incl. outputFormat/structured),
                   FakeRuntime, RuntimeError
  storage/         SQLite persistence (node:sqlite), 9 repositories, 8 migrations,
                   EventBus, diagnostic queries (pipelineRunSummary/pipelineHealth)
  workspace/       Git facade, file I/O, path safety, per-key async mutex
  agents/          AgentRegistry, 4 built-in agent definitions
  opencode-adapter/ OpenCode CLI adapter (NDJSON, process-group kill, outputFormat)
  server/          Fastify HTTP server, orchestrator, execution service,
                   verification (SHA-256 + independent test replay), artifact
                   builder (structured-first, text-parsing fallback), SSE streaming,
                   approval workflow (ApprovalGate + REST endpoints)
```

---

## Architecture Decisions (enforced by code)

1. **Hexagonal modular monolith.** One Node process; module boundaries
   (`packages/*`) enforced so services can split later.
2. **OpenCode strictly behind one adapter.** All vendor knowledge confined to
   `packages/opencode-adapter`. Core depends only on the `AgentRuntime` port.
3. **Git and workspace are the source of truth.** Context store holds derived
   facts; filesystem holds reality. Checkpoints are git commits.
4. **Hub-and-spoke orchestration.** Agents never call each other; orchestrator
   routes typed artifacts between them over the domain event bus.
5. **Typed structured artifacts.** `spec.v1`, `plan.v1`, `change_set.v1`,
   `test_report.v1`, `review.v1`, `verification.v1` — schema-validated,
   versioned envelopes.

---

## Completed Phases

### Phase 0–3: Scaffolding + Core Contracts + Server + Runtime + Workspace

**Commit:** `c020632` (single initial commit)

| Deliverable | Status |
|---|---|
| Monorepo scaffold (npm workspaces, TS strict, eslint flat config, vitest) | done |
| `@devmesh/contracts`: IDs, roles, permissions, manifests, task state machine, artifacts, events, context, prompts | done |
| `@devmesh/runtime`: `AgentRuntime` port, `FakeRuntime`, `RuntimeError` | done |
| `@devmesh/storage`: SQLite via `node:sqlite`, 4 migrations, projects/tasks/events/artifacts/context repos | done |
| `@devmesh/workspace`: `GitService` (init, status, diff, add, commit, checkpoint, rollback), `WorkspaceService`, `MutexMap`, path safety | done |
| `@devmesh/agents`: `AgentRegistry`, 4 built-in agent definitions with prompts and permissions | done |
| `@devmesh/opencode-adapter`: `OpencodeAdapter` (spawn, NDJSON parse, timeout, cancel, health) | done |
| `@devmesh/server`: Fastify app, health endpoint, project CRUD, execution lifecycle, verification (SHA-256 + command replay) | done |
| 282+ tests across 7 packages | done |

### Phase 4: Multi-Agent Orchestration

**Commit:** `4c45b32`

| Deliverable | Status |
|---|---|
| `Orchestrator` class (1125 lines): 4-role linear pipeline with dependency satisfaction | done |
| Artifact builder: text→structured parsing for spec, plan, test_report, review | done |
| Orchestrator produces structured artifacts on each stage success | done |
| Pipeline-level lifecycle (start, run loop, terminal states) | done |
| Instruction assembly with cross-stage context propagation | done |
| 40 orchestrator tests covering full pipeline, revision, doom-loop, budgets | done |

### Phase 5: Reliable Revision Pipelines

**Commit:** `112e074`

| Deliverable | Status |
|---|---|
| Doom-loop detector with configurable threshold and failure signature normalization | done |
| `RevisionCycleRepository` and `revision_cycles` table (migration 5) | done |
| Git checkpoint before developer's first attempt; rollback on failure | done |
| Context namespaces `failure` and `revision` for structured failure data | done |
| Failure classification taxonomy (9 kinds) | done |
| Revision context assembly (test failures → developer instructions) | done |

### Phase 6A: Pipeline Run Persistence

**Commit:** `1db7b72`

| Deliverable | Status |
|---|---|
| `PipelineRunStatus` contract (`running`, `completed`, `failed`, `cancelled`, `timeout`) | done |
| `pipeline_runs` table (migration 6) | done |
| `PipelineRunRepository` with insert, update, get, listByProject, findRunning | done |
| Orchestrator persists pipeline lifecycle to `pipeline_runs` | done |
| `orchestrator.currentRunId` exposes active run | done |
| 4 persistence tests in orchestrator suite | done |

### Phase 6B: Pipeline Query API

**Commit:** `878ef85`

| Deliverable | Status |
|---|---|
| `GET /projects/:id/pipelines` — list pipeline runs for a project | done |
| `GET /pipelines/:runId` — get a single pipeline run | done |
| `GET /pipelines/:runId/tasks` — tasks for a pipeline run | done |
| `GET /pipelines/:runId/events` — events with `afterSeq`/`limit` pagination | done |
| `GET /pipelines/:runId/artifacts` — artifacts with `kind` filter | done |
| `GET /pipelines/:runId/executions` — executions for a pipeline run | done |
| `GET /projects/:id/tasks` — project-level task query | done |
| `GET /projects/:id/artifacts` — project-level artifact query | done |
| Project ownership enforcement on all queries | done |
| 20 query API tests in `app.test.ts` | done |

### Phase 6C: Pipeline SSE Event Streaming

**Commit:** `af362cc`

| Deliverable | Status |
|---|---|
| `EventBus` (EventEmitter subclass) wired into `EventRepository.append()` | done |
| `PipelineEventStream` class: replay + live delivery + heartbeat | done |
| `GET /pipelines/:runId/events/stream` — SSE endpoint with `Last-Event-ID` reconnection | done |
| Gap-free replay: subscribe to bus before SQLite query, flush live buffer after | done |
| Terminal event detection closes stream cleanly | done |
| 22 SSE tests in `pipeline-sse.test.ts` covering replay, live, isolation, reconnection | done |

### Phase 6D: Pipeline Cancellation

**Commit:** `ff90e77`

| Deliverable | Status |
|---|---|
| `POST /pipelines/:runId/cancel` — cancel a running pipeline (202), idempotent on terminal (200) | done |
| `cancel()` on `Orchestrator`: sets flag, cancels active execution, checks at stage boundaries | done |
| Git rollback on cancellation restores workspace | done |
| Persistence: `pipeline_runs.status` updated to `cancelled` with `finishedAt`/`durationMs` | done |
| `run.cancelled` event emitted | done |
| SSE stream closes on `run.cancelled` | done |
| 14 cancellation-specific tests in `orchestrator.test.ts` and `pipeline-sse.test.ts` | done |

### Phase 6E: Pipeline Lifecycle Hardening

**Status:** complete — commit `d40dfa4`

**Goal:** Eliminate lifecycle bugs from terminal-state violations, race
conditions, and swallowed errors. Replace best-effort `catch {}` blocks with
classified, observable error handling.

**Depends on:** 6D (cancellation)

#### Terminal-State Protection

All mutation endpoints (`cancel`, `resume`, stage transitions) guard against
acting on a pipeline that has already reached a terminal state (`completed`,
`failed`, `cancelled`, `timeout`). The orchestrator's `updateStatus()` method
becomes the single choke-point for `pipeline_runs.status` writes:

- Any write to a terminal status is rejected with a structured error
  (`TerminalStateError`).
- The cancel endpoint already returns 200 on terminal (6D); this phase
  enforces the same pattern inside the orchestrator for internal transitions.

#### Lifecycle Race Conditions

When two async paths (e.g., a concurrent cancel and a stage completion) race
to update `pipeline_runs.status`, only the first write wins:

- `updateStatus()` performs a read-then-write with an optimistic check:
  if current status is already terminal, the second caller's update is
  skipped (not an error — a no-op).
- Event emission for the superseded transition is suppressed to avoid
  duplicate terminal events on the SSE stream.

#### Idempotency Guarantees

- `cancel()` is idempotent: calling it multiple times on the same run
  produces exactly one `run.cancelled` event and one status update.
- Event emission helpers (`emitEvent`) deduplicate by `(runId, eventType)`
  within a single pipeline run — a second `run.cancelled` for the same
  `runId` is a no-op.
- Git rollback on cancellation/timeout is idempotent: if the workspace is
  already at the checkpoint, rollback is skipped.

#### Error Classification & Elimination of Silent Swallowing

TD-5 is resolved here. Every `catch {}` block in the orchestrator and
execution pipeline is audited and classified:

| Category | Action |
|---|---|
| **Transient** (network timeout, SQLite busy) | Retry with backoff; log at `warn` level |
| **Corrupt data** (schema validation failure, unparseable artifact) | Fail the stage with `RuntimeError`; log at `error` level |
| **Non-critical side-effect** (event bus emit after DB write succeeded) | Log at `warn` with structured context; do **not** fail the stage |
| **Impossible/bug** (assertion failure, unreachable code) | Throw; let process crash; do not catch |

No `catch {}` (empty catch) blocks remain. Every `catch` clause either
re-throws, logs with a classification, or explicitly documents why the error
is safe to ignore with a `// SAFETY:` comment.

#### Contract Changes

- `TerminalStateError` added to `@devmesh/contracts` error types (exported,
  not schema-validated — internal error class).

#### Acceptance Criteria

- [x] `updateStatus()` rejects writes to terminal-status pipeline runs
- [x] Concurrent cancel + stage-completion results in exactly one terminal
      event and one status update
- [x] `cancel()` called twice emits exactly one `run.cancelled` event
- [x] `emitEvent` deduplicates identical event types per run
- [x] Git rollback is skipped when workspace is already at checkpoint
- [x] Zero `catch {}` (empty catch) blocks in orchestrator and execution
      pipeline
- [x] Every `catch` clause has either a re-throw, structured logging with
      error classification, or a `// SAFETY:` justification
- [x] All existing orchestrator, cancellation, and SSE tests pass

#### Required Tests

| File | Tests |
|---|---|
| `orchestrator.test.ts` | Terminal-state rejection (cancel on completed fails no-op), concurrent cancel + completion races, cancel idempotency (single event), emitEvent deduplication, git rollback idempotency, error classification: transient retry, corrupt data fails stage, non-critical side-effect logged not fatal |
| `pipeline-sse.test.ts` | Duplicate terminal events suppressed in stream |

**Estimated new tests: ~10**

---

### Phase 6F: Pipeline Observability & Reliability

**Status:** complete — commit `9d26de9`

**Goal:** Close test coverage gaps in storage repositories and event bus,
and add diagnostic infrastructure for pipeline health.

**Depends on:** 6E (error classification provides structured logging surface)

#### Repository & EventBus Test Coverage

TD-3 is resolved here. Dedicated test suites for every zero-coverage
repository and the event bus wiring:

| Component | Coverage Target |
|---|---|
| `ExecutionRepository` | CRUD lifecycle, listByRun ordering, null handling |
| `RevisionCycleRepository` | CRUD, listByRun ordering, failure signature storage |
| `EventBus.attachBus()` | Event propagation, isolation between bus instances |
| `EventRepository.listByRunAfter()` | Pagination, sequence ordering, empty result |
| `TaskRepository.listByProject()` | Ordering, empty project, project isolation |
| `withTransaction` rollback path | Transaction rollback on error, commit on success |

#### Pipeline Diagnostics

Lightweight diagnostic queries (read-only, no new tables):

| Query | Purpose |
|---|---|
| `pipelineRunSummary(runId)` | Returns stage timings, total duration, event count, artifact count for a run |
| `pipelineHealth(projectId)` | Returns counts of runs by status, average duration, failure rate |

These are internal service methods (not REST endpoints yet — Phase 7+ can
expose them). They help verify pipeline correctness in tests and debug
production issues via logs.

#### Cross-Entity Consistency Checks

A test-only utility function `assertPipelineConsistency(runId)` that
verifies:

- Every task linked to the run has a matching execution record.
- Every execution record's `run_id` matches the task's pipeline run.
- Every event's `run_id` references an existing pipeline run.
- Every artifact's `execution_id` references an existing execution.
- Terminal runs have non-null `finished_at` and `duration_ms`.

This function is used in orchestrator tests to catch schema drift or
inconsistent writes.

#### Acceptance Criteria

- [x] `ExecutionRepository` has full CRUD + listByRun test coverage
- [x] `RevisionCycleRepository` has full CRUD + listByRun test coverage
- [x] `EventBus.attachBus()` propagation and isolation tested
- [x] `EventRepository.listByRunAfter()` pagination and ordering tested
- [x] `TaskRepository.listByProject()` ordering and isolation tested
- [x] `withTransaction` rollback path tested
- [x] `pipelineRunSummary()` returns correct stage timings and counts
- [x] `pipelineHealth()` returns correct status counts and averages
- [x] `assertPipelineConsistency()` passes on a well-formed pipeline run
- [x] All existing tests pass (no regressions)

#### Required Tests

| File | Tests |
|---|---|
| `storage.test.ts` | ExecutionRepository CRUD + listByRun, RevisionCycleRepository CRUD + listByRun, EventBus propagation + isolation, EventRepository.listByRunAfter pagination + ordering, TaskRepository.listByProject ordering + isolation, withTransaction rollback path, pipelineRunSummary correctness, pipelineHealth correctness |
| `orchestrator.test.ts` | assertPipelineConsistency passes after full pipeline run, assertPipelineConsistency catches missing execution link |

**Estimated new tests: ~16**

---

### Phase 7A: Context API

**Commit:** `8557715`

| Deliverable | Status |
|---|---|
| `GET /projects/:projectId/context` — latest entries grouped by namespace | done |
| `GET /projects/:projectId/context/:namespace` — entries filtered by namespace | done |
| `GET /projects/:projectId/context/:namespace/history/:key` — full version chain chronologically | done |
| `POST /projects/:projectId/context` — create entry with server-assigned id/timestamp | done |
| Superseded entries excluded from default GET but included in history | done |
| Project ownership enforcement, 404 for missing project, 400 for invalid namespace/body | done |
| ~10 context API tests in `app.test.ts` | done |

### Phase 7B: Pipeline Stage Persistence

**Commit:** `300d8fb`

| Deliverable | Status |
|---|---|
| Migration 7 creates `pipeline_stages` table (idempotent) | done |
| `StageRepository` (insert, update, listByRun, getLastCompleted) | done |
| Orchestrator inserts 4 stage rows on pipeline start | done |
| Stage transitions persisted (pending→running→completed/failed/cancelled) | done |
| `execution_id`/`task_id` recorded per stage | done |
| `getLastCompleted()` returns last completed stage | done |
| Stage rows survive close/reopen (durability) | done |
| ~10 stage persistence tests in `storage.test.ts` + `orchestrator.test.ts` | done |

### Phase 7C: Resumable Pipelines

**Commit:** `fc9131a`

| Deliverable | Status |
|---|---|
| `POST /pipelines/:runId/resume` — resume from last completed stage (202) | done |
| `Orchestrator.resume(runId)` — validates resumable status, skips completed stages, rebuilds task cards + stage rows, re-runs orchestration loop | done |
| 404 for missing pipeline; 409 for running/completed; 503 when no runtime wired | done |
| `run.started` emitted on resume with `decision/resumed_from` context entry | done |
| Resume after failure, cancellation, and timeout | done |
| Resume is idempotent (second resume on now-completed run rejects) | done |
| Resumed pipelines support revision loops, doom-loop detection, and cancellation | done |
| 13 resumable-pipeline tests in `orchestrator.test.ts` + 5 resume endpoint tests in `app.test.ts` | done |

### Phase 7D: Structured Agent Output

**Commit:** `4173dd7`

| Deliverable | Status |
|---|---|
| `AgentExecutionRequest.outputFormat` + `AgentExecutionResult.structured` added to runtime port (non-breaking) | done |
| `OpencodeAdapter` passes `outputFormat` to OpenCode CLI and parses structured response | done |
| `FakeRuntime` returns `structured` in scripted outcomes | done |
| Orchestrator sends `outputFormat` for spec, plan, test_report, and review stages (not developer) | done |
| Orchestrator uses `structured` output to build artifacts when valid; falls back to text-parsing otherwise | done |
| `artifact-builder.ts` retained as fallback; no behavior change without structured output | done |
| Migration 8 adds `executions.structured` column | done |
| ~5 structured-output tests in `orchestrator.test.ts` | done |

### Phase 7E: Independent Test Replay

**Commit:** `777fc9f`

| Deliverable | Status |
|---|---|
| After tester stage, orchestrator extracts test command from `test_report` artifact | done |
| Command replayed in workspace root; produces `verification.v1` artifact with `command_replay` check | done |
| Contradicting replay (tester says pass, replay fails) triggers developer revision | done |
| Inconclusive replay (missing binary) recorded and does not fail the stage | done |
| Replay timeout bounded (default 60s), yields inconclusive | done |
| Replay reuses safety patterns from `verify.ts` (no destructive commands) | done |
| ~5 test-replay tests in `orchestrator.test.ts` + `verify.ts` command extraction/comparison tests | done |

### Phase 7F: Dynamic DAG Execution

**Commit:** `349912f`

| Deliverable | Status |
|---|---|
| Orchestrator parses `PlanPayload` from plan artifact after architect stage | done |
| `validatePlanIntegrity()` called; invalid plans fail the pipeline | done |
| Topological sort determines execution order from dependency graph | done |
| Each plan task creates a `TaskCard` with correct `role` and `dependsOn` | done |
| Concurrent execution respects `maxConcurrency` limit (default 1) | done |
| Pipeline completes when all plan tasks are `done`; fails on attempt exhaustion | done |
| Per-plan-task revision loops and doom-loop detection | done |
| Git checkpoint/rollback per developer-task execution | done |
| `respectPlanRoles` configurable (false routes all to developer) | done |
| Fallback to linear chain for single-task plans or no plan artifact | done |
| ~14 DAG tests in `orchestrator.test.ts` | done |

---

## ADR Gaps (requirements from 0001 not yet met)

| ADR Ref | Requirement | Current Status |
|---|---|---|
| Amendment 5a | Test reports reference an exact invocation; DevMesh replays it | ✅ Resolved — Phase 7E independent replay of the `test_report` invocation, producing a `verification.v1` artifact |
| Amendment 5b | Unverifiable claims fail the task | ✅ Resolved — Phase 7E replay verification integrated into pipeline flow; contradicting replay routes back to developer |
| Consequence | Resumable runs | ✅ Resolved — Phase 7C `POST /pipelines/:runId/resume` |
| Consequence | Budget enforcement (token/cost) | ✅ Resolved — Phase 8C config-driven pricing + per-run/per-task budget gates; conservative default (no budget configured) preserves pre-8C behavior |
| Context | Context entries as derived facts | ✅ Resolved — Phase 7A REST read API |

---

## Technical Debt (known, tracked)

| ID | Description | Severity |
|---|---|---|
| TD-1 | `artifact-builder.ts` uses regex text-parsing to extract structured data from agent free-text. Fragile across models and prompt phrasings. | ~~high~~ → resolved in Phase 7D (structured output is primary; text-parsing is fallback only) |
| TD-2 | Orchestrator hard-codes a 4-role linear chain ignoring the plan artifact's task DAG and dependency graph | ~~high~~ → resolved in Phase 7F (dynamic DAG execution driven by the plan artifact) |
| TD-3 | `ExecutionRepository` (0 tests), `RevisionCycleRepository` (0 tests), `EventBus.attachBus()` (0 tests), `EventRepository.listByRunAfter()` (0 tests) | ~~medium~~ → resolved in Phase 6F |
| TD-4 | `withTransaction` rollback path in `db.ts` is untested | ~~medium~~ → resolved in Phase 6F |
| TD-5 | Best-effort `catch {}` blocks silently swallow errors in orchestrator (event persistence, artifact creation, git checkpoints) | ~~medium~~ → resolved in Phase 6E |
| TD-6 | README.md still describes Phase 0 as current with Phase 1-3 as TODO | low |
| TD-7 | Synchronous `node:sqlite` `DatabaseSync` blocks event loop during queries | low |
| TD-8 | `FailureKind` string union not backed by a Zod validation schema | low |

---

## Phase 7: Context API + Pipeline Resumability + Structured Output — COMPLETE

Phase 7 addressed the highest-impact ADR gaps while keeping changes additive
(no breaking changes to the `AgentRuntime` port). It assumed Phases 6E/6F
were complete: lifecycle mutations are terminal-state-safe, error handling is
classified, and repository/event-bus coverage is established. It is split
into six sub-phases — **all six are now implemented** (see Completed Phases).
Sections below retain the original specs for reference.

---

### Phase 7A: Context API

**Goal:** Expose the context blackboard via REST so users and tooling can
inspect what the orchestrator has recorded.

#### New Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/projects/:projectId/context` | Latest (non-superseded) entries across all namespaces |
| `GET` | `/projects/:projectId/context/:namespace` | Latest entries filtered to a namespace |
| `GET` | `/projects/:projectId/context/:namespace/history/:key` | Full version history for a specific key |
| `POST` | `/projects/:projectId/context` | Create a new context entry (user/system writes) |

#### Contract Changes

None required. Existing `ContextEntry`, `contextNamespaceSchema`, and
`contextEntrySchema` from `@devmesh/contracts` are sufficient.

#### Implementation

- Add context routes to `packages/server/src/app.ts`.
- Reuse `ContextRepository.put()`, `latestByKey()`, `history()` from storage.
- POST body validated against `contextEntrySchema` (minus auto-generated
  `id`/`createdAt` which are assigned server-side).
- GET responses return entries grouped by namespace with supersession chain
  metadata.

#### Acceptance Criteria

- [x] `GET /projects/:id/context` returns all latest entries grouped by namespace
- [x] `GET /projects/:id/context/:namespace` returns only entries in that namespace
- [x] `GET /projects/:id/context/:namespace/history/:key` returns version chain in
      chronological order
- [x] `POST /projects/:id/context` creates an entry with server-assigned id/timestamp
- [x] Superseded entries are excluded from default GET but included in history
- [x] 404 for non-existent project; 400 for invalid namespace or body
- [x] Project ownership enforced (pipeline-scoped entries not leaked across projects)

#### Required Tests

| File | Tests |
|---|---|
| `app.test.ts` | GET all context, GET by namespace, GET history, POST create, 404 missing project, 400 invalid namespace, 400 invalid body, supersession chain in default GET vs history, project ownership enforcement |

**Estimated new tests: ~10**

---

### Phase 7B: Pipeline Stage Persistence

**Goal:** Track per-stage completion so the orchestrator knows exactly which
stages finished before a failure or cancellation.

#### Schema Change

New SQLite table via migration 7 (`stage-progress`):

```sql
CREATE TABLE pipeline_stages (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  stage_index  INTEGER NOT NULL,
  stage_role   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  execution_id TEXT,
  task_id      TEXT,
  started_at   TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_pipeline_stages_run ON pipeline_stages(run_id, stage_index);
CREATE INDEX idx_pipeline_stages_status ON pipeline_stages(status);
```

Status values: `pending`, `running`, `completed`, `failed`, `cancelled`.

#### New Repository

`StageRepository` in `packages/storage/src/repos.ts`:

| Method | Signature |
|---|---|
| `insert` | `(rec: StageRecord) => StageRecord` |
| `update` | `(rec: StageRecord) => void` |
| `listByRun` | `(runId: string) => StageRecord[]` |
| `getLastCompleted` | `(runId: string) => StageRecord \| null` |

#### Orchestrator Integration

- On pipeline start: insert 4 stage rows (architect, developer, tester, reviewer)
  with `status: "pending"`.
- Before each stage execution: update to `status: "running"` with `started_at`.
- After each stage: update to `completed`/`failed`/`cancelled` with
  `completed_at`.
- Store `execution_id` and `task_id` for each stage.

#### Acceptance Criteria

- [x] Migration 7 creates `pipeline_stages` table with correct schema
- [x] Migration is idempotent across reopens
- [x] Orchestrator inserts 4 stage rows on pipeline start
- [x] Stage status transitions are persisted (pending→running→completed/failed/cancelled)
- [x] `execution_id` and `task_id` are recorded for each completed stage
- [x] `getLastCompleted()` returns the last stage with `status: "completed"`
- [x] Stage rows survive database close/reopen (durability)
- [x] Stage rows are updated on cancellation (terminal stage marked cancelled)

#### Required Tests

| File | Tests |
|---|---|
| `storage.test.ts` | Migration 7 idempotency, StageRepository CRUD, listByRun ordering, getLastCompleted logic, durability across close/reopen |
| `orchestrator.test.ts` | Stage rows created on pipeline start, updated through lifecycle, completed stages persist across pipeline run, stage tracking during revision loops |

**Estimated new tests: ~10**

---

### Phase 7C: Resumable Pipelines

**Goal:** Allow a failed, cancelled, or timed-out pipeline to resume from the
last completed stage rather than restarting from scratch.

#### New Endpoint

| Method | Path | Description |
|---|---|---|
| `POST` | `/pipelines/:runId/resume` | Resume from last completed stage |

Response: `202 Accepted` with updated pipeline run object.

#### Implementation

`Orchestrator.resume(runId)`:

1. Validate `pipeline_runs.status` is one of `failed`, `cancelled`, `timeout`
   (return 409 if `running` or `completed`).
2. Read `pipeline_stages` for this run. Find the last stage with
   `status: "completed"`.
3. Determine the next stage index to execute (last completed + 1).
4. Create new task cards for remaining stages (architect stage is skipped if
   architect completed; developer/tester/reviewer created as needed).
5. Update `pipeline_runs.status` to `running`, clear `finishedAt`/`durationMs`.
6. Emit a `run.started` event (with `resumed: true` context entry or a new
   `run.resumed` event type).
7. Execute remaining stages using the existing orchestration loop.

#### Contract Changes

Either:
- Add `run.resumed` event type to `domainEventSchema`, OR
- Use existing `run.started` event with a context entry
  (`namespace: "decision", key: "resumed_from", value: { runId, stageIndex }`).

The context entry approach is preferred (no contract version bump).

#### Acceptance Criteria

- [x] `POST /pipelines/:runId/resume` returns 202 with updated pipeline on
      valid resume
- [x] Returns 409 if pipeline is `running` or `completed`
- [x] Returns 404 if pipeline does not exist
- [x] Resumed pipeline skips stages that were `completed` before failure
- [x] Task cards are created only for remaining stages
- [x] `pipeline_runs.status` transitions back to `running` then to terminal
- [x] Context entry records the resume origin (which stage, which prior run)
- [x] Git workspace is clean before resume (rollback if needed)
- [x] Resume is idempotent (calling twice on same terminal run produces
      consistent results)
- [x] All existing pipeline behaviors work normally on resumed runs (revision
      loops, doom-loop detection, cancellation)

#### Required Tests

| File | Tests |
|---|---|
| `orchestrator.test.ts` | Resume after failure skips completed stages, resume after cancellation, resume after timeout, reject resume of running pipeline, reject resume of completed pipeline, task cards created for remaining stages only, context entry records resume origin, resume emits run.started, resume is idempotent, resumed pipeline supports revision loops, resumed pipeline supports cancellation |
| `app.test.ts` | POST resume endpoint, 404 for missing pipeline, 409 for running pipeline, 409 for completed pipeline |

**Estimated new tests: ~14**

---

### Phase 7D: Structured Agent Output

**Goal:** Eliminate fragile regex text-parsing (`artifact-builder.ts` TD-1) by
having the control plane request structured JSON from agents via the
`outputFormat` mechanism already defined in contracts.

#### Port Interface Change

Extend `AgentExecutionRequest` in `packages/runtime/src/types.ts`:

```ts
interface AgentExecutionRequest {
  executionId: string;
  projectId: string;
  workspaceRoot: string;
  instruction: string;
  timeoutMs: number;
  model?: string;
  outputFormat?: {                    // NEW
    name: string;
    schema: Record<string, unknown>;  // JSON Schema
  };
}
```

Extend `AgentExecutionResult` to include structured output:

```ts
interface AgentExecutionResult {
  // ... existing fields ...
  structured?: unknown;              // NEW — parsed JSON matching outputFormat
}
```

This is a **non-breaking addition** (new optional fields).

#### Adapter Change

`OpencodeAdapter.start()` passes `outputFormat` to the CLI if present
(CLI flag: `--output-schema <json>` or equivalent). The adapter's
`createOpencodeEventMapper` parses the structured output from the final
`text` event or a dedicated `structured` event.

#### FakeRuntime Update

`FakeScript` gains an optional `structured` field on `FakeOutcome` that is
returned as `result.structured`.

#### Orchestrator Integration

Replace `buildSpecArtifact()`, `buildPlanArtifact()`,
`buildTestReportArtifact()`, `buildReviewArtifact()` calls with:

1. Before each agent execution, set `outputFormat` on the request with the
   appropriate JSON Schema for the expected artifact kind.
2. After execution, if `result.structured` is present and validates against
   the artifact schema, use it directly.
3. Fall back to text-parsing (existing `artifact-builder.ts`) only when
   `structured` is absent or fails validation.

#### Acceptance Criteria

- [x] `AgentExecutionRequest.outputFormat` is accepted by the runtime port
- [x] `AgentExecutionResult.structured` carries parsed JSON from the agent
- [x] `OpencodeAdapter` passes `outputFormat` to the OpenCode CLI
- [x] `FakeRuntime` supports `structured` in scripted outcomes
- [x] Orchestrator sends `outputFormat` for spec, plan, test_report, and
      review stages
- [x] Orchestrator uses `structured` output when available and valid
- [x] Orchestrator falls back to text-parsing when structured output is
      unavailable or invalid
- [x] `artifact-builder.ts` remains as fallback; no behavior change when
      structured output is not available
- [x] All existing tests pass (FakeRuntime tests updated for new field)

#### Required Tests

| File | Tests |
|---|---|
| `runtime/fake.test.ts` | FakeRuntime returns structured output from scripted outcome |
| `opencode-adapter/adapter.test.ts` | Adapter passes outputFormat to CLI, parses structured response (stub binary emits structured event) |
| `server/orchestrator.test.ts` | Orchestrator sends outputFormat, uses structured output to build artifacts, falls back to text-parsing when structured absent, falls back when structured is invalid |

**Estimated new tests: ~10**

---

### Phase 7E: Independent Test Replay

**Goal:** Satisfy ADR amendment 5 — when the tester produces a `test_report`
artifact, DevMesh independently replays the test command to verify the claim.

#### Implementation

Extend `ExecutionService.finalize()` or add an orchestrator-level verification
step after the tester stage:

1. After the tester stage completes with a `test_report` artifact, extract the
   `invocation.command` from the artifact payload.
2. Replay the command in the workspace root via `child_process.spawnSync`
   (same pattern as existing `runVerificationCommand` in `verify.ts`).
3. Compare the replay exit code and output against the tester's claimed
   `verdict` and `totals`.
4. Produce a `verification.v1` artifact with `command_replay` checks:
   - `kind: "command_replay"`, `command: <extracted>`, `exitCode: <actual>`,
     `passed: <matches claimed verdict>`.
5. If the replay contradicts the tester's claim (e.g., tester says pass but
   replay fails): set the pipeline into a revision loop as if the tester failed.
6. If replay is indeterminate (command not found, framework not installed):
   record as `detail: "replay inconclusive"` and do not fail the stage.

#### Acceptance Criteria

- [x] After tester stage, orchestrator extracts test command from `test_report`
      artifact
- [x] Command is replayed in the workspace root
- [x] `verification.v1` artifact is produced with `command_replay` check
- [x] If replay contradicts tester verdict, pipeline enters revision loop
- [x] If replay command cannot execute (missing binary), recorded as
      inconclusive and does not fail the stage
- [x] Replay timeout is bounded (configurable, default 60s)
- [x] Replay does not execute destructive commands (reuses existing safety
      patterns from `verify.ts`)
- [x] All existing orchestrator tests pass

#### Required Tests

| File | Tests |
|---|---|
| `orchestrator.test.ts` | Test command extracted from test_report, replay produces verification artifact, contradicting replay triggers revision, inconclusive replay does not fail stage, replay timeout enforced, replay uses workspace root as cwd |
| `executions/verify.test.ts` (new or extend existing) | Command extraction from artifact payload, replay comparison logic, inconclusive detection |

**Estimated new tests: ~8**

---

### Phase 7F: Dynamic DAG Execution

**Goal:** Replace the hardcoded 4-role linear chain with dynamic execution
driven by the plan artifact's task graph.

#### Design

The plan artifact (`plan.v1`) contains tasks with:
```ts
{ refKey, role, title, detail, acceptanceCriteria, dependsOn[] }
```

Currently the orchestrator ignores this and always runs
architect→developer→tester→reviewer. Phase 7F makes the orchestrator consume
the plan:

1. **Architect stage** produces the plan artifact as today.
2. **Plan parsing**: orchestrator extracts the `PlanPayload` from the plan
   artifact. Calls `validatePlanIntegrity()` (already defined in contracts)
   to verify no cycles, no dangling deps, unique refKeys.
3. **DAG scheduling**: topologically sort the plan tasks. Execute them in
   dependency order, respecting role assignments. Tasks with no unmet
   dependencies become `ready` immediately.
4. **Concurrent execution**: tasks with independent dependencies may execute
   concurrently (bounded by configurable concurrency limit, default 1 to
   preserve current sequential behavior).
5. **Per-task lifecycle**: each plan task maps to a `TaskCard` with its own
   task state machine, execution, verification, and revision cycle.
6. **Terminal condition**: pipeline completes when all plan tasks reach `done`.
   Pipeline fails if any task exhausts its attempt budget.

#### Configurable Defaults

| Option | Default | Description |
|---|---|---|
| `maxConcurrency` | 1 | Max tasks executing simultaneously |
| `respectPlanRoles` | true | Use plan task's `role` field for agent selection |
| `fallbackChain` | `["developer"]` | Roles to try if plan role is not executable |

#### Backward Compatibility

When the architect produces a plan with a single task (or no plan artifact is
produced), the orchestrator falls back to the current linear chain. This ensures
existing behavior is preserved for agents that don't produce structured plans.

#### Acceptance Criteria

- [x] Orchestrator parses `PlanPayload` from plan artifact after architect
      stage
- [x] `validatePlanIntegrity()` is called; invalid plans fail the pipeline
- [x] Topological sort determines execution order from dependency graph
- [x] Tasks are executed in dependency order (ready tasks run before dependents)
- [x] Each plan task creates a `TaskCard` with correct `role` and `dependsOn`
- [x] Concurrent execution respects `maxConcurrency` limit
- [x] Pipeline completes when all plan tasks are `done`
- [x] Pipeline fails when any task exhausts attempts
- [x] Revision loops work per-plan-task (tester/reviewer failures route back
      to the responsible developer task)
- [x] Fallback to linear chain when plan has a single task or no plan artifact
- [x] Doom-loop detection works per-plan-task
- [x] Git checkpoints/rollback work per developer-task execution

#### Required Tests

| File | Tests |
|---|---|
| `orchestrator.test.ts` | Plan parsing from architect output, invalid plan fails pipeline, topological execution order, tasks created with correct dependencies, concurrent execution (maxConcurrency=2), single-task fallback to linear chain, no-plan-artifact fallback, per-task revision loops, per-task doom-loop detection, pipeline completes when all tasks done, pipeline fails on task exhaustion |

**Estimated new tests: ~14**

---

## Phase 7 Total — COMPLETE

| Sub-phase | Focus | Tests | Status | Key Risk (as assessed) |
|---|---|---|---|---|
| 7A | Context API | ~10 | done | Low — additive REST endpoints |
| 7B | Stage Persistence | ~10 | done | Low — new table + repository |
| 7C | Resumable Pipelines | ~14 | done | Medium — orchestrator resume logic complexity |
| 7D | Structured Output | ~5 | done | Medium — runtime port interface change, adapter integration |
| 7E | Independent Test Replay | ~5 | done | Medium — command extraction from agent text, inconclusive handling |
| 7F | Dynamic DAG Execution | ~14 | done | High — fundamental orchestrator redesign, concurrency |

**Test baseline after Phase 7 (actual):** 427 passed, 5 skipped, 0 failed
(+145 vs. the Phase 0-6 count of 282; actual split across all phases).

---

## Phase 8: Usage Accounting — 8A, 8B & 8C COMPLETE

Usage accounting is delivered as sub-phases. Core intent (ADR consequence):
track `usage` from `AgentReply` and record it per execution so per-run and
per-task budgets can be enforced.

### Phase 8A: Usage Reporting and Persistence — COMPLETE

**Goal:** capture token usage reported by the runtime and persist it with each
execution record, without fabricating numbers.

#### Implementation

1. `packages/contracts`: `TokenUsage` schema + `agentreply.usage` field for
   `AgentExecutionResult`.
2. `packages/opencode-adapter`: parse `usage` from the OpenCode JSON event
   stream (`ndjson.ts`).
3. `packages/runtime`: `ExecutionUsage` travels on `AgentExecutionResult`;
   `FakeRuntime` can script usage reports.
4. `packages/storage`: migration 9 adds `input_tokens`, `output_tokens`,
   `cost_usd_micros`, `cost_currency`, `usage_source` to `executions`;
   `ExecutionRepository` round-trips them; NULL means "unmeasured", never zero.
5. `packages/server`: `ExecutionService.finalize()` validates and persists
   runtime-reported usage at the persistence boundary.

#### Acceptance Criteria

- [x] Runtime-reported tokens are validated at the persistence boundary
- [x] Invalid/malformed usage is dropped, never persisted, and the execution
      records `usage: null`
- [x] Cost fields stay NULL until a pricing rule exists (Phase 8C)
- [x] NULL/missing usage is distinct from a clean-zero report

#### Required Tests

| File | Tests |
|---|---|
| `contracts/usage.test.ts` | TokenUsage schema accepts/rejects token shapes |
| `opencode-adapter/adapter.test.ts` | Adapter parses usage from event stream |
| `runtime/fake.test.ts` | FakeRuntime scripts usage reports |
| `storage/storage.test.ts` | Migration 9 columns + repository round-trips |
| `server/executions.test.ts` | Service persists usage on completion |

### Phase 8B: Usage Aggregation — COMPLETE

**Goal:** read-only accounting over persisted usage. This layer only sums what
the runtime actually reported — no budgets, no pricing, no reservations.

#### Implementation

`packages/storage` (`repos.ts`, exported via `index.ts`):

- `summarizeRunUsage(db, runId)` — aggregates every execution belonging to a
  pipeline run (per-task linkage `executions.task_id -> tasks.run_id`, plus
  legacy `executions.run_id` linkage; set-union, counted once) with a
  per-task breakdown.
- `summarizeTaskUsage(db, taskId)` — aggregates every execution attributed to
  a single task.

Unknown semantics (documented on `aggregateUsage`):

- A NULL/missing `usage` is **UNKNOWN**, never zero; increments
  `unknownExecutionCount`.
- Mixing a known and an unknown value for a dimension makes that aggregate
  dimension `null` — nothing is fabricated, no partial sum is presented as
  truth.
- An empty scope returns truthful zero totals with `unknownExecutionCount: 0`.
- All arithmetic is integer-only (tokens and micro-USD).
- `currency`/`usageSource` are a single common value when the cost is fully
  known and homogeneous, otherwise `null`.

#### Acceptance Criteria

- [x] `summarizeRunUsage` returns null for an unknown run
- [x] `summarizeTaskUsage` returns null for an unknown task
- [x] Executions are aggregated across both linkage conventions, counted once
- [x] Aggregation is scoped to the run/task (no cross-entity leakage)
- [x] NULL-usage executions increment `unknownExecutionCount`
- [x] Mixed known/unknown aggregates report `null` for the affected dimension
- [x] Empty scopes report truthful zeros
- [x] Homogeneous `currency`/`usageSource` are preserved; mixed values are null
- [x] Per-task breakdown carries `taskId`/`runId`/`role`/`title`

#### Required Tests

| File | Tests |
|---|---|
| `storage/storage.test.ts` | Run-level and task-level aggregation, linkage set-union, scoping, unknown semantics, empty scopes, homogeneity |

**Estimated new tests: ~11** (actual: 11 added)

### Phase 8C: Cost Pricing and Budget Enforcement — COMPLETE

**Goal:** Derive nominal cost from config-driven pricing and enforce per-run and
per-task token/cost budgets, so a runaway agent cannot exhaust the device.

#### Implementation

1. `packages/contracts`: `PricingRule` schema mapping a neutral `provider/model`
   selector → `{ inputUsdMicrosPerMillion, outputUsdMicrosPerMillion, currency }`
   in integer micro-USD per one million tokens, with a deterministic
   `usdToMicros()` conversion so all downstream cost arithmetic stays integer-only.
2. `packages/config` (`packages/server/src/config.ts`): optional `budget`
   (`maxTokens`, `maxCostUsd`, `behavior: warn|block`, `unknownUsage`, and a
   `reservationTokens` optimistic per-start estimate) and `pricing` (array of
   human-USD-per-million rules) blocks, loadable from `DEVMESH_BUDGET` /
   `DEVMESH_PRICING` or the config schema. Absent configuration is a
   **conservative default**: no gates and no derived cost (identical to pre-8C).
3. `packages/server` `ExecutionService` (`executions/pricing.ts`): when the
   runtime reports tokens but no cost, `usageWithDerivedCost` derives
   `costUsdMicros` from the matching pricing rule (BigInt arithmetic,
   round-half-up) and stamps `usageSource: "derived"`. Runtime-reported costs
   are never overwritten.
4. Budget gate in `ExecutionService.start` (`executions/budget.ts`): the
   authoritative pre-start gate for every execution path (direct/API and both
   orchestrator schedulers). Task executions clear BOTH their task scope and the
   linked run scope; direct executions clear a transient run scope. It reads the
   committed aggregate (`aggregateCommittedRunUsage` /
   `summarizeTaskCommittedUsage` — terminal-status-only, Phase 8B semantics),
   adds in-process ledger reservations, and throws `BudgetError` (HTTP 409
   `budget/exhausted`) before anything is persisted or started. `warn` behavior
   allows the start and surfaces an `error.raised` budget warning; after each
   execution completes the service reconciles the committed scopes and emits a
   non-fatal "budget concern" for any overshoot.
5. Orchestrator reaction: a run-scope exhaustion blocks the pipeline (stage →
   `failed`, remaining stages cancelled, run → `failed` with a budget message and
   `run.failed` event). A task-scope exhaustion can never start, so the card is
   transitioned `ready → blocked` (the only legal terminal-adjacent transition)
   and the run fails — functionally equivalent to a revision-failure treatment,
   but strictly safer: a revision loop cannot make progress because the exhausted
   task-scope gate rejects every retry.

#### Acceptance Criteria

- [x] `PricingRule` validates provider/model and non-negative prices
- [x] Cost derivation is deterministic and stamped `derived`
- [x] Runtime-reported costs are never overwritten
- [x] Per-task budget exhaustion fails the task/run without entering a retry
      loop — the card transitions `ready → blocked` (the revision-cycle path
      cannot progress on an exhausted task scope), the run fails, and a
      `run.failed` event surfaces the budget reason
- [x] Per-run budget exhaustion fails the pipeline
- [x] Budget check runs before every start and is reconciled after each
      execution, not only at the end
- [x] Zero/unknown usage is handled without a false budget breach (unknown
      cost/tokens skip their check; `unknownUsage: "block"` is opt-in)

#### Required Tests

| File | Tests |
|---|---|
| `contracts/pricing.test.ts` | Pricing schema, unit conversion |
| `server/executions/pricing.test.ts` | PriceTable lookup, derived-cost stamping, reported-cost preservation |
| `server/executions/budget.test.ts` | Pure `evaluateBudget` (token/cost/unknown/warn), reservation ledger |
| `server/executions/budget-service.test.ts` | HTTP 409 gate (task/run/unknown), warn path, post-completion concern, reservation release, derived cost via app |
| `server/budget-orchestrator.test.ts` | Run-exhaustion pipeline failure, DAG blocked task, warn keeps pipeline running, serialized gate |

**Implemented tests: 47 (5 files, all passing)**

### Phase 9: Approval Flow — COMPLETE

**Status:** complete — 9A commit `37b70e7` (storage persistence), 9B commit
`03cee71` (orchestrator gate + REST API)

**Goal:** Wire the existing `approval.requested` / `approval.resolved` events
(contracts already define them) into a user-visible approval workflow so
sensitive actions (e.g. destructive git ops, external network calls, cost cap
releases) pause the pipeline until a human approves or denies.

#### Phase 9A (complete — commit `37b70e7`): Approval Persistence

1. `packages/storage`: `ApprovalRepository` + `approvals` table (migration 10)
   with approval id, project id, run id, task id, kind, title, detail, risk,
   status, requested at, resolved at, decision, decided by. `ApprovalRepository`
   exposes `insert`, `get`, `listByProject`, `listByRun`, `listPending` (scoped
   or global), and an atomic `resolve(id, decision, decidedBy)` that transitions
   `pending` → `approved`/`denied` via a single guarded `UPDATE`, rejecting
   unknown ids (`storage/not-found`) and double-resolution
   (`storage/approval-resolved`).

#### Phase 9B (complete — commit `03cee71`): Orchestrator Gate + REST API

2. `packages/server/src/approvals.ts` — `ApprovalGate`: the single owner of the
   approval lifecycle, shared by the REST layer and the orchestrator so created
   and resolved approvals emit their events exactly once and persisted state
   stays authoritative (no in-memory promise is the source of truth).
   - `request()` persists and emits `approval.requested`. Idempotent by
     identity: an existing `(runId, taskId)` record is returned as-is, and a
     `(runId, kind)` fallback reconstructs prior decisions across Phase 7C
     resume (which mints fresh task ids for the same stage) — a resolved
     approval is never re-requested, no duplicate rows/events.
   - `resolve()` delegates to the atomic `ApprovalRepository.resolve` and emits
     `approval.resolved` only after the persisted transition succeeds.
   - `waitForResolution`/`waitAnyResolution` poll the durable `approvals` table
     (mirrors `waitForTerminal`); the orchestrator's `_cancelled` flag aborts
     the wait.
3. `packages/server` REST endpoints:
   - `POST /approvals` — create an approval request (201; 404 unknown
     project/run/task);
   - `GET /approvals/:id` — fetch status (200; 404 `approval/not-found`);
   - `POST /approvals/:id/resolve { decision: allow|deny }` — approve/deny
     (200; 409 `storage/approval-resolved` on double resolution; 404 unknown);
   - `GET /projects/:projectId/approvals` — list pending approvals.
   Body/params validated with Zod; `errors-map.ts` maps
   `storage/approval-resolved` → 409.
4. Orchestrator hook (`maybeGate`/`finishApprovalGate`): when the configured
   `gateAction` marks a task as gated, the pipeline emits `approval.requested`
   and transitions the task to `blocked` (legal `ready` → `blocked`). It stays
   blocked until `approval.resolved` arrives:
   - approve → `blocked` → `ready`, execution proceeds;
   - deny → remaining stages cancelled, task stays `blocked`, pipeline fails
     with a `run.failed` ("approval denied") event;
   - cancel while blocked → `run.cancelled`, pipeline cancelled.
   The gate is hit on both the initial run AND the resumed loop, so a blocked
   run that was cancelled picks up its decision (approved/denied) or re-requests
   while still pending — blocked state survives a resume without duplication.

#### Acceptance Criteria

- [x] `approval.requested`/`approval.resolved` are emitted on the bus
- [x] Approval-gated action pauses the task as `blocked`
- [x] Approve resumes the task; deny fails it
- [x] Pending approvals are listed and resolvable via the API
- [x] Blocked state survives a resume
- [x] Approvals are validated (unknown id / double-resolve rejected)

#### Required Tests

| File | Tests |
|---|---|
| `contracts/events.test.ts` | Existing approval events (already covered) |
| `storage/storage.test.ts` | Approval repository + resolution transitions (Phase 9A) |
| `server/app.test.ts` | Approval endpoints (7 tests): create + `approval.requested` emission, run-scoped request, 404 unknown project/run/task, fetch single + list pending, resolve allow/deny (+ `approval.resolved` event), double-resolve 409, resolve unknown 404, malformed payloads |
| `server/orchestrator.test.ts` | Approval gate (5 tests): gated task blocks then approve resumes + completes, deny fails and leaves task blocked, cancel while blocked, request idempotency (pending + resolved + `(runId, kind)` reconstruction), blocked state survives a resume through `Orchestrator.resume` |

**Phase 9 tests: 12 new in Phase 9B (7 API + 5 orchestrator); storage/contracts
coverage from 9A retained. Gate applies to the linear chain and the resume
loop; plan-task (DAG) gating is not yet wired (see Roadmap note).**

### Phase 10: Model/Provider Gateway — COMPLETE

**Goal:** Honor ADR Amendment 6 — route DevMesh's own LLM calls and neutral
`provider/model-id` preferences through a `ProviderGateway` port so model
choice is provider-independent.

#### Implementation

1. `packages/runtime` (`provider.ts`): `ProviderGateway` port with
   `complete({ provider, model, messages, maxTokens })`; keep the existing
   `AgentRuntime` adapter for coding agents separate. `CompositeProviderGateway`
   routes by `provider` prefix. `FakeProviderGateway` for tests.
2. `packages/contracts` (`provider.ts`): `ProviderRequest`/`ProviderResult`
   schemas with neutral `provider/model-id` validation.
3. Neutral model preference string validated by the gateway; unknown providers
   fail with `ProviderError` (typed error).
4. `packages/server` `bootstrap.ts` (`buildProviderGateway`) wires a default
   gateway; config schema accepts `gateway: "none" | "openai-compatible"`.
5. `OpenAiCompatibleProvider` in `opencode-adapter` provides the live HTTP
   adapter (interface-complete in Phase 10; live transport in Phase 12).

#### Acceptance Criteria

- [x] `ProviderGateway` port is defined against contracts
- [x] Neutral `provider/model-id` strings are validated
- [x] Unknown provider model fails with a typed error
- [x] Coding-agent runtime stays behind `AgentRuntime` (unchanged)
- [x] Default gateway is configurable at bootstrap

#### Required Tests

| File | Tests |
|---|---|
| `contracts/provider.test.ts` | Request/result schemas, neutral ref parsing |
| `runtime/provider.test.ts` | Gateway port contract + CompositeProviderGateway + FakeProviderGateway |
| `server/bootstrap.test.ts` | Gateway wiring + config selection |

**Implemented tests: 8**

### Phase 11: Additional Agent Roles — COMPLETE

**Status:** complete.

**Goal achieved:** `planner`, `debugger`, `documenter`, and `devops` are now valid,
executable roles that can be assigned to DAG plan tasks and executed through the
existing `AgentRegistry → ExecutionService → AgentRuntime` flow, while preserving the
original 4-role pipeline (`architect → developer → tester → reviewer`).

#### Implementation

1. `packages/contracts`: added the canonical `ALL_AGENT_ROLES` (all 8 roles) as the
   source of truth for `agentRoleSchema`/`AgentRole`. `actorRoleSchema`,
   `artifactProducerSchema`, and `taskCardSchema` widen automatically through the
   existing schema relationships. `baselineProfile(role)` now handles all 8 roles
   with the approved least-privilege permission design.
2. `packages/agents`: added executable built-in manifests for `planner`, `debugger`,
   `documenter`, and `devops` (`runtime: opencode`, `autoApprove: false`,
   `maxAttempts: 2`, non-empty system instructions). The existing
   architect/developer/tester/reviewer manifests are unchanged.
3. `packages/server` orchestrator: `resolvePlanRole` is now registry-driven through a
   new `ExecutionService.isAgentExecutable(role)` helper, replacing the hardcoded
   4-role executable set. Valid registered new roles are preserved and executed (no
   silent replacement with developer); genuinely unavailable/unexecutable roles still
   fall back through the `fallbackChain`. `respectPlanRoles=false` still routes to
   developer. `planOutputSchema` now accepts all 8 agent roles.

Key properties:

- DAG plan tasks can preserve and execute the new roles.
- Backward compatible with the original 4-role pipeline.
- Least-privilege permissions for the new roles.
- No changes to the ProviderGateway / Phase 10 boundary.
- Approval and budget gates remain role-agnostic.

#### Acceptance Criteria

- [x] New roles are valid `agentRoleSchema` values
- [x] Each role has a manifest (prompt + permissions)
- [x] Plan tasks can be assigned new roles and execute
- [x] `respectPlanRoles` respects new roles
- [x] Existing 4-role pipelines still work (backward compatibility)

#### Tests

| Scope | Result |
|---|---|
| Contracts | 120 passed |
| Agents | 10 passed |
| Server | 286 passed |
| Full suite | 590 passed, 5 skipped, 0 failed |
| Typecheck | clean |
| Lint | clean |

### Phase 12: Local/OpenAI-Compatible Runtime — COMPLETE

**Goal:** Satisfy ADR Amendment 9 — support an OpenAI-compatible local/offline
model (e.g. Ollama) behind the `AgentRuntime` port without changing core.

#### Implementation

1. `packages/opencode-adapter` (`local-runtime.ts`): `OpenAiCompatibleRuntime`
   — a full `AgentRuntime` implementation that sends
   `POST {baseUrl}/chat/completions` to a local endpoint (e.g. Ollama).
   Runtime name: `opencode-local`.
2. Local model configuration: `DEVMESH_LOCAL_BASE_URL` (required),
   `DEVMESH_LOCAL_MODEL` (required), `DEVMESH_LOCAL_API_KEY` (optional),
   `DEVMESH_LOCAL_TIMEOUT_MS` (optional).
3. Local health probe: `GET {baseUrl}/models` — reports runtime health via
   `runtime.health.changed` event on bootstrap.
4. Failure/timeout semantics match the existing OpenCode adapter: provider
   failures mapped to `provider_failure`, connection failures mapped to
   `process_failure`, timeout abort via `AbortController`.
5. `packages/server` `bootstrap.ts` (`buildRuntime`): selects
   `opencode-local` → `OpenAiCompatibleRuntime` when `DEVMESH_RUNTIME` is set.
   Config schema at `config.ts` validates `localBaseUrl`/`localModel`
   as required when runtime is `opencode-local`.
6. Core/orchestrator unchanged — runtime swapped at the `AgentRuntime` port.

#### Acceptance Criteria

- [x] A local OpenAI-compatible endpoint can back an agent session
- [x] Core/orchestrator is unchanged (runtime swapped at the port)
- [x] Health probe reports the local runtime
- [x] Failure/timeout semantics match the existing adapter

#### Required Tests

| File | Tests |
|---|---|
| `opencode-adapter/adapter.test.ts` | OpenAiCompatibleRuntime: request payload, auth header, base-URL normalization, usage parsing, health probe, failure mapping, timeout, connection failure |
| `server/bootstrap.test.ts` | `runtime=opencode-local` selection + health event tagging, config validation |

**Implemented tests: 17 (all passing)**

**Test baseline after Phase 12 (actual):** 607 passed, 5 skipped, 0 failed.
Typecheck clean. Lint clean.

### Phase 13: Frontend/UI (Future, Not Yet Started)

**Goal:** ADR Amendment 7 explicitly defers a frontend; when pursued it should
surface pipeline runs, live SSE events (Phase 6C), artifacts, and usage.

#### Prerequisite Note

The existing backend exposes pipeline, task, SSE, artifact, and approval APIs.
Usage summaries already exist in storage (`summarizeRunUsage`,
`summarizeTaskUsage` in `repos.ts`) but require a minimal
`GET /pipelines/:runId/usage` REST endpoint before the usage acceptance
criterion can be satisfied. This is the only backend gap.

#### Implementation

1. Serve a static UI from the Fastify server (or a separate client package)
   consuming the existing REST + SSE APIs — no new backend surface required.
2. Views: pipeline list/detail, live event stream, artifact viewer, task DAG,
   usage/cost rollups (Phase 8B), approval queue (Phase 9).

#### Acceptance Criteria

- [ ] Read-only views over existing APIs, no backend changes (or minimal)
- [ ] Live SSE pipeline event stream rendered in-browser
- [ ] Usage rollups displayed from run/task summaries

#### Required Tests

| File | Tests |
|---|---|
| `server/app.test.ts` | Static route served; API contracts unchanged |

**Estimated new tests: ~2** (mostly manual/visual)

### Phase 14: Security Hardening — AuthN/Z, Permissions, MCP & Plugin Packaging (Future, Not Yet Started)

**Goal:** Production-hardening items referenced across the ADR and README:
authentication/authorization for a multi-user deployment, wiring the existing
`permission.requested`/`permission.resolved` events, and packaging the OpenCode
plugin and MCP server.

#### Implementation

1. **AuthN/Z** (`packages/auth` new): API token / bearer authn, per-project
   authorization; a single-user mode remains the default.
2. **Permissions**: route `permission.requested` / `permission.resolved`
   through a policy check in the orchestrator; deny-by-default for flagged
   actions.
3. **OpenCode plugin**: package the plugin shipped into projects.
4. **MCP server**: expose DevMesh state (pipelines, artifacts, context) to
   tools over MCP.

#### Acceptance Criteria

- [ ] Unauthenticated requests are rejected in multi-user mode
- [ ] Per-project authorization is enforced
- [ ] Permission request/resolve events drive a policy decision
- [ ] OpenCode plugin packages and installs into a project
- [ ] MCP server exposes pipelines/artifacts/context

#### Required Tests

| File | Tests |
|---|---|
| `auth/auth.test.ts` (new) | Token auth, project authorization |
| `server/app.test.ts` | Auth middleware, permission flow, MCP routes |
| `integrations/plugin.test.ts` (new) | Plugin packaging/install |

**Estimated new tests: ~12**

---

## Phase 8 Total

| Sub-phase | Focus | Tests | Status | Key Risk (as assessed) |
|---|---|---|---|---|
| 8A | Usage reporting + persistence | ~6 (adapter, runtime, storage, service) | done | Low — additive columns + boundary validation |
| 8B | Usage aggregation | 11 new storage tests | done | Low — pure read-only SQL aggregation |
| 8C | Cost pricing + budget enforcement | 47 new (pricing, budget gate/ledger, service, orchestrator) | done | Low — integer-only arithmetic; conservative default when unconfigured |

---

## Remaining Roadmap (Future Phases — Not Yet Started)

| Phase | Focus | ADR Ref | Est. Tests | Status |
|---|---|---|---|---|
| 8C | Cost pricing + budget enforcement | Consequence | ~10 | ✅ Complete (47 tests) |
| 9 | Approval flow | Events catalog | ~10 | ✅ Complete (12 new Phase 9B tests; 9A storage covered) |
| 10 | Model/provider gateway | Amendment 6 | ~8 | ✅ Complete |
| 11 | Additional agent roles | Amendment 3 | ~8 | ✅ Complete |
| 12 | Local/offline model adapter | Amendment 9 | ~5 | ✅ Complete (17 tests) |
| 13 | Frontend/UI | Amendment 7 | ~2 | Not started |
| 14 | Security hardening, permissions, MCP & plugin packaging | ADR/README | ~12 | Not started |

> Phases 13–14 are **planned only** — none are implemented. Detailed goals,
> acceptance criteria, and required tests for each appear above.
>
> **Roadmap note (Phase 9B boundary):** the approval gate currently guards the
> linear chain (initial run + resume). Multi-task plan (DAG) tasks — Phase 7F —
> are not yet gateable; wiring the gate into the DAG scheduler is the natural
> next increment. All other Phase 9 acceptance criteria are met.
>
> **Phase 13 prerequisite:** usage summaries exist in storage
> (`summarizeRunUsage`/`summarizeTaskUsage`) but require a minimal
> `GET /pipelines/:runId/usage` REST endpoint before the usage acceptance
> criterion can be satisfied.

---

## Appendix: Test File Inventory (post Phase 9B)

| File | Tests | Area |
|---|---|---|
| `contracts/src/common.test.ts` | 7 | Path safety, schemas |
| `contracts/src/ids.test.ts` | 4 | Branded ID uniqueness |
| `contracts/src/tasks.test.ts` | 7 | Task state machine |
| `contracts/src/events.test.ts` | 5 | Event parsing |
| `contracts/src/artifacts.test.ts` | 21 | Artifact validation |
| `contracts/src/context.test.ts` | 5 | Context entries |
| `contracts/src/manifest.test.ts` | 4 | Agent manifests |
| `contracts/src/pipeline.test.ts` | 7 | Pipeline run schema |
| `contracts/src/pricing.test.ts` | 7 | Pricing schema + unit conversion (8C) |
| `runtime/src/fake.test.ts` | 6 | FakeRuntime (incl. structured output) |
| `agents/src/agents.test.ts` | 8 | Registry + builtins |
| `opencode-adapter/src/adapter.test.ts` | 7 | Adapter integration |
| `storage/src/storage.test.ts` | 94 | All repositories + migrations + diagnostics + usage aggregation (incl. committed-only 8C variants) + approvals (9A) |
| `workspace/src/git.test.ts` | 20 | Git operations + checkpoints |
| `workspace/src/locks.test.ts` | 6 | MutexMap |
| `workspace/src/paths.test.ts` | 5 | Path safety |
| `workspace/src/service.test.ts` | 13 | Workspace service |
| `server/src/app.test.ts` | 59 | HTTP API (incl. context/resume/approval endpoints) |
| `server/src/orchestrator.test.ts` | 110 | Orchestrator (DAG, replay, structured, resume, lifecycle, approval gate) |
| `server/src/executions.test.ts` | 21 | Execution service |
| `server/src/executions/verify.test.ts` | 17 | Independent test replay verification |
| `server/src/executions/pricing.test.ts` | 10 | PriceTable + derived cost (8C) |
| `server/src/executions/budget.test.ts` | 17 | Budget evaluation + ledger (8C) |
| `server/src/executions/budget-service.test.ts` | 9 | Budget gate + derived cost via HTTP (8C) |
| `server/src/budget-orchestrator.test.ts` | 4 | Orchestrator budget reaction (8C) |
| `server/src/pipeline-sse.test.ts` | 24 | SSE streaming |
| `server/src/orchestrator-real.test.ts` | 1 | Real OpenCode (gated) |
| `server/src/opencode-real.test.ts` | 4 | Real OpenCode E2E (gated) |
| **Total (listed)** | **491 `it(`/`test(` occurrences summed** | 9B adds 12 across app + orchestrator suites |

> Counts above reflect the `it(`/`test(` occurrences per file and are
> approximate (vitest's numeric total includes dynamically-defined subtests);
> the authoritative number comes from `npm test` (607 passed, 5 skipped, 0 failed).

### Known Test Gaps — all resolved

| Gap | Resolution |
|---|---|
| `ExecutionRepository` — 0 tests | ✅ Phase 6F |
| `RevisionCycleRepository` — 0 tests | ✅ Phase 6F |
| `EventBus` / `EventRepository.attachBus()` — 0 tests | ✅ Phase 6F |
| `EventRepository.listByRunAfter()` — 0 tests | ✅ Phase 6F |
| `TaskRepository.listByProject()` — 0 tests | ✅ Phase 6F |
| `withTransaction` rollback path — 0 tests | ✅ Phase 6F |
