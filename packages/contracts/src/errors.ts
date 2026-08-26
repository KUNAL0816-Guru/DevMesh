/**
 * Thrown when a mutation targets a pipeline run that has already reached a
 * terminal status (`completed`, `failed`, `cancelled`, `timeout`).
 *
 * Internal error class — not schema-validated, not exposed over HTTP.
 */
export class TerminalStateError extends Error {
  readonly currentStatus: string;
  readonly attemptedStatus: string;
  readonly runId: string;

  constructor(opts: {
    runId: string;
    currentStatus: string;
    attemptedStatus: string;
  }) {
    super(
      `pipeline ${opts.runId} is already in terminal state "${opts.currentStatus}" — cannot transition to "${opts.attemptedStatus}"`,
    );
    this.name = "TerminalStateError";
    this.runId = opts.runId;
    this.currentStatus = opts.currentStatus;
    this.attemptedStatus = opts.attemptedStatus;
  }
}
