import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeRuntime } from "./fake.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "devmesh-fake-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const baseRequest = () => ({
  executionId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  workspaceRoot: dir,
  instruction: "do the thing",
  timeoutMs: 10_000,
});

describe("FakeRuntime", () => {
  it("runs scripted steps and resolves with the scripted outcome", async () => {
    const rt = new FakeRuntime({
      steps: [
        { events: [{ kind: "session", sessionId: "ses_abc" }] },
        {
          effect: () => writeFileSync(join(dir, "made.txt"), "hello"),
          events: [{ kind: "tool", tool: "edit", status: "completed" }],
        },
      ],
      outcome: { status: "completed", sessionId: "ses_abc", finalText: "done" },
      stepDelayMs: 5,
    });

    const events: string[] = [];
    const running = rt.start(baseRequest());
    running.onEvent((e) => events.push(e.kind));
    const result = await running.result;

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("ses_abc");
    expect(result.finalText).toBe("done");
    expect(events).toEqual(["session", "tool"]);
    expect(readFileSync(join(dir, "made.txt"), "utf8")).toBe("hello");
    expect(rt.isRunning("11111111-1111-4111-8111-111111111111")).toBe(false);
  });

  it("reports failure results with non-zero exit codes", async () => {
    const rt = new FakeRuntime({
      steps: [{ events: [{ kind: "error", message: "boom" }] }],
      outcome: { status: "failed", exitCode: 2, failureReason: "boom" },
      stepDelayMs: 1,
    });
    const result = await rt.start(baseRequest()).result;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(2);
    expect(result.failureReason).toBe("boom");
  });

  it("supports cancellation mid-run and reports cancelled", async () => {
    const rt = new FakeRuntime({
      steps: [{ effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 30_000,
    });
    const running = rt.start(baseRequest());
    await new Promise((r) => setTimeout(r, 20));
    await running.cancel("user asked");
    const result = await running.result;
    expect(result.status).toBe("cancelled");
    expect(result.failureReason).toBe("user asked");
    expect(result.exitCode).toBeNull();
  });

  it("enforces the request timeout budget", async () => {
    const rt = new FakeRuntime({
      steps: [{ effect: () => undefined }, { effect: () => undefined }],
      outcome: { status: "completed" },
      stepDelayMs: 200,
    });
    const result = await rt.start({ ...baseRequest(), timeoutMs: 150 }).result;
    expect(result.status).toBe("timeout");
  });

  it("returns structured output from the scripted outcome", async () => {
    const rt = new FakeRuntime({
      steps: [{ events: [{ kind: "text", text: "done" }] }],
      outcome: {
        status: "completed",
        finalText: "done",
        structured: { verdict: "pass", totals: { passed: 3, failed: 0, skipped: 0 } },
      },
      stepDelayMs: 1,
    });
    const result = await rt.start({ ...baseRequest(), outputFormat: { name: "test-report", schema: {} } }).result;
    expect(result.structured).toEqual({
      verdict: "pass",
      totals: { passed: 3, failed: 0, skipped: 0 },
    });
  });

  it("omits structured output when the outcome has none", async () => {
    const rt = new FakeRuntime({
      outcome: { status: "completed", finalText: "plain text only" },
      stepDelayMs: 1,
    });
    const result = await rt.start({ ...baseRequest(), outputFormat: { name: "test-report", schema: {} } }).result;
    expect(result.structured).toBeUndefined();
  });

  it("surfaces scripted token usage on the outcome path", async () => {
    const rt = new FakeRuntime({
      outcome: {
        status: "completed",
        finalText: "done",
        usage: { inputTokens: 1200, outputTokens: 340 },
      },
      stepDelayMs: 1,
    });
    const result = await rt.start(baseRequest()).result;
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 340 });
  });

  it("carries usage on failed outcomes that measured it", async () => {
    const rt = new FakeRuntime({
      outcome: {
        status: "failed",
        failureReason: "provider error",
        usage: { inputTokens: 40, outputTokens: 10 },
      },
      stepDelayMs: 1,
    });
    const result = await rt.start(baseRequest()).result;
    expect(result.status).toBe("failed");
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 10 });
  });

  it("omits usage when the outcome declares none", async () => {
    const rt = new FakeRuntime({
      outcome: { status: "completed", finalText: "no usage recorded" },
      stepDelayMs: 1,
    });
    const result = await rt.start(baseRequest()).result;
    expect(result.usage).toBeUndefined();
  });
});
