/** Map typed service error codes to HTTP statuses for the API edge. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  "workspace/invalid-name": 400,
  "workspace/path-unsafe": 400,
  "workspace/symlink-refused": 400,
  "workspace/locked": 409,
  "workspace/already-exists": 409,
  "workspace/not-found": 404,
  "workspace/io": 500,
  "git/command-failed": 500,
  "git/nothing-to-commit": 409,
  "git/invalid-message": 400,
  "git/not-a-repository": 409,
  "git/timeout": 504,
  "storage/not-found": 404,
  "storage/migration-failed": 500,
  "storage/corrupt-row": 500,
  "storage/open-failed": 500,
  "storage/insert-failed": 500,
  "storage/approval-resolved": 409,
  "runtime/not-configured": 503,
  "runtime/unavailable": 503,
  "runtime/cancel-failed": 409,
  "runtime/invalid-request": 400,
  "agent/unknown": 400,
  "agent/not-executable": 409,
  "task/exhausted": 409,
  "budget/exhausted": 409,
};

export interface NormalizedError {
  status: number;
  code: string;
  message: string;
}

/** Best-effort normalization of any thrown value into an HTTP problem. */
export function normalizeError(err: unknown): NormalizedError {
  if (err !== null && typeof err === "object" && "code" in err) {
    const code = String((err as { code: unknown }).code);
    const known = STATUS_BY_CODE[code];
    if (known !== undefined) {
      return {
        status: known,
        code,
        message: (err as unknown as Error).message ?? code,
      };
    }
    // zod issues carry code 'invalid_type' etc — treat as bad request
    if (code.startsWith("invalid_") || code === "custom") {
      return { status: 400, code: "request/invalid", message: "invalid request payload" };
    }
  }
  if (err instanceof Error && err.name === "ZodError") {
    return { status: 400, code: "request/invalid", message: "invalid request payload" };
  }
  return {
    status: err instanceof Error ? 500 : 500,
    code: "internal/error",
    message: "internal server error",
  };
}
