import { z } from "zod";

/** Wire-format schema version for artifacts (bump on breaking payload changes). */
export const SCHEMA_VERSION = 1 as const;

export const isoTimestampSchema = z.iso.datetime();

export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "expected a lowercase sha-256 hex digest");

export const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, "expected a git commit sha (7-64 lowercase hex)");

export const globPatternSchema = z.string().min(1).max(512);

/**
 * True when `p` is a safe workspace-relative POSIX path:
 * non-empty, not absolute, no backslashes, no "." or ".." or empty segments,
 * no trailing slash.
 */
export function isSafeRelPath(p: string): boolean {
  if (p.length === 0 || p.length > 1024) return false;
  if (p.startsWith("/") || p.includes("\\") || p.endsWith("/")) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

export const relPathSchema = z
  .string()
  .max(1024)
  .refine(isSafeRelPath, "unsafe or malformed relative path");

// ---------------------------------------------------------------------------
// JSON values (recursive)
// ---------------------------------------------------------------------------

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export const jsonValueSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
