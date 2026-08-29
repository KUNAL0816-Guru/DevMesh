import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRuntime,
  AgentStreamEvent,
  AgentUsage,
  ExecutionStatus,
  RunningExecution,
} from "./types.js";

export interface FakeStep {
  /** Events emitted on the stream when this step begins. */
  events?: AgentStreamEvent[];
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
