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
});
