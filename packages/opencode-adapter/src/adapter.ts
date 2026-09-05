import { spawn, type ChildProcess } from "node:child_process";
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRuntime,
  AgentStreamEvent,
  RunningExecution,
} from "@devmesh/runtime";
import { RuntimeError } from "@devmesh/runtime";
import { createOpencodeEventMapper } from "./ndjson.js";

export interface OpencodeAdapterOptions {
  /** Absolute or PATH-resolvable opencode binary. */
  binaryPath?: string;
  /**
   * Map to the CLI's `--auto` flag (approve permission requests). DevMesh
   * defaults this to FALSE: headless opencode then auto-rejects any tool
   * permission request, which is the safe posture. A per-request
   * `request.autoApprove` value wins over this default when present.
   */
  autoApprove?: boolean;
  /** Grace period between SIGTERM and SIGKILL for the process group. */
  killGraceMs?: number;
  model?: string;
}

const STDERR_KEEP_BYTES = 16 * 1024;

interface KillState {
  reason: "cancelled" | "timeout";
  detail: string;
}

/**
 * Adapter around the OpenCode CLI (`opencode run`). All vendor specifics
 * live here: argument construction, NDJSON event mapping, process-group
 * kill semantics. DevMesh core only sees AgentRuntime/RunningExecution.
 *
 * Isolation model:
 * - The ONLY directory passed to the runtime is request.workspaceRoot,
 *   resolved by WorkspaceService beforehand (never model output).
 * - Verified against installed CLI source: `--dir` makes the process chdir
 *   into that workspace before anything runs.
 * - stdin is /dev/null so the CLI's non-TTY stdin read gets immediate EOF.
 * - Environment is a minimal whitelist; no shell involved anywhere.
 * - Without --auto the CLI auto-rejects permission requests.
 */
export class OpencodeAdapter implements AgentRuntime {
  readonly name = "opencode";
  private readonly opts: Required<OpencodeAdapterOptions>;

  constructor(options: OpencodeAdapterOptions = {}) {
    this.opts = {
      binaryPath: options.binaryPath ?? "opencode",
      autoApprove: options.autoApprove ?? false,
      killGraceMs: options.killGraceMs ?? 3000,
      model: options.model ?? "",
    };
  }

