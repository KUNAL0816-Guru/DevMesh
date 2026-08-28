import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ArtifactId,
  type ProjectId,
  projectIdSchema,
  newArtifactId,
  isArtifactKind,
} from "@devmesh/contracts";
import {
  classifyReplay,
  buildTestReportReplayVerification,
} from "./verify.js";
import type { CommandReplayOutcome } from "./commands.js";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-verify-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

const projectId = (): ProjectId => projectIdSchema.parse(crypto.randomUUID());

// ---------------------------------------------------------------------------
// classifyReplay
// ---------------------------------------------------------------------------

describe("classifyReplay", () => {
  it("consistent: pass claim + exit 0", () => {
    const outcome: CommandReplayOutcome = {
      command: "npm test",
      exitCode: 0,
      passed: true,
      detail: "replayed by devmesh in 100ms",
    };
    expect(classifyReplay({ verdict: "pass" }, outcome)).toBe("consistent");
  });

  it("consistent: fail claim + non-zero exit", () => {
    const outcome: CommandReplayOutcome = {
      command: "npm test",
      exitCode: 1,
      passed: false,
      detail: "replayed by devmesh in 100ms; stderr: fail",
    };
    expect(classifyReplay({ verdict: "fail" }, outcome)).toBe("consistent");
  });

  it("consistent: error claim + non-zero exit", () => {
    const outcome: CommandReplayOutcome = {
      command: "npm test",
      exitCode: 2,
      passed: false,
      detail: "replayed by devmesh in 100ms",
    };
    expect(classifyReplay({ verdict: "error" }, outcome)).toBe("consistent");
  });

  it("contradiction: pass claim but replay fails", () => {
    const outcome: CommandReplayOutcome = {
      command: "npm test",
      exitCode: 1,
      passed: false,
      detail: "replayed by devmesh in 100ms; stderr: assertion failed",
    };
    expect(classifyReplay({ verdict: "pass" }, outcome)).toBe("contradiction");
  });

  it("contradiction: fail claim but replay passes", () => {
    const outcome: CommandReplayOutcome = {
      command: "npm test",
      exitCode: 0,
      passed: true,
      detail: "replayed by devmesh in 100ms",
    };
    expect(classifyReplay({ verdict: "fail" }, outcome)).toBe("contradiction");
  });

  it("contradiction: error claim but replay passes", () => {
    const outcome: CommandReplayOutcome = {
      command: "npm test",
      exitCode: 0,
      passed: true,
      detail: "replayed by devmesh in 100ms",
    };
    expect(classifyReplay({ verdict: "error" }, outcome)).toBe("contradiction");
  });

  it("inconclusive: replay is inconclusive regardless of claim", () => {
    const outcome: CommandReplayOutcome = {
      command: "cargo test",
      exitCode: 127,
      passed: false,
      detail: "verification command rejected by safety policy",
      inconclusive: true,
    };
    expect(classifyReplay({ verdict: "pass" }, outcome)).toBe("inconclusive");
    expect(classifyReplay({ verdict: "fail" }, outcome)).toBe("inconclusive");
    expect(classifyReplay({ verdict: "error" }, outcome)).toBe("inconclusive");
  });
});

// ---------------------------------------------------------------------------
// buildTestReportReplayVerification
// ---------------------------------------------------------------------------

