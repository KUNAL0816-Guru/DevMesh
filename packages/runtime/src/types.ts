import type { PermissionResource } from "@devmesh/contracts";

/** Terminal outcomes of an agent execution (task-level, not process-level). */
export const executionStatuses = ["completed", "failed", "timeout", "cancelled"] as const;
export type ExecutionStatus = (typeof executionStatuses)[number];

/**
 * Phase 14D: vendor-neutral per-tool permission intercept. A live runtime
 * (e.g. the OpenCode serve-mode broker) raises one of these for every tool
 * call it is asked to gate, BEFORE the tool executes, and DevMesh core answers
 * it via the policy engine. `resource` is a contracts `PermissionResource`;
 * `tool` stays opaque vendor text; `target` is the concrete argument being
 * acted on (file path, command line, URL) when one is known.
 */
export interface ToolPermissionRequest {
  /** The DevMesh execution the tool call belongs to. */
  executionId: string;
  /** Contracts permission resource ("read", "edit", "bash", ...). */
  resource: PermissionResource;
  /** Opaque runtime tool name (e.g. "edit"); never interpreted by core. */
  tool: string;
  /**
   * Concrete argument being acted on (file path, command, URL).
   */
  target?: string;
  /**
   * Vendor pattern strings the ask was raised for (informational only).
   */
  patterns?: string[];
  /**
   * Stable vendor-native permission request id (e.g. the OpenCode `per_...`
   * id) when the runtime surfaces one. Used for EXACT per-request approval
   * correlation: the same id means the same permission request (a retry or
   * redelivery) and must never be shared across distinct requests. Absent for
   * runtimes without request ids — core then mints an execution-scoped
   * identity so every tool ask still owns its own approval.
   */
  requestId?: string;
}

/** The answer core gives a live tool request: execute or block the tool. */
export interface ToolPermissionDecision {
  decision: "allow" | "deny";
  /** Human-readable reason for the reply (surfaced in events and logs). */
  reason: string;
}

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
  /**
   * Request that the agent emit structured JSON for this execution.
   * The runtime relays the `name`/`schema` to the underlying agent so it
   * produces machine-parseable output; when present, the parsed JSON is
   * surfaced on `AgentExecutionResult.structured`.
   */
  outputFormat?: {
    name: string;
    /** JSON Schema the structured output should conform to. */
    schema: Record<string, unknown>;
  };
  /**
   * Per-request auto-approval override (Phase 14C). DevMesh core decides this
   * from the permission policy BEFORE the runtime is started; `true` asks the
   * runtime to blanket-approve permission prompts (OpenCode `--auto`),
   * `false`/absent keeps the runtime's configured default. Only an ALLOW
   * policy decision ever sets this to true.
   */
  autoApprove?: boolean;
  /**
   * Phase 14D live per-tool permission interception. When provided, the
   * runtime surfaces every tool call it gates as an out-of-band request and
   * only lets the tool run when the handler returns `allow`. When absent, the
   * runtime applies its configured posture and auto-blocks unknown asks
   * (DevMesh fail-closed default). OpenCode specifics stay in the adapter;
   * this port is vendor-neutral.
   */
  onToolPermission?: (request: ToolPermissionRequest) => Promise<ToolPermissionDecision>;
}

export type AgentStreamEvent =
  | { kind: "session"; sessionId?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool?: string; status?: string }
  | { kind: "error"; message: string };

/**
 * Token usage as reported by the runtime adapter. The runtime states this
 * TRUTH directly (tokens only — cost is never a runtime constant; DevMesh
 * derives or trusts reported cost separately). Absent when the runtime
 * cannot measure usage; that absence is never upgraded to a guessed number.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

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
  /**
   * Parsed structured JSON output when the request carried an `outputFormat`
   * and the agent produced it. Optional: absent when the agent did not emit
   * structured output or it could not be parsed.
   */
  structured?: unknown;
  /**
   * Token usage reported by the runtime. Absent when the runtime cannot
   * measure usage — never fabricated or estimated by DevMesh.
   */
  usage?: AgentUsage;
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
  /**
   * Release runtime-owned resources (e.g. a long-lived serve-mode broker
   * process) at shutdown. Idempotent; optional for runtimes with nothing to
   * clean up.
   */
  dispose?(): Promise<void>;
}
