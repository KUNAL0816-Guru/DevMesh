import type { PermissionResource } from "@devmesh/contracts";
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRuntime,
  AgentStreamEvent,
  AgentUsage,
  ExecutionStatus,
  RunningExecution,
  ToolPermissionDecision,
} from "./types.js";

export interface FakeStep {
  /** Events emitted on the stream when this step begins. */
  events?: AgentStreamEvent[];
  /**
   * Phase 14D: serve-mode-style tool calls this step raises mid-run, each
   * answered through the request's `onToolPermission` handler (the same port
   * the external broker uses). The decisions are recorded on the runtime for
   * assertions; a step with unanswered asks fails closed.
   */
  toolAsks?: Array<{ resource: PermissionResource; tool: string; target?: string; requestId?: string }>;
  /** Side effect against the workspace (simulates the agent editing files). */
  effect?: () => void | Promise<void>;
}

/** The scripted terminal outcome of a fake run. */
export interface FakeOutcome {
  status: ExecutionStatus;
  exitCode?: number;
  sessionId?: string;
  finalText?: string;
  stderrTail?: string;
  failureReason?: string;
  /** Structured JSON output surfaced on result.structured (see outputFormat). */
  structured?: unknown;
  /**
   * Token usage reported on the outcome path. Honored for the status the
   * scripted outcome declares (including failed/timeout runtimes that did
   * measure usage); cancelled/cut-off paths surface nothing.
   */
  usage?: AgentUsage;
}

export interface FakeScript {
  steps?: FakeStep[];
  outcome: FakeOutcome;
  /** Artificial delay per step (default 10ms). */
  stepDelayMs?: number;
}

/** A function that returns a FakeScript based on the execution request. */
export type FakeScriptFactory = (request: AgentExecutionRequest) => FakeScript;

interface LiveRun {
  cancelled: boolean;
  cancelReason?: string;
  timers: NodeJS.Timeout[];
  /** Wakes pending step sleeps immediately when the run is cancelled. */
  wakeFns: Set<() => void>;
}

/**
 * Deterministic in-process runtime for tests and offline development.
 * Runs the scripted steps (events + workspace side effects), then resolves
 * with the scripted outcome. Honors cancellation and request.timeoutMs so
 * the full ExecutionService lifecycle can be exercised without processes.
 */
export class FakeRuntime implements AgentRuntime {
  readonly name = "fake";
  private readonly scriptOrFactory: FakeScript | FakeScriptFactory;
  private readonly live = new Map<string, LiveRun>();
  /** Phase 14D: tool name -> decision recorded per execution. */
  private readonly toolDecisions = new Map<string, Map<string, ToolPermissionDecision>>();

  constructor(script: FakeScript | FakeScriptFactory) {
    this.scriptOrFactory = script;
  }

  /** Fakes serve any agent definition so the full pipeline is testable. */
  supportsAgent(): boolean {
    return true;
  }

  isRunning(executionId: string): boolean {
    return this.live.has(executionId);
  }

  /** Last Phase 14D decision the fake recorded for a tool in an execution. */
  toolDecision(executionId: string, tool: string): ToolPermissionDecision | undefined {
    return this.toolDecisions.get(executionId)?.get(tool);
  }

