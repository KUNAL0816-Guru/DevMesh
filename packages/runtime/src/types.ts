/** Terminal outcomes of an agent execution (task-level, not process-level). */
export const executionStatuses = ["completed", "failed", "timeout", "cancelled"] as const;
export type ExecutionStatus = (typeof executionStatuses)[number];

/** Where an agent run happens: absolute path, pre-approved by DevMesh core. */
export interface AgentExecutionRequest {
  /** DevMesh execution id (uuid) — correlates events, artifacts, and logs. */
  executionId: string;
  projectId: string;
  /**
   * The ONLY directory the runtime may operate in. Resolved by
   * WorkspaceService (realpath) — never taken from model output.
   */
  workspaceRoot: string;
  instruction: string;
  timeoutMs: number;
  /** Optional runtime-specific model selector, e.g. "anthropic/claude-...". */
  model?: string;
}

export type AgentStreamEvent =
  | { kind: "session"; sessionId?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool?: string; status?: string }
  | { kind: "error"; message: string };

export interface AgentExecutionResult {
  status: ExecutionStatus;
  exitCode: number | null;
  /** Runtime session reference when the runtime exposes one. */
  sessionId?: string;
  /** Concatenated assistant text parts observed on the stream. */
  finalText: string;
  stderrTail: string;
  durationMs: number;
  failureReason?: string;
}

/**
 * A live execution handle. `result` resolves exactly once with the task-level
 * outcome; it rejects ONLY for DevMesh-side runtime failures (e.g. binary
 * missing). Task-level failure is a resolved result with status "failed".
 */
export interface RunningExecution {
  readonly executionId: string;
  /** Subscribe before awaiting result; late subscribers get nothing. */
  onEvent(handler: (event: AgentStreamEvent) => void): void;
  cancel(reason?: string): Promise<void>;
  readonly result: Promise<AgentExecutionResult>;
}

export interface AgentRuntime {
  /** Stable runtime identifier ("opencode", "fake", ...). */
  readonly name: string;
  start(request: AgentExecutionRequest): RunningExecution;
  /**
   * Whether this runtime can execute an agent whose definition targets
   * `agentRuntimeName`. Defaults to strict name equality when absent.
   * Test/fake runtimes may accept any agent to exercise the pipeline.
   */
  supportsAgent?(agentRuntimeName: string): boolean;
  /** Cheap liveness/version probe; may throw RuntimeError. */
  health?(): Promise<{ healthy: boolean; version?: string }>;
}
