import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRuntime,
  AgentStreamEvent,
  RunningExecution,
  ToolPermissionRequest,
} from "@devmesh/runtime";
import { RuntimeError } from "@devmesh/runtime";
import type { PermissionResource } from "@devmesh/contracts";
import { permissionResourceForTool } from "./permission-catalog.js";

/**
 * Phase 14D: external serve-mode broker around `opencode serve`.
 *
 * This adapter owns ALL OpenCode serve protocol knowledge (HTTP routes, SSE
 * framing, permission lifecycle) behind the AgentRuntime port, so DevMesh core
 * stays vendor-neutral. Verified end-to-end against opencode v1.18.29:
 *
 * - `opencode serve --port 0 --hostname 127.0.0.1` prints
 *   "opencode server listening on http://127.0.0.1:<port>" and authenticates
 *   with Basic auth over OPENCODE_SERVER_PASSWORD (username "opencode").
 * - Sessions are created per execution WITH a permission ruleset that forces
 *   EVERY tool call to surface as a `permission.asked` SSE event (the built-in
 *   "build" agent otherwise allow-lists everything). The broker then decides
 *   each ask out-of-band and replies `{response:"once"|"reject"}` addressed to
 *   the exact `per_...` request id. No session ever runs a tool the broker has
 *   not explicitly allowed for this run.
 *
 * Security model (all verified):
 * - The serve process binds 127.0.0.1 only and uses a fresh random password
 *   (never DEVMESH_AUTH_TOKEN, never leaked).
 * - Every permission ask is correlated by its exact request id and answered
 *   exactly once; the pending map is cleared on first resolution, so a second
 *   reply for the same id is impossible and OpenCode rejects it anyway (404).
 * - Unknown tool names, malformed payloads, unhandled asks, SSE disconnect,
 *   server exit, timeout and cancellation all fail CLOSED: the tool does not
 *   run and pending asks are rejected.
 * - cancel()/timeout abort the execution's session; the shared server is only
 *   torn down via dispose() (shutdown), never as a side effect of one run.
 */

const DEFAULT_KILL_GRACE_MS = 3000;
const READY_TIMEOUT_MS = 30_000;
const STDERR_KEEP_BYTES = 16 * 1024;

/** Verified session ruleset that turns every tool call into an ask. */
const ASK_ALL_RULES = [{ permission: "*", pattern: "*", action: "ask" }];
/** The allow-all equivalent of the CLI's `--auto` (run-level 14C approval). */
const ALLOW_ALL_RULES = [{ permission: "*", pattern: "*", action: "allow" }];

export interface OpencodeServeRuntimeOptions {
  /** Absolute or PATH-resolvable opencode binary. */
  binaryPath?: string;
  /**
   * Provider/model passed to sessions as providerID/modelID. A per-request
   * `request.model` wins over this when present.
   */
  model?: string;
  /**
   * Explicit extra environment variables for the serve process, merged on top
   * of the hardened allowlist. Tests use this to drive a stub server; the
   * composition root never passes credentials this way (DEVMESH_* is
   * deliberately NOT inherited).
   */
  env?: Record<string, string>;
  /** Grace period between SIGTERM and SIGKILL for the serve process. */
  killGraceMs?: number;
  /** How long to wait for the serve process to become healthy (startup). */
  readyTimeoutMs?: number;
}

interface ServeServer {
  port: number;
  password: string;
  child: ChildProcess;
  /** Cumulative stdout for the readiness port scan / error attribution. */
  stdout: string;
  /** Capped stderr tail shared by every execution (like run-mode stderrTail). */
  stderrBuf: Buffer;
  url: string;
}

interface PermissionAsk {
  id: string;
  request: ToolPermissionRequest;
}

type TermReason = "idle" | "timeout" | "cancelled" | "sse-close" | "server-exit";

