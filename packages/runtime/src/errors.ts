export type RuntimeErrorCode =
  | "runtime/not-configured"
  | "runtime/unavailable"
  | "runtime/invalid-request"
  | "runtime/cancel-failed";

/** DevMesh-side runtime failures. Task-level failure is NOT a RuntimeError. */
export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RuntimeError";
    this.code = code;
    this.details = options?.details;
  }
}
