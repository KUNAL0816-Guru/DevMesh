import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertNoSymlinkEscape, resolveWithin } from "./paths.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devmesh-paths-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveWithin", () => {
  it("accepts normal nested relative paths", () => {
    expect(resolveWithin(dir, "src/a/b.ts")).toBe(join(dir, "src/a/b.ts"));
    expect(resolveWithin(dir, "file.txt")).toBe(join(dir, "file.txt"));
  });

  it("rejects traversal and absolute and malformed inputs", () => {
    expect(() => resolveWithin(dir, "../escape")).toThrow(/unsafe relative path/);
    expect(() => resolveWithin(dir, "/etc/passwd")).toThrow();
    expect(() => resolveWithin(dir, "a/../../b")).toThrow();
    expect(() => resolveWithin(dir, "")).toThrow();
    expect(() => resolveWithin(dir, "a//b")).toThrow();
    expect(() => resolveWithin(dir, ".hidden")).not.toThrow(); // dotfiles fine
  });
});

describe("assertNoSymlinkEscape", () => {
  it("allows plain contained files", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "f.txt"), "x");
    expect(() => assertNoSymlinkEscape(dir, join(dir, "sub", "f.txt"))).not.toThrow();
  });

  it("detects a file reachable through an escaping symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "devmesh-outside-"));
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "s");
    const link = join(dir, "innocent");
    symlinkSync(outside, link);

    expect(() => assertNoSymlinkEscape(dir, join(link, "secret.txt"))).toThrow(
      /outside workspace via symlink/,
    );
    // non-existent child of the escaping symlink is also caught (parent probe)
    expect(() => assertNoSymlinkEscape(dir, join(link, "nope.txt"))).toThrow(
      /outside workspace via symlink/,
    );

    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts symlinks that stay inside the root", () => {
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "ok.txt"), "y");
    symlinkSync(join(dir, "real"), join(dir, "alias"));
    expect(() => assertNoSymlinkEscape(dir, join(dir, "alias", "ok.txt"))).not.toThrow();
  });
});
