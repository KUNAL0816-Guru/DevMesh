export type PipelineRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "in_review"
  | "revising"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled";

export type ArtifactKind =
  | "spec"
  | "plan"
  | "change_set"
  | "test_report"
  | "review"
  | "verification";

export type AgentRole =
  | "architect"
  | "developer"
  | "tester"
  | "reviewer"
  | "planner"
  | "debugger"
  | "documenter"
  | "devops";

export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

export interface PipelineRun {
  id: string;
  projectId: string;
  status: PipelineRunStatus;
  goal: string;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface TaskCard {
  id: string;
  runId: string;
  projectId: string;
  role: AgentRole;
  title: string;
  detail: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  artifacts: string[];
}

export interface Artifact {
  id: string;
  schemaVersion: number;
  runId: string;
  projectId: string;
  taskId?: string;
  producedBy: AgentRole | "system";
  kind: ArtifactKind;
  payload: unknown;
  createdAt: string;
}

export interface Execution {
  id: string;
  runId: string;
  projectId: string;
  taskId: string | null;
  agentId: string | null;
  role: AgentRole | null;
  runtime: string | null;
  status: string;
  failureKind: string | null;
  instruction: string;
  sessionRef: string | null;
  exitCode: number | null;
  stoppedReason: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  resultArtifactId: string | null;
  verificationArtifactId: string | null;
}

export interface DomainEvent {
  seq: number;
  ts: string;
  runId?: string;
  projectId?: string;
  actor?: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Aggregate token/cost usage for a set of executions, mirroring the server's
 * `ExecutionUsage` returned by `GET /pipelines/:runId/usage`.
 *
 * Semantics (server-side aggregation, not re-derived in the client):
 * - A null dimension is UNKNOWN (not zero): some executions had no usage or
 *   mixed known/unknown values, so that total cannot be truthfully summed.
 * - An empty scope yields `0` totals with `unknownExecutionCount: 0`.
 */
export interface ExecutionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsdMicros: number | null;
  currency: string | null;
  usageSource: "reported" | "derived" | null;
}

export interface TaskUsageSummary {
  taskId: string;
  runId: string;
  role: string;
  title: string;
  executionCount: number;
  unknownExecutionCount: number;
  totals: ExecutionUsage;
}

export interface RunUsage {
  runId: string;
  projectId: string;
  executionCount: number;
  unknownExecutionCount: number;
  totals: ExecutionUsage;
  perTask: TaskUsageSummary[];
}

export interface ApiError {
  error: { code: string; message: string };
}
