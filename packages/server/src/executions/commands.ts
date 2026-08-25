import { execFile } from "node:child_process";

/**
 * Operator-supplied verification commands (e.g. "npm test") that DevMesh
 * itself replays inside the workspace after an execution. These NEVER come
 * from the model — they arrive via the API/config from the operator side.
 *
 * Safety: single token chain of conservative characters, no shell — the
 * command is split on whitespace and executed via execFile (argv vector).
 */
export const VERIFICATION_COMMAND_PATTERN =
  /^[A-Za-z0-9_@%+=:,./-]+( [A-Za-z0-9_@%+=:,./-]+)*$/;

export interface CommandReplayOutcome {
  command: string;
  exitCode: number;
  passed: boolean;
  detail: string;
}

const MAX_REPLAY_MS = 120_000;

export function splitSafeCommand(command: string): string[] | null {
  if (!VERIFICATION_COMMAND_PATTERN.test(command)) return null;
  return command.trim().split(/\s+/);
}

/** Run a verified-safe command directly (no shell) and capture the verdict. */
export function runVerificationCommand(
  root: string,
  command: string,
  timeoutMs = MAX_REPLAY_MS,
): Promise<CommandReplayOutcome> {
  const argv = splitSafeCommand(command);
  if (!argv || argv.length === 0) {
    return Promise.resolve({
      command,
      exitCode: 126,
      passed: false,
      detail: "verification command rejected by safety policy",
    });
  }
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      argv[0] as string,
      argv.slice(1),
      {
        cwd: root,
        timeout: Math.min(Math.max(timeoutMs, 1000), MAX_REPLAY_MS),
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env },
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        // execFile yields an error for non-zero exits; code may still be present
        const code =
          typeof (err as { code?: unknown })?.code === "number"
            ? ((err as { code: number }).code)
            : err
              ? 127
              : 0;
        const tail = (text: string): string =>
          text.replace(/\s+/g, " ").trim().slice(-400);
        resolve({
          command,
          exitCode: code,
          passed: code === 0,
          detail:
            `replayed by devmesh in ${durationMs}ms` +
            (code !== 0 ? `; stderr: ${tail(stderr)}; stdout: ${tail(stdout)}` : ""),
        });
      },
    );
  });
}
