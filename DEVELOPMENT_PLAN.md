# DevMesh Development Plan

> Status: active
> Last updated: 2026-08-26 (post Phase 6F)
> Reference: docs/adr/0001-approved-architecture.md
> Test baseline: 282 passed, 5 skipped, 0 failed

---

## Current State Summary

DevMesh is a multi-agent AI software engineering platform. A user describes a
project; four specialized agents (architect, developer, tester, reviewer)
collaborate to build it inside a git workspace. The control plane is a single
Node.js process (hexagonal modular monolith) with seven packages. The initial
agent runtime is OpenCode behind a swappable adapter port.

**What works today:**
- Full pipeline execution: architect → developer → tester → reviewer
- Revision loops: tester failures and reviewer rejections route back to developer
- Doom-loop detection with configurable threshold
- Git checkpoint/rollback around developer stages
- Execution verification: SHA-256 re-hashing of claimed file changes
- Pipeline persistence, query API, SSE event streaming, cancellation
- 4 agent definitions with role-specific permissions and system prompts
- SQLite storage with 6 migrations, 8 repositories
- Workspace service with symlink escape protection and FIFO mutex locking

---

## Package Map

```
packages/
  contracts/       Zod schemas, branded IDs, task state machine, event catalog,
                   artifact types, context entries, prompts, pipeline run schema
  runtime/         AgentRuntime port interface, FakeRuntime, RuntimeError
  storage/         SQLite persistence (node:sqlite), 8 repositories, 6 migrations
  workspace/       Git facade, file I/O, path safety, per-key async mutex
  agents/          AgentRegistry, 4 built-in agent definitions
  opencode-adapter/ OpenCode CLI adapter (NDJSON, process-group kill)
  server/          Fastify HTTP server, orchestrator, execution service,
                   verification, artifact builder, SSE streaming
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

- [ ] `updateStatus()` rejects writes to terminal-status pipeline runs
- [ ] Concurrent cancel + stage-completion results in exactly one terminal
      event and one status update
- [ ] `cancel()` called twice emits exactly one `run.cancelled` event
- [ ] `emitEvent` deduplicates identical event types per run
- [ ] Git rollback is skipped when workspace is already at checkpoint
- [ ] Zero `catch {}` (empty catch) blocks in orchestrator and execution
      pipeline
- [ ] Every `catch` clause has either a re-throw, structured logging with
      error classification, or a `// SAFETY:` justification
- [ ] All existing orchestrator, cancellation, and SSE tests pass

#### Required Tests

| File | Tests |
|---|---|
| `orchestrator.test.ts` | Terminal-state rejection (cancel on completed fails no-op), concurrent cancel + completion races, cancel idempotency (single event), emitEvent deduplication, git rollback idempotency, error classification: transient retry, corrupt data fails stage, non-critical side-effect logged not fatal |
| `pipeline-sse.test.ts` | Duplicate terminal events suppressed in stream |

**Estimated new tests: ~10**

---

### Phase 6F: Pipeline Observability & Reliability

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

- [ ] `ExecutionRepository` has full CRUD + listByRun test coverage
- [ ] `RevisionCycleRepository` has full CRUD + listByRun test coverage
- [ ] `EventBus.attachBus()` propagation and isolation tested
- [ ] `EventRepository.listByRunAfter()` pagination and ordering tested
- [ ] `TaskRepository.listByProject()` ordering and isolation tested
- [ ] `withTransaction` rollback path tested
- [ ] `pipelineRunSummary()` returns correct stage timings and counts
- [ ] `pipelineHealth()` returns correct status counts and averages
- [ ] `assertPipelineConsistency()` passes on a well-formed pipeline run
- [ ] All existing tests pass (no regressions)

#### Required Tests

| File | Tests |
|---|---|
| `storage.test.ts` | ExecutionRepository CRUD + listByRun, RevisionCycleRepository CRUD + listByRun, EventBus propagation + isolation, EventRepository.listByRunAfter pagination + ordering, TaskRepository.listByProject ordering + isolation, withTransaction rollback path, pipelineRunSummary correctness, pipelineHealth correctness |
| `orchestrator.test.ts` | assertPipelineConsistency passes after full pipeline run, assertPipelineConsistency catches missing execution link |

**Estimated new tests: ~16**

---

## ADR Gaps (requirements from 0001 not yet met)

| ADR Ref | Requirement | Current Status |
|---|---|---|
| Amendment 5a | Test reports reference an exact invocation; DevMesh replays it | ❌ Only via optional `verificationCommand` on execution endpoint; not automatic from `test_report` artifacts |
| Amendment 5b | Unverifiable claims fail the task | ⚠️ Partial — file hash verification works; test replay not enforced in pipeline flow |
| Consequence | Resumable runs | ❌ Failed/cancelled pipelines must restart from scratch |
| Consequence | Budget enforcement (token/cost) | ❌ Attempt limits only; no token or cost tracking |
| Context | Context entries as derived facts | ⚠️ Write-only — orchestrator populates but no REST API to read |

---

## Technical Debt (known, tracked)

