import { createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactSchema,
  newArtifactBase,
  newArtifactId,
  type Artifact,
  type FileEvidence,
} from "@devmesh/contracts";
import type { GitStatus } from "@devmesh/workspace";

/** SHA-256 of a file, hex encoded — computed by DevMesh, never by an agent. */
export function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/**
 * Extract workspace-relative paths of files added or modified according to
 * git porcelain status. Deleted files have no evidence to hash, so they are
 * skipped here and surface via the status snapshot instead.
 */
export function changedFilePaths(status: GitStatus): string[] {
  const paths = new Set<string>();
  for (const entry of status.entries) {
    const states = `${entry.x}${entry.y}`;
    if (states.includes("D")) continue; // deletion: nothing to hash
    if (entry.path) paths.add(entry.path);
  }
  return [...paths].sort();
}

export function fileEvidenceFor(
  root: string,
  relPath: string,
): FileEvidence | { path: string; error: string } {
  const abs = join(root, relPath);
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { path: relPath, error: "not a regular file" };
    return {
      path: relPath,
      sha256: sha256File(abs),
      sizeBytes: st.size,
    };
  } catch (err) {
    return { path: relPath, error: err instanceof Error ? err.message : "unreadable" };
  }
}

export interface ObservedChangeSet {
  branch: string;
  filesChanged: FileEvidence[];
  unreadable: Array<{ path: string; error: string }>;
}

/** Observe actual workspace changes after an agent run. */
export function observeChanges(root: string, status: GitStatus): ObservedChangeSet {
  const filesChanged: FileEvidence[] = [];
  const unreadable: Array<{ path: string; error: string }> = [];
  for (const relPath of changedFilePaths(status)) {
    const evidence = fileEvidenceFor(root, relPath);
    if ("sha256" in evidence) filesChanged.push(evidence);
    else unreadable.push(evidence);
  }
  return { branch: status.branch ?? "HEAD", filesChanged, unreadable };
}

export interface VerificationOutcome {
  changeSet: Artifact | null;
  verification: Artifact | null;
  failingChecks: number;
}

/**
 * Build the change_set artifact (DevMesh-observed ground truth) and the
 * verification.v1 artifact that independently re-checks every recorded
 * hash against the current disk state. `extraChecks` (e.g. command_replay
 * results) are appended to the file-hash checks and count toward the
 * verdict.
 */
export function buildVerificationArtifacts(input: {
  root: string;
  observed: ObservedChangeSet;
  ctx: { runId: string; projectId: string; taskId?: string };
  producedBy: "architect" | "developer" | "tester" | "reviewer" | "system";
  extraChecks?: Array<Record<string, unknown>>;
}): VerificationOutcome {
  const { root, observed, ctx } = input;
  // A change_set needs >=1 observed file (contract invariant), so command
  // checks only apply to runs that also produced workspace changes.
  if (observed.filesChanged.length === 0) {
    return { changeSet: null, verification: null, failingChecks: 0 };
  }

  const base = newArtifactBase({
    runId: ctx.runId as never,
    projectId: ctx.projectId as never,
    taskId: ctx.taskId as never,
    producedBy: input.producedBy,
  });
  const changeSet = artifactSchema.parse({
    kind: "change_set",
    ...base,
    id: newArtifactId(),
    payload: {
      branch: observed.branch,
      commits: [],
      filesChanged: observed.filesChanged,
      commandsRun: [],
      notes: `observed by devmesh for execution run ${ctx.runId}`,
    },
  });

  // Independent re-verification pass: recompute hashes right now.
  const checks = observed.filesChanged.map((file) => {
    let actualSha256: string;
    try {
      actualSha256 = sha256File(join(root, file.path));
    } catch {
      return {
        kind: "file_hash" as const,
        path: file.path,
        expectedSha256: file.sha256,
        actualSha256: "",
        passed: false,
        detail: "file unreadable during verification",
      };
    }
    return {
      kind: "file_hash" as const,
      path: file.path,
      expectedSha256: file.sha256,
      actualSha256,
      passed: actualSha256 === file.sha256,
    };
  });
  const failingChecks =
    checks.filter((c) => !c.passed).length +
    (input.extraChecks ?? []).filter((c) => c.passed !== true).length;

  const verification = artifactSchema.parse({
    kind: "verification",
    ...newArtifactBase({
      runId: ctx.runId as never,
      projectId: ctx.projectId as never,
      taskId: ctx.taskId as never,
      producedBy: "system",
    }),
    id: newArtifactId(),
    payload: {
      target: { artifactId: changeSet.id },
      checks: [...checks, ...(input.extraChecks ?? [])],
      verdict: failingChecks === 0 ? "verified" : "rejected",
    },
  });

  return { changeSet, verification, failingChecks };
}
