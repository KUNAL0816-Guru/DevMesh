import type { AgentStreamEvent } from "@devmesh/runtime";

/**
 * Parser for `opencode run --format json` output.
 *
 * Verified against the installed opencode 1.18.21 CLI source: each line is
 * JSON.stringify({ type, timestamp: Date.now(), sessionID, ...payload }).
 * Observed types: step_start | step_finish | tool_use | text | reasoning |
 * error. The stream ends when the session reports status idle; the process
 * exits 0, or 1 after emitting one or more `error` events.
 */
export interface NdjsonParserResult {
  sessionId?: string;
  finalText: string;
  failureReasons: string[];
}

export function createOpencodeEventMapper(
  emit: (event: AgentStreamEvent) => void,
): { handleLine: (line: string) => void; result: () => NdjsonParserResult } {
  const textParts: string[] = [];
  const failureReasons: string[] = [];
  let sessionId: string | undefined;

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // non-JSON noise is ignored, never trusted
    }
    if (typeof evt.sessionID === "string" && evt.sessionID.length > 0) {
      sessionId = evt.sessionID;
      emit({ kind: "session", sessionId });
    }
    switch (evt.type) {
      case "text": {
        const part = evt.part as { type?: string; text?: string } | undefined;
        const text = part?.text;
        if (part?.type === "text" && typeof text === "string" && text.length > 0) {
          textParts.push(text);
          emit({ kind: "text", text });
        }
        return;
      }
      case "tool_use": {
        const part = evt.part as
          | { tool?: string; state?: { status?: string } }
          | undefined;
        emit({ kind: "tool", tool: part?.tool, status: part?.state?.status });
        return;
      }
      case "error": {
        const err = evt.error as { message?: string } | unknown;
        const message =
          typeof err === "object" && err !== null && "message" in err
            ? String((err as { message?: unknown }).message)
            : JSON.stringify(err).slice(0, 500);
        failureReasons.push(message);
        emit({ kind: "error", message });
        return;
      }
      default:
        return; // step_start / step_finish / reasoning / unknown types
    }
  };

  return {
    handleLine,
    result: () => ({
      sessionId,
      finalText: textParts.join("\n"),
      failureReasons,
    }),
  };
}