| ID | Description | Severity |
|---|---|---|
| TD-1 | `artifact-builder.ts` uses regex text-parsing to extract structured data from agent free-text. Fragile across models and prompt phrasings. | high |
| TD-2 | Orchestrator hard-codes a 4-role linear chain ignoring the plan artifact's task DAG and dependency graph | high |
| TD-3 | `ExecutionRepository` (0 tests), `RevisionCycleRepository` (0 tests), `EventBus.attachBus()` (0 tests), `EventRepository.listByRunAfter()` (0 tests) | medium → Phase 6F |
| TD-4 | `withTransaction` rollback path in `db.ts` is untested | medium → Phase 6F |
| TD-5 | Best-effort `catch {}` blocks silently swallow errors in orchestrator (event persistence, artifact creation, git checkpoints) | medium → Phase 6E |
| TD-6 | README.md still describes Phase 0 as current with Phase 1-3 as TODO | low |
| TD-7 | Synchronous `node:sqlite` `DatabaseSync` blocks event loop during queries | low |
| TD-8 | `FailureKind` string union not backed by a Zod validation schema | low |

---

## Phase 7: Context API + Pipeline Resumability + Structured Output

Phase 7 addresses the highest-impact ADR gaps while keeping changes additive
(no breaking changes to the `AgentRuntime` port). It assumes Phases 6E/6F
are complete: lifecycle mutations are terminal-state-safe, error handling is
classified, and repository/event-bus coverage is established. It is split
into six sub-phases.

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

- [ ] `GET /projects/:id/context` returns all latest entries grouped by namespace
- [ ] `GET /projects/:id/context/:namespace` returns only entries in that namespace
- [ ] `GET /projects/:id/context/:namespace/history/:key` returns version chain in
      chronological order
- [ ] `POST /projects/:id/context` creates an entry with server-assigned id/timestamp
- [ ] Superseded entries are excluded from default GET but included in history
- [ ] 404 for non-existent project; 400 for invalid namespace or body
- [ ] Project ownership enforced (pipeline-scoped entries not leaked across projects)

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

- [ ] Migration 7 creates `pipeline_stages` table with correct schema
- [ ] Migration is idempotent across reopens
- [ ] Orchestrator inserts 4 stage rows on pipeline start
- [ ] Stage status transitions are persisted (pending→running→completed/failed/cancelled)
- [ ] `execution_id` and `task_id` are recorded for each completed stage
- [ ] `getLastCompleted()` returns the last stage with `status: "completed"`
- [ ] Stage rows survive database close/reopen (durability)
- [ ] Stage rows are updated on cancellation (terminal stage marked cancelled)

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

- [ ] `POST /pipelines/:runId/resume` returns 202 with updated pipeline on
      valid resume
- [ ] Returns 409 if pipeline is `running` or `completed`
- [ ] Returns 404 if pipeline does not exist
- [ ] Resumed pipeline skips stages that were `completed` before failure
- [ ] Task cards are created only for remaining stages
- [ ] `pipeline_runs.status` transitions back to `running` then to terminal
- [ ] Context entry records the resume origin (which stage, which prior run)
- [ ] Git workspace is clean before resume (rollback if needed)
- [ ] Resume is idempotent (calling twice on same terminal run produces
      consistent results)
