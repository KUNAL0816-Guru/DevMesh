import type {
  AgentExecutionRequest,
  AgentRuntime,
  RunningExecution,
} from "@devmesh/runtime";

/**
 * Phase 14D: hybrid routing.
 *
 * `opencode run` supports structured output (`--output-schema`, required by
 * the architect/tester/reviewer pipeline) while `opencode serve` supports live
 * per-tool permission interception but NOT structured output (verified in
 * v1.18.29). Rather than lock every execution to the lower common
 * denominator, executions that carry an `outputFormat` go to the run-mode
 * binary (14C behavior preserved) and every other execution goes to the
 * serve-mode broker with true per-tool gating.
 */
export class OpenCodeHybridRuntime implements AgentRuntime {
  readonly name = "opencode-hybrid";

  constructor(
    private readonly runRuntime: AgentRuntime,
    private readonly serveRuntime: AgentRuntime,
  ) {}

  start(request: AgentExecutionRequest): RunningExecution {
    const runtime = request.outputFormat ? this.runRuntime : this.serveRuntime;
    return runtime.start(request);
  }

  supportsAgent?(agentRuntimeName: string): boolean {
    if (this.runRuntime.supportsAgent?.(agentRuntimeName)) return true;
    return this.serveRuntime.supportsAgent?.(agentRuntimeName) ?? false;
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    const run = this.runRuntime.health?.();
    const serve = this.serveRuntime.health?.();
    const results = await Promise.allSettled(
      [run, serve].flatMap((p) => (p ? [p] : [])),
    );
    let healthy = false;
    let version: string | undefined;
    for (const r of results) {
      if (r.status === "rejected") continue;
      if (r.value.healthy === true) healthy = true;
      version ??= r.value.version;
    }
    return { healthy, version };
  }

  private disposed = false;

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled(
      [
        this.runRuntime.dispose?.(),
        this.serveRuntime.dispose?.(),
      ].flatMap((p) => (p ? [p] : [])),
    );
  }
}