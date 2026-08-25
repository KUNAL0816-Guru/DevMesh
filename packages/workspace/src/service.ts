import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { newProjectId, type ProjectId } from "@devmesh/contracts";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import { MutexMap } from "./locks.js";
import { assertNoSymlinkEscape, isSymlink, resolveWithin } from "./paths.js";
import { WorkspaceError } from "./errors.js";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ProjectRecord {
  id: ProjectId;
  name: string;
  rootPath: string;
  createdAt: string;
}

/** Persistence port for project registrations (implemented by storage). */
export interface ProjectStore {
  insert(project: ProjectRecord): void;
  get(id: ProjectId): ProjectRecord | null;
  findByName(name: string): ProjectRecord | null;
  list(): ProjectRecord[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface WorkspaceHandle {
  projectId: ProjectId;
  name: string;
  /** Canonical absolute root (realpath) of this workspace on disk. */
  root: string;
}

export interface CreateWorkspaceOptions {
  /** Optional explicit creation timestamp override (ISO string). */
  createdAt?: string;
}

export interface ReadFileOptions {
  maxBytes?: number;
}

export interface WriteFileOptions {
  maxBytes?: number;
}

export interface ListFilesOptions {
  limit?: number;
  depthLimit?: number;
}

const SKIPPED_DIRS = new Set([".git", "node_modules", "dist", ".devmesh", ".cache"]);
const DEFAULT_READ_MAX = 5 * 1024 * 1024;
const DEFAULT_WRITE_MAX = 10 * 1024 * 1024;

export function slugifyName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  if (slug.length < 3) {
    throw new WorkspaceError(
      "workspace/invalid-name",
      `project name must yield at least 3 slug characters: ${JSON.stringify(raw)}`,
    );
  }
  return slug;
}

/**
 * Owns the filesystem side of DevMesh projects: creation, safe path
 * resolution (traversal + symlink defense), guarded file IO, and
 * per-workspace mutation locking.
 */
export class WorkspaceService {
  private readonly locks = new MutexMap();

  constructor(
    private readonly opts: {
      /** Directory that contains all managed workspaces. */
      workspacesRoot: string;
      store: ProjectStore;
      lockTimeoutMs?: number;
    },
  ) {}

  // -- registry -----------------------------------------------------------

  create(rawName: string, options: CreateWorkspaceOptions = {}): WorkspaceHandle {
    const slug = slugifyName(rawName);
    const existing = this.opts.store.findByName(slug);
    if (existing) {
      throw new WorkspaceError(
        "workspace/already-exists",
        `project name already registered: ${slug}`,
      );
    }
    const id = newProjectId();
    const dir = join(this.opts.workspacesRoot, `${slug}-${id.slice(0, 8)}`);
    try {
      mkdirSync(this.opts.workspacesRoot, { recursive: true });
      mkdirSync(dir);
    } catch (err) {
      throw new WorkspaceError("workspace/io", `cannot create workspace directory ${dir}`, {
        cause: err,
      });
    }
    const root = realpathSyncSafe(dir);
    this.opts.store.insert({
      id,
      name: slug,
      rootPath: root,
      createdAt: options.createdAt ?? new Date().toISOString(),
    });
    return { projectId: id, name: slug, root };
  }

  get(id: ProjectId): WorkspaceHandle {
    const rec = this.opts.store.get(id);
    if (!rec) throw new WorkspaceError("workspace/not-found", `no project ${id}`);
    return this.handleFromRecord(rec);
  }

  getByName(name: string): WorkspaceHandle {
    const rec = this.opts.store.findByName(slugifyName(name));
    if (!rec) throw new WorkspaceError("workspace/not-found", `no project named ${name}`);
    return this.handleFromRecord(rec);
  }

  list(): WorkspaceHandle[] {
    return this.opts.store.list().map((r) => this.handleFromRecord(r));
  }

  private handleFromRecord(rec: ProjectRecord): WorkspaceHandle {
    let st;
    try {
      st = statSync(rec.rootPath);
    } catch {
      throw new WorkspaceError(
        "workspace/not-found",
        `workspace directory missing on disk: ${rec.rootPath}`,
      );
    }
    if (!st.isDirectory()) {
      throw new WorkspaceError("workspace/not-found", `workspace root is not a directory`);
    }
    return { projectId: rec.id, name: rec.name, root: realpathSyncSafe(rec.rootPath) };
  }

  // -- locking --------------------------------------------------------------

  /** Reentrancy context: service calls nested under withMutationLock see it. */
  private readonly mutationCtx = new AsyncLocalStorage<{ root: string }>();

  private holdsMutationLock(root: string): boolean {
    return this.mutationCtx.getStore()?.root === root;
  }

  isLocked(ws: WorkspaceHandle): boolean {
    return this.locks.isLocked(ws.root);
  }

  /**
   * Run a multi-step mutation atomically against other mutators. Service
   * file operations invoked inside the callback reuse the held lock instead
   * of deadlocking on it.
   */
  withMutationLock<T>(ws: WorkspaceHandle, fn: () => Promise<T> | T): Promise<T> {
    return this.mutationCtx.run({ root: ws.root }, () =>
      this.locks.withLock(ws.root, fn, this.opts.lockTimeoutMs),
    );
  }