- [ ] All existing pipeline behaviors work normally on resumed runs (revision
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

- [ ] `AgentExecutionRequest.outputFormat` is accepted by the runtime port
- [ ] `AgentExecutionResult.structured` carries parsed JSON from the agent
- [ ] `OpencodeAdapter` passes `outputFormat` to the OpenCode CLI
- [ ] `FakeRuntime` supports `structured` in scripted outcomes
- [ ] Orchestrator sends `outputFormat` for spec, plan, test_report, and
      review stages
- [ ] Orchestrator uses `structured` output when available and valid
- [ ] Orchestrator falls back to text-parsing when structured output is
      unavailable or invalid
- [ ] `artifact-builder.ts` remains as fallback; no behavior change when
      structured output is not available
- [ ] All existing tests pass (FakeRuntime tests updated for new field)

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

- [ ] After tester stage, orchestrator extracts test command from `test_report`
      artifact
- [ ] Command is replayed in the workspace root
- [ ] `verification.v1` artifact is produced with `command_replay` check
- [ ] If replay contradicts tester verdict, pipeline enters revision loop
- [ ] If replay command cannot execute (missing binary), recorded as
      inconclusive and does not fail the stage
- [ ] Replay timeout is bounded (configurable, default 60s)
- [ ] Replay does not execute destructive commands (reuses existing safety
      patterns from `verify.ts`)
- [ ] All existing orchestrator tests pass

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

- [ ] Orchestrator parses `PlanPayload` from plan artifact after architect
      stage
- [ ] `validatePlanIntegrity()` is called; invalid plans fail the pipeline
- [ ] Topological sort determines execution order from dependency graph
- [ ] Tasks are executed in dependency order (ready tasks run before dependents)
- [ ] Each plan task creates a `TaskCard` with correct `role` and `dependsOn`
- [ ] Concurrent execution respects `maxConcurrency` limit
- [ ] Pipeline completes when all plan tasks are `done`
- [ ] Pipeline fails when any task exhausts attempts
- [ ] Revision loops work per-plan-task (tester/reviewer failures route back
      to the responsible developer task)
- [ ] Fallback to linear chain when plan has a single task or no plan artifact
- [ ] Doom-loop detection works per-plan-task
- [ ] Git checkpoints/rollback work per developer-task execution

#### Required Tests

| File | Tests |
|---|---|
| `orchestrator.test.ts` | Plan parsing from architect output, invalid plan fails pipeline, topological execution order, tasks created with correct dependencies, concurrent execution (maxConcurrency=2), single-task fallback to linear chain, no-plan-artifact fallback, per-task revision loops, per-task doom-loop detection, pipeline completes when all tasks done, pipeline fails on task exhaustion |

**Estimated new tests: ~14**

---

## Phase 7 Total Estimates

| Sub-phase | Focus | New Tests | Key Risk |
|---|---|---|---|
| 7A | Context API | ~10 | Low — additive REST endpoints |
| 7B | Stage Persistence | ~10 | Low — new table + repository |
| 7C | Resumable Pipelines | ~14 | Medium — orchestrator resume logic complexity |
| 7D | Structured Output | ~10 | Medium — runtime port interface change, adapter integration |
| 7E | Independent Test Replay | ~8 | Medium — command extraction from agent text, inconclusive handling |
| 7F | Dynamic DAG Execution | ~14 | High — fundamental orchestrator redesign, concurrency |
| **Total** | | **~66** | |

**Projected test baseline after Phase 7:** 282 + ~66 = **~348 tests**

---

## Phase 8+ (Future, Not Planned Yet)

These capabilities are referenced in the ADR or README but are out of scope
for Phase 7:

| Capability | ADR Ref | Notes |
|---|---|---|
| Token/cost budget enforcement | Consequence | Track `usage` from `AgentReply`; enforce per-run and per-task budgets |
| Authentication/authorization | — | Not in ADR; single-user environment |
| Approval flow | Events catalog | `approval.requested`/`approval.resolved` events exist but not wired to endpoints |
| Model/provider gateway | Amendment 6 | ADR mentions it; no implementation exists |
| Additional agent roles | Amendment 3 | `planner`, `debugger`, `documenter`, `devops` in `PLANNED_AGENT_ROLES` |
| MCP server | README layout | Future |
| OpenCode plugin | README layout | Future |
| Frontend/UI | Amendment 7 | Explicitly deferred |
| Ollama/local-model adapter | Amendment 9 | Deferred; adapter shape keeps the door open |

---

## Appendix: Test File Inventory (post Phase 6D)

| File | Tests | Area |
|---|---|---|
| `contracts/src/common.test.ts` | 4 | Path safety, schemas |
| `contracts/src/ids.test.ts` | 3 | Branded ID uniqueness |
| `contracts/src/tasks.test.ts` | 4 | Task state machine |
| `contracts/src/events.test.ts` | 3 | Event parsing |
| `contracts/src/artifacts.test.ts` | 6 | Artifact validation |
| `contracts/src/context.test.ts` | 3 | Context entries |
| `contracts/src/manifest.test.ts` | 3 | Agent manifests |
| `contracts/src/pipeline.test.ts` | 3 | Pipeline run schema |
| `runtime/src/fake.test.ts` | 4 | FakeRuntime |
| `agents/src/agents.test.ts` | 8 | Registry + builtins |
| `opencode-adapter/src/adapter.test.ts` | 5 | Adapter integration |
| `storage/src/storage.test.ts` | 18 | All repositories + migrations |
| `workspace/src/git.test.ts` | 17 | Git operations + checkpoints |
| `workspace/src/locks.test.ts` | 6 | MutexMap |
| `workspace/src/paths.test.ts` | 5 | Path safety |
| `workspace/src/service.test.ts` | 13 | Workspace service |
| `server/src/app.test.ts` | 32 | HTTP API |
| `server/src/orchestrator.test.ts` | 40 | Orchestrator |
| `server/src/executions.test.ts` | 21 | Execution service |
| `server/src/pipeline-sse.test.ts` | 22 | SSE streaming |
| `server/src/orchestrator-real.test.ts` | 1 | Real OpenCode (gated) |
| `server/src/opencode-real.test.ts` | 4 | Real OpenCode E2E (gated) |
| **Total** | **~282** | |

### Known Test Gaps (addressed by Phase 6F)

| Gap | Target |
|---|---|
| `ExecutionRepository` — 0 tests | Phase 6F |
| `RevisionCycleRepository` — 0 tests | Phase 6F |
| `EventBus` / `EventRepository.attachBus()` — 0 tests | Phase 6F |
| `EventRepository.listByRunAfter()` — 0 tests | Phase 6F |
| `TaskRepository.listByProject()` — 0 tests | Phase 6F |
| `withTransaction` rollback path — 0 tests | Phase 6F |
