import { lstatSync, realpathSync } from "node:fs";
import { isSafeRelPath } from "@devmesh/contracts";
import { dirname, join, resolve, sep } from "node:path";
import { WorkspaceError } from "./errors.js";

/**
 * Lexically validate a workspace-relative path and resolve it under `root`.
 * Throws workspace/path-unsafe for absolute paths, traversal segments,
 * backslashes, empty segments, or anything escaping the root.
 */
export function resolveWithin(root: string, relPath: string): string {
  if (!isSafeRelPath(relPath)) {
    throw new WorkspaceError(
      "workspace/path-unsafe",
      `refusing unsafe relative path: ${JSON.stringify(relPath)}`,
    );
  }
  const abs = resolve(join(root, relPath));
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new WorkspaceError(
      "workspace/path-unsafe",
      `resolved path escapes workspace root: ${relPath}`,
    );
  }
  return abs;
}

/**
 * Defense against symlink escapes: for the deepest existing ancestor of
 * `abs`, verify its real path stays inside `root`. New files (not yet
 * existing) are validated through their existing parent chain.
 */
export function assertNoSymlinkEscape(root: string, abs: string): void {
  let probe = abs;
  for (let depth = 0; depth < 64; depth++) {
    try {
      const real = realpathSync(probe);
      const rootReal = realpathSync(root);
      const rootWithSep = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
      if (real !== rootReal && !real.startsWith(rootWithSep)) {
        throw new WorkspaceError(
          "workspace/symlink-refused",
          `path resolves outside workspace via symlink: ${probe}`,
        );
      }
      return; // deepest existing ancestor contained — done
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      // ENOENT etc: walk up
      const parent = dirname(probe);
      if (parent === probe) return; // reached filesystem root without escape signal
      probe = parent;
    }
  }
}

/** True when path exists and is a symlink (refuse to follow these). */
export function isSymlink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}