  // -- file operations ------------------------------------------------------

  /** Resolve a relative path safely inside the workspace (no fs access). */
  resolvePath(ws: WorkspaceHandle, relPath: string): string {
    const abs = resolveWithin(ws.root, relPath);
    assertNoSymlinkEscape(ws.root, abs);
    return abs;
  }

  readFile(ws: WorkspaceHandle, relPath: string, options: ReadFileOptions = {}): Buffer {
    const abs = this.resolveExisting(ws, relPath);
    const max = options.maxBytes ?? DEFAULT_READ_MAX;
    try {
      const size = statSync(abs).size;
      if (size > max) {
        throw new WorkspaceError(
          "workspace/io",
          `file exceeds read limit (${size} > ${max} bytes): ${relPath}`,
        );
      }
      return readFileSync(abs);
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      throw new WorkspaceError("workspace/io", `cannot read ${relPath}`, { cause: err });
    }
  }

  readTextFile(ws: WorkspaceHandle, relPath: string, options: ReadFileOptions = {}): string {
    return this.readFile(ws, relPath, options).toString("utf8");
  }

  async writeFile(
    ws: WorkspaceHandle,
    relPath: string,
    data: string | Buffer,
    options: WriteFileOptions = {},
  ): Promise<{ bytesWritten: number }> {
    // validate before taking the lock so bad input fails fast
    const abs = this.resolvePath(ws, relPath);
    if (isSymlink(abs)) {
      throw new WorkspaceError(
        "workspace/symlink-refused",
        `refusing to write through symlink: ${relPath}`,
      );
    }
    const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const max = options.maxBytes ?? DEFAULT_WRITE_MAX;
    if (payload.byteLength > max) {
      throw new WorkspaceError(
        "workspace/io",
        `write exceeds limit (${payload.byteLength} > ${max} bytes)`,
      );
    }

    const write = (): { bytesWritten: number } => {
      try {
        mkdirSync(dirname(abs), { recursive: true });
        // write temp sibling then rename for crash-atomic replacement
        const tmp = `${abs}.devmesh-tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, payload);
        renameSync(tmp, abs);
        return { bytesWritten: payload.byteLength };
      } catch (err) {
        throw new WorkspaceError("workspace/io", `cannot write ${relPath}`, { cause: err });
      }
    };
    if (this.holdsMutationLock(ws.root)) return write();
    return this.locks.withLock(ws.root, write, this.opts.lockTimeoutMs);
  }

  async removeFile(ws: WorkspaceHandle, relPath: string): Promise<void> {
    const abs = this.resolveExisting(ws, relPath);
    const remove = (): void => {
      try {
        rmSync(abs, { force: false });
      } catch (err) {
        throw new WorkspaceError("workspace/io", `cannot remove ${relPath}`, { cause: err });
      }
    };
    if (this.holdsMutationLock(ws.root)) return remove();
    return this.locks.withLock(ws.root, remove, this.opts.lockTimeoutMs);
  }

  /**
   * Recursive listing bounded by depth and count; skips VCS/build dirs.
   * Paths are workspace-relative POSIX strings, sorted.
   */
  listFiles(ws: WorkspaceHandle, relDir = "", options: ListFilesOptions = {}): string[] {
    const startAbs = relDir === "" ? ws.root : this.resolveExisting(ws, relDir);
    const limit = options.limit ?? 2000;
    const depthLimit = options.depthLimit ?? 12;
    const out: string[] = [];

    const walk = (absDir: string, relBase: string, depth: number): void => {
      if (out.length >= limit || depth > depthLimit) return;
      let entries;
      try {
        entries = readdirSync(absDir, { withFileTypes: true });
      } catch (err) {
        throw new WorkspaceError("workspace/io", `cannot list ${relBase || "."}`, { cause: err });
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const e of entries) {
        if (out.length >= limit) return;
        const childRel = relBase === "" ? e.name : `${relBase}/${e.name}`;
        if (e.isDirectory()) {
          if (SKIPPED_DIRS.has(e.name) || isSymlink(join(absDir, e.name))) continue;
          walk(join(absDir, e.name), childRel, depth + 1);
        } else if (e.isFile()) {
          out.push(childRel);
          if (out.length >= limit) return;
        }
      }
    };

    walk(startAbs, relDir, 1);
    return out;
  }

  private resolveExisting(ws: WorkspaceHandle, relPath: string): string {
    const abs = this.resolvePath(ws, relPath);
    if (isSymlink(abs)) {
      throw new WorkspaceError(
        "workspace/symlink-refused",
        `refusing symlink path: ${relPath}`,
      );
    }
    try {
      statSync(abs);
    } catch {
      throw new WorkspaceError("workspace/not-found", `no such file: ${relPath}`);
    }
    return abs;
  }
}

// -- helpers -----------------------------------------------------------------

function realpathSyncSafe(p: string): string {
  return realpathSync(p);
}
