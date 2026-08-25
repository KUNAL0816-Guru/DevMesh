import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { isSafeRelPath } from "@devmesh/contracts";
import { WorkspaceError } from "./errors.js";

// ---------------------------------------------------------------------------
// Typed results
// ---------------------------------------------------------------------------

export interface GitRunResult {
  ok: boolean;
  /** Exit code, or null when terminated by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface GitStatusEntry {
  /** Two-char porcelain XY status, e.g. "M ", " A", "??". */
  x: string;
  y: string;
  path: string;
  renamedFrom?: string;
}

export interface GitStatus {
  branch: string | null;
  clean: boolean;
  entries: GitStatusEntry[];
}

export interface GitCommitResult {
  sha: string;
  branch: string | null;
  message: string;
}

const REF_PATTERN = /^[A-Za-z0-9._~/-]{1,120}$/;

/** Prefix for DevMesh-owned checkpoint commit messages. */
export const CHECKPOINT_PREFIX = "devmesh/checkpoint/";

export interface GitCheckpointResult {
  sha: string;
  label: string;
  timestamp: string;
}

export interface CheckpointInfo {
  sha: string;
  label: string;
  timestamp: string;
}

export interface GitServiceOptions {
  gitBin?: string;
  timeoutMs?: number;
  author?: { name: string; email: string };
  maxBufferBytes?: number;
}

/**
 * Minimal, safe git facade for Phase 1: init/status/diff/add/commit.
 *
 * - Every invocation passes a structured argv array to `spawnSync`; there is
 *   no shell and no string interpolation into a command line.
 * - All operations run inside an approved workspace root passed by the caller.
 * - Results are fully typed; failures raise WorkspaceError with the captured
 *   exit code / stdout / stderr attached.
 */
export class GitService {
  private readonly gitBin: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly authorName: string;
  private readonly authorEmail: string;

  constructor(opts: GitServiceOptions = {}) {
    this.gitBin = opts.gitBin ?? "git";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxBufferBytes = opts.maxBufferBytes ?? 32 * 1024 * 1024;
    this.authorName = opts.author?.name ?? "DevMesh";
    this.authorEmail = opts.author?.email ?? "devmesh@localhost";
  }

  // -- low level ------------------------------------------------------------

  /**
   * Run git inside `root`. The root must exist and be a directory; args are
   * never interpreted by a shell.
   */
  run(root: string, args: readonly string[]): GitRunResult {
    this.assertRoot(root);
    const res = spawnSync(this.gitBin, [...args], {
      cwd: root,
      encoding: "utf8",
      timeout: this.timeoutMs,
      maxBuffer: this.maxBufferBytes,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
      windowsHide: true,
    });
    const timedOut = res.error instanceof Error && "code" in res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    if (res.error && !timedOut) {
      throw new WorkspaceError("git/command-failed", `failed to execute ${this.gitBin}`, {
        cause: res.error,
        details: { args },
      });
    }
    return {
      ok: res.status === 0,
      code: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      timedOut,
    };
  }

  private expect(root: string, args: readonly string[]): GitRunResult {
    const res = this.run(root, args);
    if (!res.ok) {
      throw new WorkspaceError(
        res.timedOut ? "git/timeout" : "git/command-failed",
        `git ${args[0] ?? ""} failed with exit code ${res.code}`,
        {
          details: {
            args,
            exitCode: res.code,
            stderr: res.stderr.slice(0, 4000),
            stdoutTail: res.stdout.slice(-2000),
          },
        },
      );
    }
    return res;
  }

  private assertRoot(root: string): void {
    let ok = false;
    try {
      ok = statSync(root).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new WorkspaceError(
        "workspace/not-found",
        `workspace root does not exist or is not a directory: ${root}`,
      );
    }
  }

  // -- operations -----------------------------------------------------------

  isRepository(root: string): boolean {
    const res = this.run(root, ["rev-parse", "--is-inside-work-tree"]);
    return res.ok && res.stdout.trim() === "true";
  }

  /** Idempotent `git init`. */
  init(root: string): { alreadyInit: boolean } {
    this.assertRoot(root);
    if (this.isRepository(root)) return { alreadyInit: true };
    this.expect(root, ["init"]);
    return { alreadyInit: false };
  }

