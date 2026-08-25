import { describe, expect, it } from "vitest";
import {
  commitShaSchema,
  isSafeRelPath,
  isoTimestampSchema,
  jsonValueSchema,
  relPathSchema,
  sha256HexSchema,
} from "./common.js";

describe("isSafeRelPath", () => {
  const ok = [
    "src/index.ts",
    "a/b/c.md",
    "file.txt",
    "docs/adr/0001-x.md",
    ".github/workflows/ci.yml",
  ];
  const bad = [
    "",
    "/abs/path",
    "back\\slash",
    "../up",
    "a/../b",
    "a/./b",
    "trailing/",
    "..",
    "./x",
    "a//b",
  ];

  it.each(ok)("accepts %s", (p) => expect(isSafeRelPath(p)).toBe(true));
  it.each(bad)("rejects %s", (p) => expect(isSafeRelPath(p)).toBe(false));
});

describe("relPathSchema", () => {
  it("accepts a normal path and rejects traversal", () => {
    expect(relPathSchema.safeParse("src/a.ts").success).toBe(true);
    expect(relPathSchema.safeParse("../escape").success).toBe(false);
    expect(relPathSchema.safeParse("").success).toBe(false);
  });
});

describe("isoTimestampSchema", () => {
  it("accepts ISO-8601 with Z and rejects loose strings", () => {
    expect(isoTimestampSchema.safeParse(new Date().toISOString()).success).toBe(true);
    expect(isoTimestampSchema.safeParse("2026-01-01").success).toBe(false);
    expect(isoTimestampSchema.safeParse("yesterday").success).toBe(false);
  });
});

describe("hash schemas", () => {
  const sha = "a".repeat(64);
  it("accepts lowercase sha-256", () => {
    expect(sha256HexSchema.safeParse(sha).success).toBe(true);
  });
  it("rejects uppercase, short, and non-hex digests", () => {
    expect(sha256HexSchema.safeParse(sha.toUpperCase()).success).toBe(false);
    expect(sha256HexSchema.safeParse("abc123").success).toBe(false);
  });
  it("commit sha accepts short form", () => {
    expect(commitShaSchema.safeParse("deadbeef").success).toBe(true);
    expect(commitShaSchema.safeParse("DEADBEEF").success).toBe(false);
  });
});

describe("jsonValueSchema", () => {
  it("accepts nested JSON structures", () => {
    const v = { a: [1, "two", null, { b: true }], c: [] };
    expect(jsonValueSchema.parse(v)).toEqual(v);
  });
  it("rejects non-JSON values", () => {
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse(() => 1).success).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(jsonValueSchema.safeParse(BigInt(1) as any).success).toBe(false);
  });
});