  start(request: AgentExecutionRequest): RunningExecution {
    const handlers: Array<(e: AgentStreamEvent) => void> = [];
    let killState: KillState | null = null;

    let resolveResult!: (r: AgentExecutionResult) => void;
    let rejectResult!: (err: unknown) => void;
    const result = new Promise<AgentExecutionResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    const emit = (e: AgentStreamEvent): void => {
      for (const h of handlers) {
        try {
          h(e);
        } catch {
          /* subscriber errors must not break the stream */
        }
      }
    };

    let child: ChildProcess | null = null;
    try {
      child = spawn(this.opts.binaryPath, this.buildArgs(request), {
        cwd: request.workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // own process group -> tree kill possible
        env: this.childEnv(),
      });
      if (child.pid === undefined) throw new Error("no pid assigned");
    } catch (err) {
      // spawn() failures surface asynchronously via the 'error' event; without
      // a listener Node turns that into an uncaught exception.
      child?.once("error", () => undefined);
      rejectResult(
        new RuntimeError("runtime/unavailable", `failed to start ${this.opts.binaryPath}`, {
          cause: err,
          details: { executionId: request.executionId },
        }),
      );
      return {
        executionId: request.executionId,
        onEvent: () => undefined,
        cancel: async () => undefined,
        result,
      };
    }

    const startedAt = Date.now();
    let stderrBuf = Buffer.alloc(0);
    let lineBuf = "";
    const mapper = createOpencodeEventMapper(emit);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    const killTree = async (): Promise<void> => {
      if (
        child?.pid === undefined ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        return;
      }
      const signalGroup = (name: NodeJS.Signals): void => {
        try {
          if (child?.pid !== undefined) process.kill(-child.pid, name);
        } catch {
          /* already gone */
        }
      };
      signalGroup("SIGTERM");
      await new Promise<void>((res) => {
        const t = setTimeout(res, this.opts.killGraceMs);
        child?.once("exit", () => {
          clearTimeout(t);
          res();
        });
      });
      signalGroup("SIGKILL");
    };

    const timeoutTimer = setTimeout(() => {
      killState ??= {
        reason: "timeout",
        detail: `execution exceeded ${request.timeoutMs}ms`,
      };
      void killTree();
    }, Math.max(request.timeoutMs, 1));

    child.stdout?.on("data", (chunk: string) => {
      lineBuf += chunk;
      let idx = lineBuf.indexOf("\n");
      while (idx >= 0) {
        mapper.handleLine(lineBuf.slice(0, idx));
        lineBuf = lineBuf.slice(idx + 1);
        idx = lineBuf.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf = Buffer.concat([stderrBuf, Buffer.from(chunk)]).subarray(
        -STDERR_KEEP_BYTES,
      );
    });

    child.once("error", (err) => {
      clearTimeout(timeoutTimer);
      rejectResult(
        new RuntimeError("runtime/unavailable", "opencode process error", {
          cause: err,
          details: { executionId: request.executionId },
        }),
      );
    });

    child.once("close", (code) => {
      clearTimeout(timeoutTimer);
      if (lineBuf.trim()) mapper.handleLine(lineBuf); // flush trailing line
      const parsed = mapper.result();
      const durationMs = Date.now() - startedAt;
      const stderrTail = stderrBuf.toString("utf8");

      if (killState) {
        resolveResult({
          status: killState.reason === "timeout" ? "timeout" : "cancelled",
          exitCode: code,
          sessionId: parsed.sessionId,
          finalText: parsed.finalText,
          stderrTail,
          durationMs,
          failureReason: killState.detail,
          structured: parsed.structured,
          usage: parsed.usage,
        });
        return;
      }
      if (code === 0) {
        resolveResult({
          status: "completed",
          exitCode: 0,
          sessionId: parsed.sessionId,
          finalText: parsed.finalText,
          stderrTail,
          durationMs,
          structured: parsed.structured,
          usage: parsed.usage,
        });
        return;
      }
      resolveResult({
        status: "failed",
        exitCode: code,
        sessionId: parsed.sessionId,
        finalText: parsed.finalText,
        stderrTail,
        durationMs,
        failureReason:
          parsed.failureReasons.join("; ").slice(0, 2000) ||
          `opencode exited with code ${code}`,
        structured: parsed.structured,
        usage: parsed.usage,
      });
    });

    return {
      executionId: request.executionId,
      onEvent: (handler) => {
        handlers.push(handler);
      },
      cancel: async (reason?: string) => {
        killState ??= { reason: "cancelled", detail: reason ?? "cancelled by DevMesh" };
        await killTree();
      },
      result,
    };
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
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

  private buildArgs(request: AgentExecutionRequest): string[] {
    const args = [
      "run",
      "--format",
      "json",
      "--dir",
      request.workspaceRoot,
      "--title",
      `devmesh-${request.executionId.slice(0, 18)}`,
    ];
    if (request.autoApprove ?? this.opts.autoApprove) args.push("--auto");
    const model = request.model || this.opts.model || undefined;
    if (model) args.push("-m", model);
    if (request.outputFormat) {
      args.push("--output-schema", JSON.stringify(request.outputFormat.schema));
    }
    // `--` keeps the instruction strictly positional regardless of content
    args.push("--", request.instruction);
    return args;
  }

  private childEnv(): NodeJS.ProcessEnv {
    const whitelist = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
    const env: NodeJS.ProcessEnv = { TERM: "dumb", GIT_CONFIG_NOSYSTEM: "1" };
    for (const key of whitelist) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    return env;
  }
}