  status(root: string): GitStatus {
    const res = this.expect(root, ["status", "--porcelain", "--branch"]);
    const lines = res.stdout.split("\n").filter((l) => l.length > 0);
    let branch: string | null = null;
    const entries: GitStatusEntry[] = [];
    for (const line of lines) {
      if (line.startsWith("## ")) {
        const raw = line.slice(3).split("...")[0]?.trim() || null;
        // unborn HEAD: porcelain reports "No commits yet on <branch>"
        branch =
          raw && raw.startsWith("No commits yet")
            ? (raw.split(" ").at(-1) ?? null)
            : raw;
        continue;
      }
      if (line.length < 4) continue;
      const x = line[0] as string;
      const y = line[1] as string;
      let path = line.slice(3);
      let renamedFrom: string | undefined;
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) {
        renamedFrom = path.slice(0, arrow);
        path = path.slice(arrow + 4);
      }
      entries.push({ x, y, path, renamedFrom });
    }
    return { branch, clean: entries.length === 0, entries: this.expandUntrackedDirs(root, entries) };
  }

  /**
   * Porcelain collapses wholly-untracked directories to `dir/`; expand them
   * into individual file paths so downstream hashing sees real files.
   */
  private expandUntrackedDirs(root: string, entries: GitStatusEntry[]): GitStatusEntry[] {
    if (!entries.some((e) => e.x === "?" && e.y === "?" && e.path.endsWith("/"))) {
      return entries;
    }
    const expanded: GitStatusEntry[] = [];
    for (const entry of entries) {
      if (!(entry.x === "?" && entry.y === "?" && entry.path.endsWith("/"))) {
        expanded.push(entry);
        continue;
      }
      const ls = this.run(root, [
        "ls-files",
        "-o",
        "--exclude-standard",
        "--",
        entry.path,
      ]);
      if (!ls.ok) {
        expanded.push(entry); // keep the coarse entry rather than dropping it
        continue;
      }
      for (const file of ls.stdout.split("\n")) {
        if (file.length > 0) expanded.push({ x: "?", y: "?", path: file });
      }
    }
    return expanded;
  }

  /** Raw unified diff text for unstaged, staged, or ref-scoped changes. */
  diff(
    root: string,
    opts: { staged?: boolean; ref?: string; paths?: readonly string[] } = {},
  ): { text: string; empty: boolean } {
    if (opts.ref !== undefined && !REF_PATTERN.test(opts.ref)) {
      throw new WorkspaceError("workspace/path-unsafe", `invalid ref: ${opts.ref}`);
    }
    const args = ["diff", "--no-color", "--no-ext-diff"];
    if (opts.staged) args.push("--cached");
    if (opts.ref) args.push(opts.ref);
    if (opts.paths && opts.paths.length > 0) args.push("--", ...opts.paths);
    const res = this.run(root, args);
    if (!res.ok) {
      throw new WorkspaceError(
        "git/command-failed",
        `git diff failed with exit code ${res.code}`,
        { details: { stderr: res.stderr.slice(0, 4000) } },
      );
    }
    return { text: res.stdout, empty: res.stdout.length === 0 };
  }

  /** Stage paths ('.' allowed). Each path is validated as workspace-relative. */
  add(root: string, paths: readonly string[]): void {
    if (paths.length === 0) {
      throw new WorkspaceError("workspace/path-unsafe", "add requires at least one path");
    }
    for (const p of paths) {
      if (p !== "." && !isSafeRelPath(p)) {
        throw new WorkspaceError(
          "workspace/path-unsafe",
          `refusing to stage unsafe path: ${JSON.stringify(p)}`,
        );
      }
    }
    this.expect(root, ["add", "--", ...paths]);
  }

  /**
   * Create a DevMesh checkpoint commit.
   *
   * Safety requirements:
   * - The workspace MUST be clean (no uncommitted changes) before the first
   *   checkpoint in a pipeline. This prevents committing user-owned changes
   *   that DevMesh cannot prove it owns.
   * - DevMesh only checkpoints its own managed changes; pre-existing
   *   uncommitted work is never silently committed.
   */
  checkpoint(root: string, label: string): GitCheckpointResult {
    this.assertRoot(root);
    if (!this.isRepository(root)) {
      throw new WorkspaceError("git/not-a-repository", "workspace is not a git repository");
    }
    if (!label.trim() || label.length > 120) {
      throw new WorkspaceError("git/invalid-message", "checkpoint label must be 1-120 characters");
    }
    // Verify workspace is clean before creating a checkpoint.
    const preStatus = this.status(root);
    if (!preStatus.clean) {
      throw new WorkspaceError(
        "git/dirty-workspace",
        "cannot create checkpoint: workspace has uncommitted changes",
        { details: { entries: preStatus.entries.map((e) => `${e.x}${e.y} ${e.path}`) } },
      );
    }
    const timestamp = new Date().toISOString();
    const message = `${CHECKPOINT_PREFIX}${label}/${timestamp}`;
    const commitResult = this.commit(root, message, { allowEmpty: true });
    return { sha: commitResult.sha, label, timestamp };
  }

  /**
   * Rollback the workspace to a DevMesh-owned checkpoint commit.
   *
   * Safety requirements:
   * - Only commits prefixed with `devmesh/checkpoint/` are valid targets.
   * - Refuses if unexpected uncommitted changes exist that DevMesh did not
   *   create (workspace must be clean, or only contain changes after the
   *   checkpoint commit).
   * - Uses `git reset --hard` only to a verified checkpoint SHA.
   */
  rollbackTo(root: string, targetSha: string): void {
    this.assertRoot(root);
    if (!this.isRepository(root)) {
      throw new WorkspaceError("git/not-a-repository", "workspace is not a git repository");
    }
    if (!/^[0-9a-f]{4,40}$/i.test(targetSha)) {
      throw new WorkspaceError("git/command-failed", "invalid commit SHA format");
    }
    // Verify the target commit is a DevMesh checkpoint.
    const logResult = this.run(root, [
      "log", "-1", "--format=%s", targetSha,
    ]);
    if (!logResult.ok) {
      throw new WorkspaceError("git/command-failed", `commit ${targetSha} not found`);
    }
    const message = logResult.stdout.trim();
    if (!message.startsWith(CHECKPOINT_PREFIX)) {
      throw new WorkspaceError(
        "git/not-a-devmesh-checkpoint",
        `commit ${targetSha} is not a DevMesh checkpoint (message: ${message.slice(0, 80)})`,
      );
    }
    // Check for unexpected uncommitted changes before resetting.
    const statusBefore = this.status(root);
    if (!statusBefore.clean) {
      throw new WorkspaceError(
        "git/rollback-conflict",
        "cannot rollback: workspace has uncommitted changes",
        { details: { entries: statusBefore.entries.map((e) => `${e.x}${e.y} ${e.path}`) } },
      );
    }
    // Perform the reset.
    this.expect(root, ["reset", "--hard", targetSha]);
    // Post-rollback integrity check: workspace should still be clean.
    const statusAfter = this.status(root);
    if (!statusAfter.clean) {
      throw new WorkspaceError(
        "git/rollback-conflict",
        "rollback resulted in unexpected uncommitted changes",
        { details: { entries: statusAfter.entries.map((e) => `${e.x}${e.y} ${e.path}`) } },
      );
    }
  }

  /**
   * List all DevMesh checkpoint commits in the repository.
   * Returns commits in reverse chronological order (newest first).
   */
  listCheckpoints(root: string): CheckpointInfo[] {
    this.assertRoot(root);
    if (!this.isRepository(root)) {
      throw new WorkspaceError("git/not-a-repository", "workspace is not a git repository");
    }
    const result = this.run(root, [
      "log",
      "--all",
      "--format=%H %s",
      `--grep=${CHECKPOINT_PREFIX}`,
      "--regexp-ignore-case",
    ]);
    if (!result.ok) return [];
    const checkpoints: CheckpointInfo[] = [];
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(" ");
      if (spaceIdx <= 0) continue;
      const sha = trimmed.slice(0, spaceIdx);
      const message = trimmed.slice(spaceIdx + 1);
      if (!message.startsWith(CHECKPOINT_PREFIX)) continue;
      const rest = message.slice(CHECKPOINT_PREFIX.length);
      const lastSlash = rest.lastIndexOf("/");
      const label = lastSlash >= 0 ? rest.slice(0, lastSlash) : rest;
      const timestamp = lastSlash >= 0 ? rest.slice(lastSlash + 1) : "";
      checkpoints.push({ sha, label, timestamp });
    }
    return checkpoints;
  }

  /**
   * Commit the index. Uses per-invocation identity (-c), never mutates
   * repository or user config. Returns the resulting HEAD commit.
   */
  commit(
    root: string,
    message: string,
    opts: { allowEmpty?: boolean } = {},
  ): GitCommitResult {
    if (message.trim().length === 0 || message.length > 500) {
      throw new WorkspaceError(
        "git/invalid-message",
        "commit message must be 1-500 characters",
      );
    }
    const args = [
      "-c",
      `user.name=${this.authorName}`,
      "-c",
      `user.email=${this.authorEmail}`,
      "commit",
      "-m",
      message,
      "--no-gpg-sign",
    ];
    if (opts.allowEmpty) args.push("--allow-empty");
    const res = this.run(root, args);
    if (!res.ok) {
      const nothingToCommit = /nothing to commit/.test(res.stdout + res.stderr);
      throw new WorkspaceError(
        nothingToCommit ? "git/nothing-to-commit" : "git/command-failed",
        nothingToCommit
          ? "nothing to commit (index matches HEAD)"
          : `git commit failed with exit code ${res.code}`,
        {
          details: {
            exitCode: res.code,
            stderr: res.stderr.slice(0, 4000),
            stdout: res.stdout.slice(0, 1000),
          },
        },
      );
    }
    const head = this.expect(root, ["rev-parse", "HEAD"]).stdout.trim();
    const st = this.status(root);
    return { sha: head, branch: st.branch, message };
  }
}