interface RunCtx {
  executionId: string;
  request: AgentExecutionRequest;
  sessionId?: string;
  sse?: AbortController;
  /** Assistant text parts observed on the stream (fallback finalText). */
  texts: string[];
  /** tool name -> last status, for stream parity with run-mode. */
  seenTools: string[];
  pending: Map<string, PermissionAsk>;
  submitted: boolean;
  /** Set once the session has been aborted, so endSession is idempotent. */
  ended: boolean;
  killed?: { reason: "timeout" | "cancelled"; detail: string };
  fatalError?: string;
  resolveTerm: (reason: TermReason) => void;
  term: Promise<TermReason>;
}

export class OpencodeServeRuntime implements AgentRuntime {
  readonly name = "opencode";
  private readonly opts: Required<Omit<OpencodeServeRuntimeOptions, "env">> & {
    env: Record<string, string>;
  };
  private server: ServeServer | null = null;
  private serverStarting: Promise<ServeServer> | null = null;
  /** Every live execution, for fail-closed cleanup on server exit. */
  private readonly runs = new Map<string, RunCtx>();
  private disposed = false;

  constructor(options: OpencodeServeRuntimeOptions = {}) {
    this.opts = {
      binaryPath: options.binaryPath ?? "opencode",
      model: options.model ?? "",
      killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      readyTimeoutMs: options.readyTimeoutMs ?? READY_TIMEOUT_MS,
      env: options.env ?? {},
    };
  }

