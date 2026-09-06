import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Result categories for MCP tool errors. Mirrors the HTTP status semantics
 * used by the REST layer (401/403/404/400/500) without introducing a new
 * taxonomy.
 */
export type McpStatus = "invalid" | "forbidden" | "not-found" | "internal";

export class McpToolError extends Error {
  readonly status: McpStatus;
  readonly code: string;

  constructor(status: McpStatus, code: string, message: string) {
    super(message);
    this.name = "McpToolError";
    this.status = status;
    this.code = code;
  }
}

/** The Phase 14B `AuthorizationError` thrown by injected authorizers. Typed
 *  structurally so the MCP package never depends on the server package. */
export interface AuthorizationErrorLike {
  code?: unknown;
  message?: string;
}

export function isAuthorizationError(err: unknown): err is AuthorizationErrorLike {
  return (err as AuthorizationErrorLike)?.code === "auth/forbidden";
}

export function notFound(code: string, message: string): CallToolResult {
  return errResult(new McpToolError("not-found", code, message).message);
}

export function invalidRequest(message: string): CallToolResult {
  return errResult(new McpToolError("invalid", "request/invalid", message).message);
}

function errResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function okResult(data: unknown): CallToolResult {
  const text = data === undefined ? "{}" : JSON.stringify(data);
  return { content: [{ type: "text", text }] };
}

/**
 * Turns a tool handler into an MCP tool result. Success payloads are JSON
 * text. Thrown `McpToolError`s map to isError results; Phase 14B
 * `auth/forbidden` errors surface their safe message as an isError result
 * (never a successful empty response). Anything else collapses to a generic
 * internal error — no stacks, diagnostics, or internals are ever surfaced.
 */
export async function executeTool(
  toolName: string,
  fn: () => unknown,
): Promise<CallToolResult> {
  try {
    return okResult(await fn());
  } catch (err) {
    if (err instanceof McpToolError) {
      return errResult(err.message);
    }
    if (isAuthorizationError(err)) {
      const message = err.message?.trim();
      return errResult(message && message !== "" ? message : "forbidden: not authorized");
    }
    return errResult(`internal error while running tool ${toolName}`);
  }
}