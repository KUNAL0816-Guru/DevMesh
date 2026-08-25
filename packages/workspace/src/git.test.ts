import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