  start(request: AgentExecutionRequest): RunningExecution {
    const handlers: Array<(e: AgentStreamEvent) => void> = [];
    const emit = (e: AgentStreamEvent): void => {
      for (const h of handlers) {
        try {
          h(e);
        } catch {
          /* subscriber errors must not break the stream */
        }
      }
    };

    let settleTerm!: (reason: TermReason) => void;
    const ctx: RunCtx = {
      executionId: request.executionId,
      request,
      texts: [],
      seenTools: [],
      pending: new Map(),
      ended: false,
      submitted: false,
      fatalError: undefined,
      term: new Promise<TermReason>((res) => {
        settleTerm = res;
      }),
      resolveTerm: (reason) => settleTerm(reason),
    };

    let resolveResult!: (r: AgentExecutionResult) => void;
    let rejectResult!: (err: unknown) => void;
    const result = new Promise<AgentExecutionResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    this.runs.set(request.executionId, ctx);
    void this.runExecution(ctx, emit, {
      resolveResult,
      rejectResult,
    }).catch((err: unknown) => {
      this.runs.delete(ctx.executionId);
      rejectResult(
        err instanceof RuntimeError
          ? err
          : new RuntimeError("runtime/unavailable", String(err)),
      );
    });

    return {
      executionId: request.executionId,
      onEvent: (handler) => {
        handlers.push(handler);
      },
      cancel: async (reason?: string) => await this.cancelRun(ctx, reason),
      result,
    };
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    if (this.server && this.server.child.exitCode === null) {
      try {
        const res = await fetch(`${this.server.url}/global/health`, {
          headers: { Authorization: this.authHeader() },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const body = (await res.json()) as { healthy?: boolean; version?: string };
          return { healthy: body.healthy === true, version: body.version };
        }
        return { healthy: false };
      } catch {
        return { healthy: false };
      }
    }
    // No server yet: cheap `--version` probe, identical to the run-mode
    // adapter, without spawning a long-lived broker just for a health check.
    return new Promise((resolve) => {
      let out = "";
      const child = spawn(this.opts.binaryPath, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        env: this.childEnv(),
        timeout: 10_000,
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => {
        out += c;
      });
      child.once("error", () => resolve({ healthy: false }));
      child.once("close", (code) => {
        const version = out.trim().split("\n")[0]?.trim() || undefined;
        resolve({ healthy: code === 0 && version !== undefined, version });
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const ctx of [...this.runs.values()]) {
      ctx.fatalError = "opencode serve shutdown while execution in flight";
      ctx.resolveTerm("server-exit");
    }
    this.runs.clear();
    const server = this.server;
    this.server = null;
    if (server) await this.killServer(server);
  }

  // -- protocol helpers ------------------------------------------------------

  private async ensureServer(): Promise<ServeServer> {
    if (this.server && this.server.child.exitCode === null) return this.server;
    if (this.serverStarting) return this.serverStarting;
    this.serverStarting = this.spawnServer();
    try {
      this.server = await this.serverStarting;
    } finally {
      this.serverStarting = null;
    }
    return this.server;
  }

  private async spawnServer(): Promise<ServeServer> {
    const password = `devmesh-${randomBytes(24).toString("hex")}`;
    const child = spawn(
      this.opts.binaryPath,
      ["serve", "--port", "0", "--hostname", "127.0.0.1"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group -> tree kill possible
        env: { ...this.childEnv(), OPENCODE_SERVER_PASSWORD: password },
      },
    );
    // Swallow spawn-side errors (e.g. missing binary) so they surface as a
    // clean reject below instead of an uncaught child 'error' event.
    child.on("error", () => undefined);
    if (child.pid === undefined) {
      const err = new RuntimeError(
        "runtime/unavailable",
        `failed to start ${this.opts.binaryPath} serve`,
        { details: { executionId: "server" } },
      );
      child.kill();
      throw err;
    }

    const server: ServeServer = {
      port: 0,
      password,
      child,
      stdout: "",
      stderrBuf: Buffer.alloc(0),
      url: "",
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      server.stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      server.stderrBuf = Buffer.concat([server.stderrBuf, Buffer.from(c)]).subarray(
        -STDERR_KEEP_BYTES,
      );
    });

    const exited = new Promise<void>((res) => {
      child.once("exit", () => res());
    });
    void exited.then(() => {
      if (this.server === server) this.server = null;
      // Fail closed: every execution waiting on this server dies with it.
      for (const ctx of [...this.runs.values()]) {
        ctx.fatalError = "opencode serve exited unexpectedly";
        ctx.resolveTerm("server-exit");
      }
    });
    child.once("error", (err) => {
      for (const ctx of [...this.runs.values()]) {
        ctx.fatalError = `opencode serve process error: ${err.message}`;
        ctx.resolveTerm("server-exit");
      }
    });

    const deadline = Date.now() + this.opts.readyTimeoutMs;
    while (Date.now() < deadline && child.exitCode === null) {
      const m = server.stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        server.port = Number(m[1]);
        server.url = `http://127.0.0.1:${server.port}`;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!server.url) {
      const log = server.stdout || server.stderrBuf.toString("utf8");
      await this.killServer(server);
      throw new RuntimeError(
        "runtime/unavailable",
        `opencode serve did not report a listening port${log ? `: ${log.slice(-400)}` : ""}`,
        { details: { binaryPath: this.opts.binaryPath } },
      );
    }

    // Readiness: authenticated /global/health must report healthy.
    const auth = this.authHeader({ password });
    for (let i = 0; i < this.opts.readyTimeoutMs / 250; i++) {
      try {
        const res = await fetch(`${server.url}/global/health`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const body = (await res.json()) as { healthy?: boolean };
          if (body.healthy === true) return server;
        }
      } catch {
        if (child.exitCode !== null) break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.killServer(server);
    throw new RuntimeError(
      "runtime/unavailable",
      "opencode serve did not become healthy on its local port",
      { details: { binaryPath: this.opts.binaryPath } },
    );
  }

  private authHeader(cfg?: { password: string }): string {
    const password = cfg?.password ?? this.server?.password ?? "";
    return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  }

  private childEnv(): NodeJS.ProcessEnv {
    const whitelist = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
    const env: NodeJS.ProcessEnv = { TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1" };
    for (const key of whitelist) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    // Explicit test/operator knobs; never part of the composition root's
    // config path and never derived from DEVMESH_* secrets.
    return { ...env, ...this.opts.env };
  }

  private async killServer(server: ServeServer): Promise<void> {
    if (server.child.exitCode !== null || server.child.signalCode !== null) return;
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (server.child.pid !== undefined) process.kill(-server.child.pid, name);
      } catch {
        /* already gone */
      }
    };
    signal("SIGTERM");
    await new Promise<void>((res) => {
      const t = setTimeout(res, this.opts.killGraceMs);
      server.child.once("exit", () => {
        clearTimeout(t);
        res();
      });
    });
    signal("SIGKILL");
  }

  // -- per-execution orchestration ------------------------------------------

  private async runExecution(
    ctx: RunCtx,
    emit: (e: AgentStreamEvent) => void,
    out: {
      resolveResult: (r: AgentExecutionResult) => void;
      rejectResult: (err: unknown) => void;
    },
  ): Promise<void> {
    const server = await this.ensureServer();
    if (this.disposed) {
      throw new RuntimeError(
        "runtime/unavailable",
        "opencode serve runtime disposed while starting execution",
      );
    }
    const startedAt = Date.now();
    const request = ctx.request;
    const auth = this.authHeader({ password: server.password });

    let sessionId: string | undefined;
    try {
      const res = await fetch(
        `${server.url}/session?directory=${encodeURIComponent(request.workspaceRoot)}`,
        {
          method: "POST",
          headers: { Authorization: auth, "content-type": "application/json" },
          body: JSON.stringify(this.sessionBody(request)),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) {
        throw new RuntimeError(
          "runtime/unavailable",
          `opencode session create failed (${res.status})`,
          { details: { executionId: request.executionId } },
        );
      }
      const session = (await res.json()) as { id?: string };
      if (!session.id) {
        throw new RuntimeError("runtime/unavailable", "opencode session create returned no id");
      }
      sessionId = session.id;
      ctx.sessionId = sessionId;
    } catch (err) {
      // Session create failed (bad model, server unreachable, ...). This is a
      // DevMesh-side infrastructure failure: reject, never resolve.
      if (err instanceof RuntimeError) throw err;
      throw new RuntimeError("runtime/unavailable", `opencode session create failed: ${String(err)}`);
    }
    emit({ kind: "session", sessionId });

    // Cancelled while the session was still being created -> abort the fresh
    // session and wind down; never submit the prompt to an aborted lifecycle.
    if (ctx.killed !== undefined) {
      await this.endSession(ctx);
      const reason = await ctx.term;
await this.rejectPending(ctx);
      this.runs.delete(ctx.executionId);
      const result = await this.finalize(ctx, reason, startedAt, server);
      out.resolveResult(result);
      return;
    }

    // Subscribe AFTER the session exists (never miss post-request events) and
    // BEFORE submitting the prompt.
    const ac = new AbortController();
    ctx.sse = ac;
    const sseDone = (async () => {
      try {
        const res = await fetch(
          `${server.url}/event?directory=${encodeURIComponent(request.workspaceRoot)}`,
          {
            headers: { Authorization: auth },
            signal: ac.signal,
          },
        );
        if (!res.ok || !res.body) {
          throw new Error(`event stream returned ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf("\n\n");
          while (idx >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            this.dispatchFrame(ctx, frame, emit);
            idx = buffer.indexOf("\n\n");
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          ctx.fatalError =
            err instanceof Error ? `opencode event stream failed: ${err.message}` : String(err);
        }
      }
      if (!ctx.submitted) return; // stream may close between session and prompt
      if (!ac.signal.aborted) ctx.resolveTerm("sse-close");
    })();

    // Submit the instruction.
    try {
      const res = await fetch(
        `${server.url}/session/${encodeURIComponent(sessionId)}/prompt_async?directory=${encodeURIComponent(request.workspaceRoot)}`,
        {
          method: "POST",
          headers: { Authorization: auth, "content-type": "application/json" },
          body: JSON.stringify(this.promptBody(request)),
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) {
        throw new Error(`prompt submission returned ${res.status}`);
      }
    } catch (err) {
      ac.abort();
      this.runs.delete(ctx.executionId);
      throw new RuntimeError(
        "runtime/unavailable",
        `opencode prompt submission failed: ${String(err)}`,
        { details: { executionId: request.executionId } },
      );
    }
    ctx.submitted = true;

    // Hard wall-clock budget (mirrors run-mode timeout semantics).
    const timeoutTimer = setTimeout(() => {
      ctx.killed ??= {
        reason: "timeout",
        detail: `execution exceeded ${request.timeoutMs}ms`,
      };
      void this.endSession(ctx).catch(() => undefined);
    }, Math.max(request.timeoutMs, 1));

    const reason = await ctx.term;
    clearTimeout(timeoutTimer);
    ac.abort();

    // Fail closed: no surviving ask for this execution.
    await this.rejectPending(ctx);

    await sseDone.catch(() => undefined);
    this.runs.delete(ctx.executionId);

    const result = await this.finalize(ctx, reason, startedAt, server);
    out.resolveResult(result);
  }

  private dispatchFrame(ctx: RunCtx, frame: string, emit: (e: AgentStreamEvent) => void): void {
    let dataLines = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataLines += `${line.slice(5).trim()}\n`;
    }
    if (!dataLines.trim()) return;
    let evt: { type?: string; properties?: Record<string, unknown> };
    try {
      evt = JSON.parse(dataLines) as { type?: string; properties?: Record<string, unknown> };
    } catch {
      return; // malformed SSE data is ignored, never trusted
    }
    if (evt.type === undefined) return;
    const props = evt.properties ?? {};

    switch (evt.type) {
      case "permission.asked":
        this.handlePermissionAsked(ctx, props, emit);
        return;
      case "message.part.updated": {
        this.handlePartUpdated(ctx, props, emit);
        return;
      }
      case "session.status": {
        if (props.sessionID !== undefined && props.sessionID !== ctx.sessionId) return;
        const status = props.status as { type?: string } | undefined;
        if (status?.type === "idle" && ctx.submitted && !this.terminated(ctx)) {
          ctx.resolveTerm("idle");
        }
        return;
      }
      case "session.error":
        ctx.fatalError = String(props.error ?? "opencode session error");
        return;
      default:
        return; // session.updated / heartbeat / plugin events etc. are ignored
    }
  }

  private handlePermissionAsked(
    ctx: RunCtx,
    props: Record<string, unknown>,
    emit: (e: AgentStreamEvent) => void,
  ): void {
    if (ctx.sessionId === undefined) return;
    if (props.sessionID !== undefined && props.sessionID !== ctx.sessionId) return;
    const id = typeof props.id === "string" ? props.id : undefined;
    const permissionName = typeof props.permission === "string" ? props.permission : undefined;
    if (!id || !permissionName) return; // malformed ask: nothing to correlate -> ignore
    if (ctx.pending.has(id)) return; // exact id already tracked: never double-handle

    const resource = permissionResourceForTool(permissionName);
    const patterns = Array.isArray(props.patterns)
      ? props.patterns.filter((p): p is string => typeof p === "string")
      : [];
    const tool = permissionName;
    // For an unknown tool `resource` is undefined; the execution denies it
    // before it ever reaches a policy handler, so the pending entry only
    // exists to power the fail-closed reply below.
    const request: ToolPermissionRequest = {
      executionId: ctx.executionId,
      resource: (resource ?? "read") as PermissionResource,
      tool,
      // The OpenCode permission request id: exact per-request correlation so
      // DevMesh mints one approval per DISTINCT tool ask (never reuses an
      // approval across different requests).
      requestId: id,
      ...(patterns[0] ? { target: patterns[0] } : {}),
      ...(patterns.length > 0 ? { patterns } : {}),
    };
    const ask: PermissionAsk = { id, request };
    ctx.pending.set(id, ask);

    if (resource === undefined) {
      // Unknown tool -> policy cannot name a resource -> fail CLOSED.
      void this.reply(ctx, id, "reject", `unknown tool ${permissionName} — denied (fail closed)`);
      return;
    }
    emit({ kind: "tool", tool, status: "pending" });

    const handler = ctx.request.onToolPermission;
    if (!handler) {
      void this.reply(ctx, id, "reject", "no permission handler attached — denied (fail closed)");
      return;
    }
    void handler(request)
      .then((decision) => {
        // The ask is resolved exactly once; further asks with the same id are
        // ignored (pending was deleted on reply).
        if (decision?.decision === "allow") {
          return this.reply(ctx, id, "once", decision.reason);
        }
        return this.reply(ctx, id, "reject", decision?.reason ?? "denied by DevMesh");
      })
      .catch((err: unknown) =>
        this.reply(ctx, id, "reject", `permission handler error — ${String(err)}`),
      );
  }

  private handlePartUpdated(ctx: RunCtx, props: Record<string, unknown>, emit: (e: AgentStreamEvent) => void): void {
    if (ctx.sessionId === undefined) return;
    if (props.sessionID !== undefined && props.sessionID !== ctx.sessionId) return;
    const part = props.part as
      | { type?: string; text?: string; tool?: string; state?: { status?: string } }
      | undefined;
    if (!part) return;
    if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
      ctx.texts.push(part.text);
      emit({ kind: "text", text: part.text });
      return;
    }
    if (part.type === "tool" && typeof part.tool === "string") {
      const status = part.state?.status;
      if (status) {
        if (ctx.seenTools[ctx.seenTools.length - 1] !== part.tool) {
          ctx.seenTools.push(part.tool);
        }
        emit({ kind: "tool", tool: part.tool, status });
      }
    }
  }

  private terminated(ctx: RunCtx): boolean {
    return ctx.killed !== undefined || ctx.fatalError !== undefined;
  }

  private async reply(
    ctx: RunCtx,
    id: string,
    response: "once" | "reject",
    _reason: string,
  ): Promise<void> {
    const server = this.server;
    if (!server || !ctx.sessionId) return;
    const [stored] = await this.takePending(ctx, id);
    if (!stored) return; // already resolved: a second reply is never sent
    try {
      await fetch(
        `${server.url}/session/${encodeURIComponent(ctx.sessionId)}/permissions/${encodeURIComponent(id)}`,
        {
          method: "POST",
          headers: {
            Authorization: this.authHeader({ password: server.password }),
            "content-type": "application/json",
          },
          body: JSON.stringify({ response }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      // Best-effort reply: if the server is gone the run is failing closed anyway.
    }
  }

  private async takePending(
    ctx: RunCtx,
    id: string,
  ): Promise<Array<{ id: string; request: ToolPermissionRequest }>> {
    const ask = ctx.pending.get(id);
    if (!ask) return [];
    ctx.pending.delete(id);
    return [{ id, request: ask.request }];
  }

  private async rejectPending(ctx: RunCtx): Promise<void> {
    await Promise.allSettled(
      [...ctx.pending.keys()].map((id) =>
        this.reply(ctx, id, "reject", "execution ended — pending permission denied (fail closed)"),
      ),
    );
  }

  /** Abort the execution's session (cancel/timeout). Its pending asks are
   * rejected as part of terminal handling, and the shared server is kept. */
  private async endSession(ctx: RunCtx): Promise<void> {
    const server = this.server;
    if (!server || !ctx.sessionId) return; // run reconciles after the session exists
    if (ctx.ended) return;
    ctx.ended = true;
    try {
      await fetch(
        `${server.url}/session/${encodeURIComponent(ctx.sessionId)}/abort?directory=${encodeURIComponent(ctx.request.workspaceRoot)}`,
        {
          method: "POST",
          headers: { Authorization: this.authHeader({ password: server.password }) },
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      // The abort is best-effort; the run terminates with its state either way.
    }
    // Give the session a moment to end; otherwise the run still terminates
    // (fail closed, pending asks rejected) without blocking forever.
    setTimeout(() => ctx.resolveTerm(ctx.killed?.reason ?? "sse-close"), 1000).unref();
  }

  private async cancelRun(ctx: RunCtx, reason?: string): Promise<void> {
    ctx.killed ??= { reason: "cancelled", detail: reason ?? "cancelled by DevMesh" };
    if (ctx.sessionId) await this.endSession(ctx);
  }

  private async finalize(
    ctx: RunCtx,
    reason: TermReason,
    startedAt: number,
    server: ServeServer,
  ): Promise<AgentExecutionResult> {
    const durationMs = Date.now() - startedAt;
    const stderrTail = server.stderrBuf.toString("utf8");
    const base = {
      executionId: ctx.executionId,
      sessionId: ctx.sessionId,
      exitCode: null,
      durationMs,
      stderrTail,
      finalText: ctx.texts.join("\n"),
    };

    if (ctx.killed?.reason === "timeout") {
      return { status: "timeout", ...base, failureReason: ctx.killed.detail };
    }
    if (ctx.killed?.reason === "cancelled") {
      return { status: "cancelled", ...base, failureReason: ctx.killed.detail };
    }
    if (reason === "sse-close" || reason === "server-exit") {
      return {
        status: "failed",
        ...base,
        failureReason:
          ctx.fatalError ?? "opencode serve stream closed before the session finished",
      };
    }
    if (ctx.fatalError) {
      return { status: "failed", ...base, failureReason: ctx.fatalError };
    }

    // Completed turn: pull the authoritative message transcript and tokens.
    const auth = this.authHeader({ password: server.password });
    const ws = ctx.request.workspaceRoot;
    let finalText = ctx.texts.join("\n");
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    try {
      const res = await fetch(
        `${server.url}/session/${encodeURIComponent(ctx.sessionId ?? "")}/message?directory=${encodeURIComponent(ws)}&limit=200`,
        { headers: { Authorization: auth }, signal: AbortSignal.timeout(15_000) },
      );
      if (res.ok) {
        const messages = (await res.json()) as Array<{
          info?: { role?: string };
          parts?: Array<{ type?: string; text?: string }>;
          error?: unknown;
        }>;
        const assistant = messages.filter(
          (m) => m.info?.role === "assistant" || m.info?.role === undefined,
        );
        const error = assistant.find((m) => m.error !== undefined && m.error !== null);
        if (error) {
          return { status: "failed", ...base, failureReason: String(error.error) };
        }
        finalText = assistant
          .flatMap((m) => m.parts ?? [])
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text ?? "")
          .filter((t) => t.length > 0)
          .join("\n");
      }
    } catch {
      // Transcript fetch is best-effort; the stream-collected text stands.
    }

    try {
      const listRes = await fetch(
        `${server.url}/session/list?directory=${encodeURIComponent(ws)}`,
        { headers: { Authorization: auth }, signal: AbortSignal.timeout(15_000) },
      );
      if (listRes.ok) {
        const sessions = (await listRes.json()) as Array<{
          id?: string;
          tokens?: { input?: unknown; output?: unknown };
        }>;
        const mine = sessions.find((s) => s.id === ctx.sessionId);
        const tokens = mine?.tokens;
        if (
          typeof tokens?.input === "number" &&
          typeof tokens.output === "number" &&
          tokens.input >= 0 &&
          tokens.output >= 0
        ) {
          usage = { inputTokens: tokens.input, outputTokens: tokens.output };
        }
      }
    } catch {
      // Usage is never fabricated; absence stays absence.
    }

    return { status: "completed", ...base, finalText, usage };
  }

  private sessionBody(request: AgentExecutionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      title: `devmesh-${request.executionId.slice(0, 18)}`,
      // The ONLY lever that makes every non-read tool surface as an ask for
      // this session, overriding the build agent's allow-by-default rules.
      permission: request.autoApprove ? ALLOW_ALL_RULES : ASK_ALL_RULES,
      agent: "build",
    };
    const modelRef = request.model || this.opts.model || "";
    if (modelRef) {
      const [providerID, ...rest] = modelRef.split("/");
      const modelID = rest.join("/");
      if (providerID && modelID) body.model = { providerID, modelID };
    }
    return body;
  }

  private promptBody(request: AgentExecutionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      agent: "build",
      parts: [{ type: "text", text: request.instruction }],
    };
    const modelRef = request.model || this.opts.model || "";
    if (modelRef) {
      const [providerID, ...rest] = modelRef.split("/");
      const modelID = rest.join("/");
      if (providerID && modelID) body.model = { providerID, modelID };
    }
    return body;
  }
}