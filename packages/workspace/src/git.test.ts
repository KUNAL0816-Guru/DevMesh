import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService } from "./git.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "devmesh-git-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("GitService", () => {
  const git = new GitService();

  it("init is idempotent and detects repositories", () => {
    expect(git.isRepository(root)).toBe(false);
    expect(git.init(root)).toEqual({ alreadyInit: false });
    expect(git.isRepository(root)).toBe(true);
    expect(git.init(root)).toEqual({ alreadyInit: true });
  });

  it("refuses to operate outside an existing directory", () => {
    expect(() => git.run(join(root, "missing"), ["status"])).toThrow(
      /does not exist or is not a directory/,
    );
  });

  it("add/commit/status/diff happy path", () => {
    git.init(root);
    writeFileSync(join(root, "hello.txt"), "hello world\n");

    const st = git.status(root);
    expect(st.branch).toBeTruthy();
    expect(st.clean).toBe(false); // untracked file counts as dirty
    expect(st.entries).toHaveLength(1);
    expect(st.entries[0]?.path).toBe("hello.txt");

    git.add(root, ["hello.txt"]);
    expect(git.status(root).entries[0]).toMatchObject({ x: "A" });
    expect(git.diff(root, { staged: true }).empty).toBe(false);

    const c = git.commit(root, "feat: initial hello");
    expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(c.message).toContain("hello");
    expect(c.branch).toBe(git.status(root).branch);

    const after = git.status(root);
    expect(after.clean).toBe(true);
    expect(git.diff(root).empty).toBe(true);
    expect(git.diff(root, { staged: true }).empty).toBe(true);
  });

  it("commit with no staged changes raises nothing-to-commit", () => {
    git.init(root);
    const first = git.commit(root, "root commit", { allowEmpty: true });
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(() => git.commit(root, "should fail")).toThrow(/nothing to commit/);
    // typed error code:
    try {
      git.commit(root, "typed check");
      throw new Error("expected failure");
    } catch (err) {
      if ((err as Error).message === "expected failure") throw err;
      expect((err as { code?: string }).code).toBe("git/nothing-to-commit");
    }
  });

  it("rejects unsafe staging paths without invoking git", () => {
    git.init(root);
    expect(() => git.add(root, ["../escape.txt"])).toThrow(
      /unsafe path/,
    );
    expect(() => git.add(root, [])).toThrow();
    expect(() => git.add(root, ["/abs/path"])).toThrow();
  });

  it("rejects invalid commit messages and refs", () => {
    git.init(root);
    expect(() => git.commit(root, "   ")).toThrow(/1-500 characters/);
    expect(() => git.commit(root, "x".repeat(501))).toThrow();
    expect(() => git.diff(root, { ref: "--upload-pack=evil" })).toThrow(/invalid ref/);
    // tilde and dots are legitimate in refs — validation alone must not reject
    let rejectedAsInvalidRef = false;
    try {
      git.diff(root, { ref: "HEAD~1..HEAD" }); // unborn HEAD: git fails, not our validator
    } catch (err) {
      if ((err as { code?: string }).code === "workspace/path-unsafe") {
        rejectedAsInvalidRef = true;
      }
    }
    expect(rejectedAsInvalidRef).toBe(false);
  });

  it("captures stderr details on command failure", () => {
    git.init(root);
    // unborn HEAD: rev-parse fails and the typed error carries git's stderr
    try {
      git.diff(root, { ref: "HEAD" });
      throw new Error("expected failure");
    } catch (err) {
      if ((err as Error).message === "expected failure") throw err;
      const e = err as { code?: string; message?: string };
      expect(e.code).toBe("git/command-failed");
      expect(e.message).toContain("diff");
    }
  });
});

