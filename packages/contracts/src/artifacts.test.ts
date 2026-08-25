import { describe, expect, it } from "vitest";
import {
  artifactSchema,
  isArtifactKind,
  newArtifactBase,
  validatePlanIntegrity,
  type ArtifactInput,
  type PlanTask,
} from "./artifacts.js";
import {
  newArtifactId,
  newProjectId,
  newRunId,
  newTaskId,
} from "./ids.js";

const ctx = () => ({
  runId: newRunId(),
  projectId: newProjectId(),
  producedBy: "architect" as const,
});

const SHA = (c: string) => c.repeat(64);

describe("artifact envelope", () => {
  it("accepts a valid spec artifact and narrows with isArtifactKind", () => {
    const input = {
      kind: "spec" as const,
      ...newArtifactBase(ctx()),
      payload: {
        title: "Todo CLI",
        summary: "A small command line todo application",
        goals: ["add", "list", "complete todos"],
        nonGoals: ["multi-user"],
        constraints: [],
        techStack: [{ name: "node", rationale: "available locally" }],
        risks: [],
        openQuestions: [],
      },
    } satisfies ArtifactInput;

    const artifact = artifactSchema.parse(input);
    expect(isArtifactKind(artifact, "spec")).toBe(true);
    if (isArtifactKind(artifact, "spec")) {
      expect(artifact.payload.goals).toHaveLength(3);
    }
    expect(isArtifactKind(artifact, "review")).toBe(false);
  });

  it("rejects unknown kinds and bad schema versions", () => {
    const base = newArtifactBase(ctx());
    expect(
      artifactSchema.safeParse({ ...base, kind: "mystery", payload: {} }).success,
    ).toBe(false);
    expect(
      artifactSchema.safeParse({ ...base, kind: "spec", schemaVersion: 2, payload: {} })
        .success,
    ).toBe(false);
  });
});

describe("change_set artifacts", () => {
  const validChangeSet = () => ({
    kind: "change_set" as const,
    ...newArtifactBase({ ...ctx(), producedBy: "developer" as const }),
    payload: {
      branch: "devmesh/task-1",
      commits: [{ sha: "deadbeef123", message: "feat: add handler" }],
      filesChanged: [
        { path: "src/handler.ts", sha256: SHA("a"), sizeBytes: 120 },
      ],
      commandsRun: [
        { command: "npm test", exitCode: 0, durationMs: 1500 },
      ],
    },
  });

  it("accepts claims backed by file evidence", () => {
    expect(artifactSchema.safeParse(validChangeSet()).success).toBe(true);
  });

  it("rejects malformed hashes in file evidence", () => {
    const bad = validChangeSet();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bad.payload as any).filesChanged[0].sha256 = "NOTAHASH";
    expect(artifactSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects empty file lists (a change set must claim something)", () => {
    const bad = validChangeSet();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bad.payload as any).filesChanged = [];
    expect(artifactSchema.safeParse(bad).success).toBe(false);
  });
});