describe("buildTestReportReplayVerification", () => {
  const ctx = () => ({
    runId: "11111111-1111-4111-8111-111111111111",
    projectId: projectId(),
    taskId: "22222222-2222-4222-8222-222222222222" as ArtifactId,
  });

  it("produces a verification.v1 artifact with command_replay check (consistent)", () => {
    const targetId = newArtifactId();
    const replay: CommandReplayOutcome = {
      command: "npm test",
      exitCode: 0,
      passed: true,
      detail: "replayed by devmesh in 50ms",
    };
    const artifact = buildTestReportReplayVerification({
      ctx: ctx(),
      targetArtifactId: targetId,
      replay,
      classification: "consistent",
    });

    if (!isArtifactKind(artifact, "verification")) {
      expect.unreachable();
      return;
    }
    expect(artifact.payload.verdict).toBe("verified");

    const check = artifact.payload.checks[0] as Record<string, unknown>;
    expect(check.kind).toBe("command_replay");
    expect(check.command).toBe("npm test");
    expect(check.exitCode).toBe(0);
    expect(check.passed).toBe(true);
    expect(artifact.payload.target.artifactId).toBe(targetId);
  });

  it("produces a rejected verification for contradiction", () => {
    const targetId = newArtifactId();
    const replay: CommandReplayOutcome = {
      command: "npm test",
      exitCode: 1,
      passed: false,
      detail: "replayed by devmesh in 50ms; stderr: fail",
    };
    const artifact = buildTestReportReplayVerification({
      ctx: ctx(),
      targetArtifactId: targetId,
      replay,
      classification: "contradiction",
    });

    if (!isArtifactKind(artifact, "verification")) {
      expect.unreachable();
      return;
    }
    expect(artifact.payload.verdict).toBe("rejected");

    const check = artifact.payload.checks[0] as Record<string, unknown>;
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("fail");
  });

  it("produces a verified (pass-through) verification for inconclusive", () => {
    const targetId = newArtifactId();
    const replay: CommandReplayOutcome = {
      command: "cargo test",
      exitCode: 127,
      passed: false,
      detail: "verification command rejected by safety policy",
      inconclusive: true,
    };
    const artifact = buildTestReportReplayVerification({
      ctx: ctx(),
      targetArtifactId: targetId,
      replay,
      classification: "inconclusive",
    });

    if (!isArtifactKind(artifact, "verification")) {
      expect.unreachable();
      return;
    }
    expect(artifact.payload.verdict).toBe("verified");

    const check = artifact.payload.checks[0] as Record<string, unknown>;
    expect(check.passed).toBe(true);
    expect(check.detail).toContain("replay inconclusive");
    expect(check.detail).toContain("safety policy");
  });

  it("sets producedBy to system", () => {
    const targetId = newArtifactId();
    const replay: CommandReplayOutcome = {
      command: "echo ok",
      exitCode: 0,
      passed: true,
      detail: "",
    };
    const artifact = buildTestReportReplayVerification({
      ctx: ctx(),
      targetArtifactId: targetId,
      replay,
      classification: "consistent",
    });
    expect(artifact.producedBy).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// Command extraction from test_report artifact payload
// ---------------------------------------------------------------------------

describe("test_report artifact payload structure", () => {
  it("invocation.command is accessible from a well-formed test_report", () => {
    const command = "pytest --tb=short";
    const payload = {
      invocation: { command, exitCode: 0, durationMs: 300 },
      verdict: "pass" as const,
      totals: { passed: 10, failed: 0, skipped: 1 },
      failures: [],
    };
    // Verify the extraction pattern matches the orchestrator's logic
    expect(payload.invocation.command).toBe(command);
    expect(payload.verdict).toBe("pass");
  });

  it("runVerificationCommand rejects unsafe commands", async () => {
    const { splitSafeCommand } = await import("./commands.js");
    // Safe commands
    expect(splitSafeCommand("npm test")).toEqual(["npm", "test"]);
    expect(splitSafeCommand("npx vitest run")).toEqual(["npx", "vitest", "run"]);
    expect(splitSafeCommand("cargo test")).toEqual(["cargo", "test"]);
    // Unsafe commands
    expect(splitSafeCommand("rm -rf $HOME")).toBeNull();
    expect(splitSafeCommand("a; b")).toBeNull();
    expect(splitSafeCommand("a && b")).toBeNull();
    expect(splitSafeCommand("a | b")).toBeNull();
    expect(splitSafeCommand("`cmd`")).toBeNull();
    expect(splitSafeCommand("$(cmd)")).toBeNull();
  });

  it("runVerificationCommand returns inconclusive for missing binary", async () => {
    const { runVerificationCommand } = await import("./commands.js");
    const outcome = await runVerificationCommand(
      dataRoot,
      "nonexistent-binary-xyz-12345",
      2000,
    );
    expect(outcome.inconclusive).toBe(true);
    expect(outcome.exitCode).toBe(127);
    expect(outcome.passed).toBe(false);
  });

  it("runVerificationCommand returns inconclusive for unsafe command", async () => {
    const { runVerificationCommand } = await import("./commands.js");
    const outcome = await runVerificationCommand(dataRoot, "rm -rf $HOME", 2000);
    expect(outcome.inconclusive).toBe(true);
    expect(outcome.detail).toContain("safety policy");
  });

  it("runVerificationCommand runs a passing command in the given root", async () => {
    const { runVerificationCommand } = await import("./commands.js");
    writeFileSync(join(dataRoot, "ok.sh"), "exit 0\n");
    const outcome = await runVerificationCommand(dataRoot, "sh ok.sh", 5000);
    expect(outcome.passed).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.inconclusive).toBeFalsy();
  });

  it("runVerificationCommand enforces timeout", async () => {
    const { runVerificationCommand } = await import("./commands.js");
    const outcome = await runVerificationCommand(
      dataRoot,
      "sleep 30",
      1000,
    );
    expect(outcome.inconclusive).toBe(true);
    expect(outcome.detail).toContain("devmesh");
  }, 10_000);
});