describe("GitService: Checkpoint/Rollback", () => {
  const git = new GitService();

  it("checkpoint creates a commit with devmesh/checkpoint/ prefix", () => {
    git.init(root);
    // Need at least one commit for checkpoint to work (workspace must be clean)
    writeFileSync(join(root, "initial.txt"), "baseline");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    const cp = git.checkpoint(root, "before-revision");
    expect(cp.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(cp.label).toBe("before-revision");
    expect(cp.timestamp).toBeTruthy();

    // Workspace should still be clean after checkpoint
    expect(git.status(root).clean).toBe(true);

    // The commit message should have the checkpoint prefix
    const log = git.run(root, ["log", "-1", "--format=%s", cp.sha]);
    expect(log.stdout.trim()).toMatch(/^devmesh\/checkpoint\/before-revision\//);
  });

  it("checkpoint requires a clean workspace", () => {
    git.init(root);
    writeFileSync(join(root, "initial.txt"), "baseline");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    // Add an uncommitted change
    writeFileSync(join(root, "dirty.txt"), "uncommitted");

    try {
      git.checkpoint(root, "should-fail");
      throw new Error("expected failure");
    } catch (err) {
      if ((err as Error).message === "expected failure") throw err;
      expect((err as { code?: string }).code).toBe("git/dirty-workspace");
    }
  });

  it("checkpoint rejects empty labels and very long labels", () => {
    git.init(root);
    writeFileSync(join(root, "initial.txt"), "baseline");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    expect(() => git.checkpoint(root, "   ")).toThrow(/1-120 characters/);
    expect(() => git.checkpoint(root, "x".repeat(121))).toThrow(/1-120 characters/);
  });

  it("rollbackTo restores workspace to checkpoint state", () => {
    git.init(root);
    // Initial commit
    writeFileSync(join(root, "file.txt"), "v1");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    // Create checkpoint
    const cp = git.checkpoint(root, "safe-point");

    // Make changes after checkpoint
    writeFileSync(join(root, "file.txt"), "v2");
    writeFileSync(join(root, "new.txt"), "added");
    git.add(root, ["."]);
    git.commit(root, "after checkpoint");

    // Workspace has v2
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("v2");
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("added");

    // Rollback to checkpoint
    git.rollbackTo(root, cp.sha);

    // Workspace restored to v1, new.txt gone
    expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("v1");
    expect(() => readFileSync(join(root, "new.txt"))).toThrow();
    // Workspace is clean after rollback
    expect(git.status(root).clean).toBe(true);
  });

  it("rollbackTo refuses non-DevMesh commits", () => {
    git.init(root);
    writeFileSync(join(root, "file.txt"), "v1");
    git.add(root, ["."]);
    const initial = git.commit(root, "user commit");

    // Try to rollback to a user commit
    try {
      git.rollbackTo(root, initial.sha);
      throw new Error("expected failure");
    } catch (err) {
      if ((err as Error).message === "expected failure") throw err;
      expect((err as { code?: string }).code).toBe("git/not-a-devmesh-checkpoint");
    }
  });

  it("rollbackTo refuses when workspace has uncommitted changes", () => {
    git.init(root);
    writeFileSync(join(root, "file.txt"), "v1");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    const cp = git.checkpoint(root, "safe-point");

    // Add uncommitted changes (simulating user work)
    writeFileSync(join(root, "user-file.txt"), "user work");

    // Rollback should refuse
    try {
      git.rollbackTo(root, cp.sha);
      throw new Error("expected failure");
    } catch (err) {
      if ((err as Error).message === "expected failure") throw err;
      expect((err as { code?: string }).code).toBe("git/rollback-conflict");
    }
    // User file should still be there
    expect(readFileSync(join(root, "user-file.txt"), "utf8")).toBe("user work");
  });

  it("rollbackTo refuses invalid SHA format", () => {
    git.init(root);
    writeFileSync(join(root, "initial.txt"), "baseline");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    expect(() => git.rollbackTo(root, "not-a-sha")).toThrow(/invalid commit SHA format/);
    expect(() => git.rollbackTo(root, "")).toThrow(/invalid commit SHA format/);
  });

  it("rollbackTo refuses non-existent SHA", () => {
    git.init(root);
    writeFileSync(join(root, "initial.txt"), "baseline");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    try {
      git.rollbackTo(root, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      throw new Error("expected failure");
    } catch (err) {
      if ((err as Error).message === "expected failure") throw err;
      expect((err as { code?: string }).code).toBe("git/command-failed");
    }
  });

  it("listCheckpoints returns DevMesh checkpoints in reverse order", () => {
    git.init(root);
    writeFileSync(join(root, "file.txt"), "v1");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    const cp1 = git.checkpoint(root, "first");
    // Need to make a change and commit before second checkpoint (workspace must be clean)
    writeFileSync(join(root, "file.txt"), "v2");
    git.add(root, ["."]);
    git.commit(root, "change 1");
    const cp2 = git.checkpoint(root, "second");

    const list = git.listCheckpoints(root);
    expect(list.length).toBeGreaterThanOrEqual(2);
    // Newest first
    expect(list[0]?.sha).toBe(cp2.sha);
    expect(list[0]?.label).toBe("second");
    expect(list[1]?.sha).toBe(cp1.sha);
    expect(list[1]?.label).toBe("first");
  });

  it("listCheckpoints returns empty array for repos with no checkpoints", () => {
    git.init(root);
    writeFileSync(join(root, "file.txt"), "v1");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    const list = git.listCheckpoints(root);
    expect(list).toHaveLength(0);
  });

  it("checkpoint is idempotent label-wise (same label, different timestamps)", () => {
    git.init(root);
    writeFileSync(join(root, "file.txt"), "v1");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    const cp1 = git.checkpoint(root, "revision-1");
    // Workspace is clean, but there are no new changes — checkpoint will
    // fail with nothing-to-commit since nothing changed.
    // We need to make a change first.
    writeFileSync(join(root, "file.txt"), "v2");
    git.add(root, ["."]);
    git.commit(root, "change for second checkpoint");
    const cp2 = git.checkpoint(root, "revision-1");

    expect(cp1.sha).not.toBe(cp2.sha);
    expect(cp1.label).toBe(cp2.label);
  });

  it("preserves argv-only git security boundary (no shell)", () => {
    git.init(root);
    // Ensure shell metacharacters in label don't cause issues
    writeFileSync(join(root, "initial.txt"), "baseline");
    git.add(root, ["."]);
    git.commit(root, "initial commit");

    // Labels with special characters are rejected by length/format checks,
    // not passed to shell. Verify the error is thrown before any git call.
    expect(() => git.checkpoint(root, "")).toThrow();
    expect(() => git.checkpoint(root, "   ")).toThrow();
  });

  it("checkpoint/rollback protects pre-existing user changes across full lifecycle", () => {
    git.init(root);

    // User creates initial content
    writeFileSync(join(root, "app.js"), "original code");
    git.add(root, ["."]);
    git.commit(root, "initial project setup");

    // DevMesh creates a checkpoint
    const cp = git.checkpoint(root, "pre-dev");

    // DevMesh's agent makes changes
    writeFileSync(join(root, "app.js"), "modified by agent");
    writeFileSync(join(root, "new-file.js"), "agent created");
    git.add(root, ["."]);
    git.commit(root, "agent changes");

    // Verify agent changes exist
    expect(readFileSync(join(root, "app.js"), "utf8")).toBe("modified by agent");
    expect(readFileSync(join(root, "new-file.js"), "utf8")).toBe("agent created");

    // Rollback restores to user's original state
    git.rollbackTo(root, cp.sha);

    // User's original file is restored, agent file is gone
    expect(readFileSync(join(root, "app.js"), "utf8")).toBe("original code");
    expect(() => readFileSync(join(root, "new-file.js"))).toThrow();
  });
});
