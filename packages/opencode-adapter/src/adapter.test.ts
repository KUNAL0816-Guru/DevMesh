import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpencodeAdapter } from "./adapter.js";
import { OpenAiCompatibleRuntime } from "./local-runtime.js";

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
if (action.usage) {
  // Verified opencode shape: step_finish carries { part: { tokens: { input, output, ... } } }
  line({ type: "step_finish", part: { type: "step-finish", tokens: action.usage } });
  if (action.repeatUsageSteps === true) line({ type: "step_finish", part: { type: "step-finish", tokens: action.usage } });
} else {
  line({ type: "step_finish" });
}
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

  it("surfaces usage parsed from step_finish tokens", async () => {
    const adapter = new OpencodeAdapter({ binaryPath: stubPath });
    const result = await adapter
      .start(
        request({
          instruction: JSON.stringify({
            usage: { input: 812, output: 199 },
          }),
        }),
      )
      .result;
    expect(result.status).toBe("completed");
    expect(result.usage).toEqual({ inputTokens: 812, outputTokens: 199 });
  });

  it("accumulates usage across multiple step_finish events", async () => {
    const adapter = new OpencodeAdapter({ binaryPath: stubPath });
    const result = await adapter
      .start(
        request({
          instruction: JSON.stringify({
            usage: { input: 100, output: 20 },
            repeatUsageSteps: true,
          }),
        }),
      )
      .result;
    expect(result.status).toBe("completed");
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
  });

  it("omits usage when no step reports tokens", async () => {
    const adapter = new OpencodeAdapter({ binaryPath: stubPath });
    const result = await adapter.start(request()).result;
    expect(result.status).toBe("completed");
    expect(result.usage).toBeUndefined();
  });

  it("ignores malformed step usage instead of fabricating totals", async () => {
    const adapter = new OpencodeAdapter({ binaryPath: stubPath });
    const result = await adapter
      .start(
        request({
          instruction: JSON.stringify({ usage: { input: -1, output: "many" } }),
        }),
      )
      .result;
    // Negative input + non-numeric output fail the integer guard -> whole
    // step ignored, total left undefined (never a fabricated 0).
    expect(result.usage).toBeUndefined();
  });
});

describe("OpenAiCompatibleRuntime (local endpoint)", () => {
  const localRequest = (overrides: Record<string, unknown> = {}) => ({
    executionId: "55555555-5555-4555-8555-555555555555",
    projectId: "66666666-6666-4666-8666-666666666666",
    workspaceRoot: dir,
    instruction: "write a test",
    timeoutMs: 10_000,
    ...overrides,
  });

  interface Captured {
    url: string;
    init: RequestInit;
  }

  function singleCall(calls: Captured[]): Captured {
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("expected a captured call");
    return call;
  }

  function okJson(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("sends the configured base URL, model, api key, and user message", async () => {
    const calls: Captured[] = [];
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      apiKey: "secret-token",
      fetch: (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(
          okJson({ choices: [{ message: { content: "ok" } }] }),
        );
      },
    });
    const result = await runtime.start(localRequest()).result;

    expect(result.status).toBe("completed");
    const call = singleCall(calls);
    expect(call.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-token");
    const body = JSON.parse(String(call.init.body));
    expect(body.model).toBe("llama3.2");
    expect(body.messages).toEqual([
      { role: "user", content: "write a test" },
    ]);
  });

  it("does not send an Authorization header when no api key is configured", async () => {
    const calls: Captured[] = [];
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(okJson({ choices: [{ message: { content: "ok" } }] }));
      },
    });
    await runtime.start(localRequest()).result;
    const headers = singleCall(calls).init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("normalizes a base URL so path segments are not duplicated", async () => {
    const calls: Captured[] = [];
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1/",
      model: "llama3.2",
      fetch: (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Promise.resolve(okJson({ choices: [{ message: { content: "ok" } }] }));
      },
    });
    await runtime.start(localRequest()).result;
    expect(singleCall(calls).url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });

  it("returns a completed result with text, session id, and usage", async () => {
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: () =>
        Promise.resolve(
          okJson({
            choices: [{ message: { content: "the answer" } }],
            usage: { prompt_tokens: 5, completion_tokens: 9 },
          }),
        ),
    });
    const result = await runtime.start(localRequest()).result;

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.finalText).toBe("the answer");
    expect(result.sessionId).toBe(localRequest().executionId);
    expect(result.stderrTail).toBe("");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 9 });
  });

  it("omits usage when the endpoint reports none or invalid usage", async () => {
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: () =>
        Promise.resolve(okJson({ choices: [{ message: { content: "hi" } }] })),
    });
    const result = await runtime.start(localRequest()).result;
    expect(result.status).toBe("completed");
    expect(result.usage).toBeUndefined();

    const badUsage = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: () =>
        Promise.resolve(
          okJson({
            choices: [{ message: { content: "hi" } }],
            usage: { prompt_tokens: -1, completion_tokens: "many" },
          }),
        ),
    });
    const bad = await badUsage.start(localRequest()).result;
    expect(bad.status).toBe("completed");
    expect(bad.usage).toBeUndefined();
  });

  it("surfaces health via GET /models as healthy on 2xx", async () => {
    const calls: string[] = [];
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: (url) => {
        calls.push(String(url));
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    });
    const health = await runtime.health();
    expect(health.healthy).toBe(true);
    expect(calls).toEqual(["http://127.0.0.1:11434/v1/models"]);
  });

  it("reports unhealthy on non-2xx, connection failure, or timeout", async () => {
    const unhealthy404 = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: () => Promise.resolve(new Response("{}", { status: 500 })),
    });
    expect((await unhealthy404.health()).healthy).toBe(false);

    const connectionFail = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect((await connectionFail.health()).healthy).toBe(false);
  });

  it("maps HTTP failures to a failed result with a meaningful reason", async () => {
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: () =>
        Promise.resolve(new Response("denied", { status: 401, statusText: "Unauthorized" })),
    });
    const result = await runtime.start(localRequest()).result;
    expect(result.status).toBe("failed");
    expect(result.failureReason).toContain("401");
    expect(result.exitCode).toBe(401);
  });

  it("maps a malformed successful response to a failed result", async () => {
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: () =>
        Promise.resolve(
          okJson({
            choices: [{ message: { content: 42 } }],
          }),
        ),
    });
    const result = await runtime.start(localRequest()).result;
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("malformed completion response");
  });

  it("rejects with runtime/unavailable on connection failure", async () => {
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    await expect(runtime.start(localRequest()).result).rejects.toMatchObject({
      code: "runtime/unavailable",
    });
  });

  it("resolves status timeout when the execution exceeds its budget", async () => {
    const runtime = new OpenAiCompatibleRuntime({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "llama3.2",
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }).then(
          () => new Response("{}", { status: 200 }),
          (err) => {
            // mirror the real fetch abort behavior
            const e = new Error(err?.message ?? "aborted");
            e.name = "AbortError";
            throw e;
          },
        ),
    });
    const result = await runtime
      .start(localRequest({ timeoutMs: 100 }))
      .result;
    expect(result.status).toBe("timeout");
    expect(result.failureReason).toContain("100ms");
  });
});
