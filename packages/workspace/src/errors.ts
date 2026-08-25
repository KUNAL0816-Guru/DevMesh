/** Typed error thrown by workspace and git services. */
export class WorkspaceError extends Error {
  constructor(
    public readonly code:
      | "workspace/invalid-name"
      | "workspace/path-unsafe"
      | "workspace/not-found"
      | "workspace/already-exists"
      | "workspace/locked"
      | "workspace/io"
      | "workspace/symlink-refused"
      | "git/not-a-repository"
      | "git/command-failed"
      | "git/timeout"
      | "git/nothing-to-commit"
      | "git/invalid-message"
      | "task/exhausted",
    message: string,
    options?: { cause?: unknown; details?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "WorkspaceError";
    this.details = options?.details;
  }
  readonly details?: unknown;
}
