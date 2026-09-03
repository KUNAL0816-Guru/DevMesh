import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRuntime,
  AgentStreamEvent,
  RunningExecution,
} from "@devmesh/runtime";
import { RuntimeError } from "@devmesh/runtime";

export interface OpenAiCompatibleRuntimeOptions {
  /** OpenAI-compatible base URL, e.g. "http://127.0.0.1:11434/v1". */
  baseUrl: string;
  /** Local model id sent to the endpoint (authoritative; never a provider ref). */
  model: string;
  /** Optional bearer token. Absent => no Authorization header. */
  apiKey?: string;
  /** Wall-clock budget for a single completion call. */
  timeoutMs?: number;
  /** Inject an HTTP transport for deterministic tests (defaults to global fetch). */
  fetch?: typeof fetch;
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/** Combines a base URL and a relative path, avoiding duplicated segments. */
function joinPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/${path.replace(/^\/+/, "")}`;
}

/**
 * An OpenAI-compatible local AgentRuntime (ADR-0001 amendment 9).
 *
 * Serves the existing AgentRuntime port by issuing a single generic Chat
 * Completions call (POST {baseUrl}/chat/completions) against a local/offline
 * endpoint such as Ollama. It is deliberately separate from the Phase 10
 * ProviderGateway path; it shares no implementation code with it.
 *
 * It is opencode-independent in behavior: `supportsAgent()` returns true so
 * existing agent definitions whose `runtime` is "opencode" can execute through
 * this runtime without any core/schema change.
 */
export class OpenAiCompatibleRuntime implements AgentRuntime {
  readonly name = "opencode-local";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(options: OpenAiCompatibleRuntimeOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.doFetch = options.fetch ?? fetch;
  }

  supportsAgent(): boolean {
    return true;
  }

  start(request: AgentExecutionRequest): RunningExecution {
    const handlers: Array<(e: AgentStreamEvent) => void> = [];

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
          /* handler errors must not break the stream */
        }
      }
    };

    const startedAt = Date.now();
    const executionId = request.executionId;
    let cancelled = false;
    let cancelReason: string | undefined;

    emit({ kind: "session", sessionId: executionId });

    const execute = async (): Promise<void> => {
      const finish = (r: Omit<AgentExecutionResult, "durationMs">): void => {
        resolveResult({ ...r, durationMs: Math.max(Date.now() - startedAt, 0) });
      };

      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), Math.max(request.timeoutMs, 1));
      const settled = { done: false };
      const settle = (): void => {
        if (settled.done) return;
        settled.done = true;
        clearTimeout(timeoutTimer);
      };

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

        const res = await this.doFetch(joinPath(this.baseUrl, "chat/completions"), {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: "user", content: request.instruction }],
          }),
          signal: controller.signal,
        });

        if (cancelled) {
          settle();
          finish({
            status: "cancelled",
            exitCode: null,
            sessionId: executionId,
            finalText: "",
            stderrTail: "",
            failureReason: cancelReason ?? "cancelled by DevMesh",
          });
          return;
        }

        if (!res.ok) {
          settle();
          const bodyText = (await res.text().catch(() => "")).slice(0, 2000);
          finish({
            status: "failed",
            exitCode: res.status,
            sessionId: executionId,
            finalText: "",
            stderrTail: "",
            failureReason:
              `local endpoint returned HTTP ${res.status}: ${bodyText.trim() || res.statusText}`.slice(0, 2000),
          });
          return;
        }

        const payload = (await res.json().catch(() => null)) as ChatCompletionsResponse | null;
        settle();

        if (cancelled) {
          finish({
            status: "cancelled",
            exitCode: null,
            sessionId: executionId,
            finalText: "",
            stderrTail: "",
            failureReason: cancelReason ?? "cancelled by DevMesh",
          });
          return;
        }

        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          finish({
            status: "failed",
            exitCode: null,
            sessionId: executionId,
            finalText: "",
            stderrTail: "",
            failureReason: "malformed completion response",
          });
          return;
        }

        let usage: AgentExecutionResult["usage"];
        const inTokens = payload?.usage?.prompt_tokens;
        const outTokens = payload?.usage?.completion_tokens;
        if (
          typeof inTokens === "number" &&
          Number.isInteger(inTokens) &&
          inTokens >= 0 &&
          typeof outTokens === "number" &&
          Number.isInteger(outTokens) &&
          outTokens >= 0
        ) {
          usage = { inputTokens: inTokens, outputTokens: outTokens };
        }

        finish({
          status: "completed",
          exitCode: 0,
          sessionId: executionId,
          finalText: content,
          stderrTail: "",
          ...(usage ? { usage } : {}),
        });
      } catch (err) {
        settle();
        if (cancelled) {
          finish({
            status: "cancelled",
            exitCode: null,
            sessionId: executionId,
            finalText: "",
            stderrTail: "",
            failureReason: cancelReason ?? "cancelled by DevMesh",
          });
          return;
        }
        if ((err as Error)?.name === "AbortError") {
          finish({
            status: "timeout",
            exitCode: null,
            sessionId: executionId,
            finalText: "",
            stderrTail: "",
            failureReason: `execution exceeded ${request.timeoutMs}ms budget`,
          });
          return;
        }
        rejectResult(
          new RuntimeError("runtime/unavailable", "local endpoint connection failed", {
            cause: err,
            details: { executionId },
          }),
        );
      }
    };

    void Promise.resolve().then(execute);

    return {
      executionId,
      onEvent: (handler) => {
        handlers.push(handler);
      },
      cancel: async (reason?: string) => {
        cancelled = true;
        cancelReason = reason ?? "cancelled by DevMesh";
      },
      result,
    };
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
      const res = await this.doFetch(joinPath(this.baseUrl, "models"), {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      return { healthy: res.ok };
    } catch {
      return { healthy: false };
    } finally {
      clearTimeout(timer);
    }
  }
}
