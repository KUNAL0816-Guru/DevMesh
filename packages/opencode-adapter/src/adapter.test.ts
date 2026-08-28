import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpencodeAdapter } from "./adapter.js";

let dir: string;
let stubPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devmesh-oc-"));
  /**
   * Stub that mimics the verified `opencode run --format json` contract:
   * NDJSON lines {type, timestamp, sessionID, ...payload} on stdout, exit
   * code semantics, and optional workspace side effects. The instruction
   * arrives after `--` as a JSON action descriptor. Written as an
   * executable shebang script so the adapter can spawn it directly.
   */
  stubPath = join(dir, "stub-opencode.mjs");
  writeFileSync(
    stubPath,
    `#!/usr/bin/env node
const instruction = process.argv[process.argv.indexOf("--") + 1] ?? "{}";
const hasOutputSchema = process.argv.includes("--output-schema");
const schemaArg = hasOutputSchema ? process.argv[process.argv.indexOf("--output-schema") + 1] : undefined;
let action = {};
try { action = JSON.parse(instruction); } catch {}
const sid = "ses_stub_1234";
const line = (obj) => process.stdout.write(JSON.stringify({ timestamp: Date.now(), sessionID: sid, ...obj }) + "\\n");
line({ type: "step_start" });
if (hasOutputSchema) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("output-schema.json", schemaArg ?? "");
}
if (action.emitError) line({ type: "error", error: { message: action.emitError } });
line({ type: "text", part: { type: "text", text: action.say ?? "stub reply" }, time: { end: Date.now() } });
line({ type: "tool_use", part: { tool: "write", state: { status: "completed" } } });
if (action.emitStructured) line({ type: "structured", structured: action.emitStructured });
if (action.writeFile) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(action.writeFile), { recursive: true });
  writeFileSync(action.writeFile, action.content ?? "created by stub agent\\n");
}
if (action.sleepMs) await new Promise((r) => setTimeout(r, action.sleepMs));
line({ type: "step_finish" });
process.exit(action.exitCode ?? 0);
`,
  );
  chmodSync(stubPath, 0o755);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const request = (overrides: Record<string, unknown> = {}) => ({
  executionId: "33333333-3333-4333-8333-333333333333",
  projectId: "44444444-4444-4444-8444-444444444444",
  workspaceRoot: dir,
  instruction: "{}",
  timeoutMs: 10_000,
  ...overrides,
});

describe("OpencodeAdapter (stub binary)", () => {
  it("parses NDJSON events and collects text/session/tool info", async () => {
    const adapter = new OpencodeAdapter({ binaryPath: stubPath });
    const events: string[] = [];
    const running = adapter.start(
      request({
        instruction: JSON.stringify({
          say: "wrote it",
          writeFile: join(dir, "out.txt"),
        }),
      }),
    );
    running.onEvent((e) => {
      if (e.kind === "tool") events.push(`tool:${e.tool}:${e.status}`);
      if (e.kind === "text") events.push("text");
    });
    const result = await running.result;

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("ses_stub_1234");
    expect(result.finalText).toBe("wrote it");
    expect(events).toContain("tool:write:completed");
    // side effect happened inside the pinned cwd:
    const { readFileSync, existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "out.txt"))).toBe(true);
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toContain("stub agent");
  });

  it("maps session errors to a failed result", async () => {
    const adapter = new OpencodeAdapter({ binaryPath: stubPath });
    const result = await adapter
      .start(request({ instruction: JSON.stringify({ emitError: "provider down", exitCode: 1 }) }))
      .result;
    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("provider down");
  });

  it("kills the process group on timeout and reports timeout", async () => {
    const adapter = new OpencodeAdapter({ binaryPath: stubPath, killGraceMs: 50 });
    const result = await adapter
      .start(request({ instruction: JSON.stringify({ sleepMs: 30_000 }), timeoutMs: 300 }))
      .result;
    expect(result.status).toBe("timeout");
    expect(result.failureReason).toContain("300ms");
  });

  it("supports cancellation while the child is running", async () => {
    const adapter = new OpencodeAdapter({ binaryPath: stubPath, killGraceMs: 50 });
    const running = adapter.start(
      request({ instruction: JSON.stringify({ sleepMs: 30_000 }) }),
    );
    await new Promise((r) => setTimeout(r, 150));
    await running.cancel("operator");
    const result = await running.result;
    expect(result.status).toBe("cancelled");
    expect(result.failureReason).toBe("operator");
  });

  it("rejects the result promise when the binary cannot spawn", async () => {
    const adapter = new OpencodeAdapter({
      binaryPath: join(dir, "does-not-exist-xyz"),
    });
    await expect(adapter.start(request()).result).rejects.toMatchObject({
      code: "runtime/unavailable",
    });
  });

  it("passes outputFormat to the CLI as --output-schema", async () => {
    const adapter = new OpencodeAdapter({ binaryPath: stubPath });
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const result = await adapter
      .start(
        request({
          outputFormat: { name: "test-report", schema },
          instruction: JSON.stringify({ say: "done" }),
        }),
      )
      .result;

    expect(result.status).toBe("completed");
    // Stub wrote the schema arg to output-schema.json in the workspace cwd
    const { readFileSync, existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "output-schema.json"))).toBe(true);
    const written = readFileSync(join(dir, "output-schema.json"), "utf8");
    expect(JSON.parse(written)).toEqual(schema);
  });

  it("parses a structured output event into result.structured", async () => {
    const adapter = new OpencodeAdapter({ binaryPath: stubPath });
    const structured = { verdict: "pass", totals: { passed: 2, failed: 0, skipped: 1 } };
    const result = await adapter
      .start(
        request({
          outputFormat: { name: "test-report", schema: {} },
          instruction: JSON.stringify({ emitStructured: structured }),
        }),
      )
      .result;

    expect(result.status).toBe("completed");
    expect(result.structured).toEqual(structured);
  });
});