describe("test_report artifacts", () => {
  const report = (over: object) => ({
    kind: "test_report" as const,
    ...newArtifactBase({ ...ctx(), producedBy: "tester" as const }),
    payload: {
      invocation: { command: "npm test", exitCode: 0, durationMs: 900 },
      verdict: "pass" as const,
      totals: { passed: 5, failed: 0, skipped: 0 },
      failures: [],
      ...over,
    },
  });

  it("accepts pass and fail reports consistent with their totals", () => {
    expect(artifactSchema.safeParse(report({})).success).toBe(true);
    expect(
      artifactSchema.safeParse(
        report({
          verdict: "fail",
          totals: { passed: 4, failed: 1, skipped: 0 },
          failures: [{ name: "login > rejects bad password" }],
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects a failing report with no failures recorded", () => {
    expect(
      artifactSchema.safeParse(
        report({
          verdict: "fail",
          totals: { passed: 5, failed: 0, skipped: 0 },
          failures: [],
        }),
      ).success,
    ).toBe(false);
  });
});

describe("review artifacts", () => {
  const review = (verdict: "approved" | "changes_requested", findings: object[]) => ({
    kind: "review" as const,
    ...newArtifactBase({ ...ctx(), producedBy: "reviewer" as const }),
    payload: {
      subject: { changeSetId: newArtifactId() },
      verdict,
      findings,
      summary: "Looks fine",
    },
  });

  it("allows approved with no blocking findings", () => {
    expect(artifactSchema.safeParse(review("approved", [])).success).toBe(true);
  });

  it("rejects approved carrying critical findings", () => {
    expect(
      artifactSchema.safeParse(
        review("approved", [{ severity: "critical", message: "SQL injection" }]),
      ).success,
    ).toBe(false);
  });

  it("allows changes_requested with findings", () => {
    expect(
      artifactSchema.safeParse(
        review("changes_requested", [
          { severity: "major", message: "missing input validation", file: "src/a.ts", line: 12 },
        ]),
      ).success,
    ).toBe(true);
  });
});

describe("verification artifacts (system-produced)", () => {
  const verification = (
    checks: object[],
    verdict: "verified" | "rejected",
  ) => ({
    kind: "verification" as const,
    ...newArtifactBase({ ...ctx(), producedBy: "system" as const }),
    payload: { target: { artifactId: newArtifactId() }, checks, verdict },
  });

  it("accepts a verified record when all checks passed", () => {
    expect(
      artifactSchema.safeParse(
        verification(
          [
            {
              kind: "file_hash",
              path: "src/handler.ts",
              expectedSha256: SHA("b"),
              actualSha256: SHA("b"),
              passed: true,
            },
          ],
          "verified",
        ),
      ).success,
    ).toBe(true);
  });

  it("rejects verified records containing failed checks", () => {
    expect(
      artifactSchema.safeParse(
        verification(
          [
            {
              kind: "file_hash",
              path: "src/handler.ts",
              expectedSha256: SHA("b"),
              actualSha256: SHA("c"),
              passed: false,
            },
          ],
          "verified",
        ),
      ).success,
    ).toBe(false);
  });

  it("rejects rejected records where everything passed", () => {
    expect(
      artifactSchema.safeParse(
        verification([{ kind: "file_exists", path: "x.ts", passed: true }], "rejected"),
      ).success,
    ).toBe(false);
  });

  it("requires fields matching the check kind", () => {
    expect(
      artifactSchema.safeParse(
        verification([{ kind: "file_hash", path: "x.ts", passed: true }], "rejected"),
      ).success,
    ).toBe(false);
  });
});

describe("validatePlanIntegrity", () => {
  const planOf = (...tasks: PlanTask[]) =>
    ({
      kind: "plan" as const,
      ...newArtifactBase(ctx()),
      payload: { tasks },
    }) satisfies ArtifactInput;

  const task = (refKey: string, dependsOn: string[] = [], role = "developer" as const) => ({
    refKey,
    role,
    title: `Task ${refKey}`,
    detail: "do the thing",
    acceptanceCriteria: ["done"],
    dependsOn,
  });

  it("accepts a clean linear plan", () => {
    const parsed = artifactSchema.parse(planOf(task("T1"), task("T2", ["T1"])));
    if (!isArtifactKind(parsed, "plan")) throw new Error("expected plan");
    expect(validatePlanIntegrity(parsed.payload)).toEqual([]);
  });

  it("detects dangling dependencies", () => {
    const parsed = artifactSchema.parse(planOf(task("T1", ["T9"])));
    if (!isArtifactKind(parsed, "plan")) throw new Error("expected plan");
    expect(validatePlanIntegrity(parsed.payload)).toEqual([
      { taskRef: "T1", message: "depends on unknown refKey 'T9'" },
    ]);
  });

  it("detects duplicate ref keys", () => {
    const parsed = artifactSchema.parse(planOf(task("T1"), task("T1")));
    if (!isArtifactKind(parsed, "plan")) throw new Error("expected plan");
    expect(validatePlanIntegrity(parsed.payload).some((i) => i.message.includes("duplicate")))
      .toBe(true);
  });

  it("detects cycles", () => {
    const parsed = artifactSchema.parse(
      planOf(task("T1", ["T3"]), task("T2", ["T1"]), task("T3", ["T2"])),
    );
    if (!isArtifactKind(parsed, "plan")) throw new Error("expected plan");
    const issues = validatePlanIntegrity(parsed.payload);
    expect(issues.filter((i) => i.message.includes("cycle"))).toHaveLength(3);
    expect(issues.some((i) => i.message.includes("no entry task"))).toBe(true);
  });

  it("flags self-dependency without crashing cycle detection", () => {
    const parsed = artifactSchema.parse(planOf(task("T1", ["T1"])));
    if (!isArtifactKind(parsed, "plan")) throw new Error("expected plan");
    const issues = validatePlanIntegrity(parsed.payload);
    expect(issues.some((i) => i.message.includes("depends on itself"))).toBe(true);
  });

  it("round-trips through JSON unchanged", () => {
    const input = planOf(task("T1"), task("T2", ["T1"]));
    const artifact = artifactSchema.parse(input);
    const revived = artifactSchema.parse(JSON.parse(JSON.stringify(artifact)));
    expect(revived).toEqual(artifact);
  });

  it("supports optional taskId binding", () => {
    const input = {
      kind: "plan" as const,
      ...newArtifactBase({ ...ctx(), taskId: newTaskId() }),
      payload: { tasks: [task("T1")] },
    };
    const parsed = artifactSchema.parse(input);
    if (!isArtifactKind(parsed, "plan")) throw new Error("expected plan");
    expect(parsed.taskId).toBeDefined();
  });
});