  start(request: AgentExecutionRequest): RunningExecution {
    const script =
      typeof this.scriptOrFactory === "function"
        ? this.scriptOrFactory(request)
        : this.scriptOrFactory;
    const handlers: Array<(e: AgentStreamEvent) => void> = [];
    const run: LiveRun = { cancelled: false, timers: [], wakeFns: new Set() };
    this.live.set(request.executionId, run);

    let resolveResult!: (r: AgentExecutionResult) => void;
    let rejectResult!: (err: unknown) => void;
    const result = new Promise<AgentExecutionResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const startedAt = Date.now();
    const deadline = startedAt + Math.max(request.timeoutMs, 1);
    const delay = script.stepDelayMs ?? 10;

    const finish = (r: Omit<AgentExecutionResult, "durationMs">) => {
      for (const t of run.timers) clearTimeout(t);
      run.timers.length = 0;
      for (const wake of run.wakeFns) wake();
      run.wakeFns.clear();
      this.live.delete(request.executionId);
      resolveResult({ ...r, durationMs: Math.max(Date.now() - startedAt, 0) });
    };

    const emit = (e: AgentStreamEvent): void => {
      for (const h of handlers) {
        try {
          h(e);
        } catch {
          /* handler errors must not break the stream */
        }
      }
    };

    const execute = async (): Promise<void> => {
      if (!request.workspaceRoot || !request.instruction) {
        rejectResult(
          new Error("runtime/invalid-request: workspaceRoot and instruction are required"),
        );
        return;
      }
      for (const step of script.steps ?? []) {
        if (run.cancelled) break;
        if (Date.now() >= deadline) break;
        for (const e of step.events ?? []) emit(e);
        // Phase 14D: answer the step's tool calls through the onToolPermission
        // port exactly like the serve-mode broker does, one ask at a time.
        for (const ask of step.toolAsks ?? []) {
          if (run.cancelled) break;
          let decision: ToolPermissionDecision;
          if (request.onToolPermission) {
            decision = await request.onToolPermission({
              executionId: request.executionId,
              resource: ask.resource,
              tool: ask.tool,
              ...(ask.target !== undefined ? { target: ask.target } : {}),
              ...(ask.requestId !== undefined ? { requestId: ask.requestId } : {}),
            });
          } else {
            // Same fail-closed posture as the broker with no handler attached.
            decision = { decision: "deny", reason: "no permission handler attached — fail closed" };
          }
          let perTool = this.toolDecisions.get(request.executionId);
          if (!perTool) {
            perTool = new Map();
            this.toolDecisions.set(request.executionId, perTool);
          }
          perTool.set(ask.tool, decision);
        }
        // interruptible sleep, capped by the timeout budget so deadlines fire
        const budgetLeft = Math.max(deadline - Date.now(), 1);
        const slept = await new Promise<boolean>((res) => {
          const wake = (): void => {
            clearTimeout(t);
            run.wakeFns.delete(wake);
            res(false);
          };
          const t = setTimeout(() => {
            run.wakeFns.delete(wake);
            res(true);
          }, Math.min(delay, budgetLeft));
          run.timers.push(t);
          if (run.cancelled) {
            wake();
            return;
          }
          run.wakeFns.add(wake);
        });
        if (!slept || run.cancelled || Date.now() >= deadline) break;
        await step.effect?.();
      }

      if (run.cancelled) {
        finish({
          status: "cancelled",
          exitCode: null,
          finalText: "",
          stderrTail: "",
          failureReason: run.cancelReason ?? "cancelled",
        });
        return;
      }
      if (Date.now() >= deadline && script.outcome.status !== "timeout") {
        finish({
          status: "timeout",
          exitCode: null,
          finalText: "",
          stderrTail: "",
          failureReason: `exceeded ${request.timeoutMs}ms budget`,
        });
        return;
      }
      const o = script.outcome;
      finish({
        status: o.status,
        exitCode: o.exitCode ?? (o.status === "completed" ? 0 : 1),
        sessionId: o.sessionId,
        finalText: o.finalText ?? "",
        stderrTail: o.stderrTail ?? "",
        failureReason: o.failureReason,
        structured: o.structured,
        usage: o.usage,
      });
    };

    // Defer to a microtask so callers can attach onEvent handlers before the
    // first step's events are emitted (mirrors real async runtimes).
    void Promise.resolve().then(execute);

    return {
      executionId: request.executionId,
      onEvent: (handler) => {
        handlers.push(handler);
      },
      cancel: async (reason?: string) => {
        run.cancelled = true;
        run.cancelReason = reason ?? "cancelled";
        for (const t of run.timers) clearTimeout(t);
        run.timers.length = 0;
        for (const wake of run.wakeFns) wake();
        run.wakeFns.clear();
      },
      result,
    };
  }
}
