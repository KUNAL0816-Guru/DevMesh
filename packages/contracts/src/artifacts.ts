import { z } from "zod";
import {
  commitShaSchema,
  isoTimestampSchema,
  relPathSchema,
  SCHEMA_VERSION,
  sha256HexSchema,
} from "./common.js";
import {
  artifactIdSchema,
  newArtifactId,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
} from "./ids.js";
import { agentRoleSchema } from "./roles.js";

/**
 * Artifacts are produced by agents or by DevMesh itself — never directly by
 * the user (user actions are approvals, not artifacts).
 */
export const artifactProducerSchema = z.union([
  agentRoleSchema,
  z.literal("system"),
]);
export type ArtifactProducer = z.infer<typeof artifactProducerSchema>;

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const artifactKinds = [
  "spec",
  "plan",
  "change_set",
  "test_report",
  "review",
  "verification",
] as const;
export const artifactKindSchema = z.enum(artifactKinds);
export type ArtifactKind = (typeof artifactKinds)[number];

// ---------------------------------------------------------------------------
// Evidence primitives — claims are only credible when backed by these.
// DevMesh independently verifies them (see verification.v1 below).
// ---------------------------------------------------------------------------

/** A file the agent claims exists with this exact content hash. */
export const fileEvidenceSchema = z.strictObject({
  path: relPathSchema,
  sha256: sha256HexSchema,
  sizeBytes: z.number().int().nonnegative(),
});
export type FileEvidence = z.infer<typeof fileEvidenceSchema>;

/** A command the agent claims it ran, with its observed outcome. */
export const commandEvidenceSchema = z.strictObject({
  command: z.string().min(1),
  cwd: relPathSchema.optional(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  /** sha-256 of the captured combined output (stored by DevMesh, not the agent). */
  outputDigest: sha256HexSchema.optional(),
});
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const specPayloadSchema = z.strictObject({
  title: z.string().min(3).max(120),
  summary: z.string().min(1).max(4000),
  goals: z.array(z.string().min(1)).min(1).max(30),
  nonGoals: z.array(z.string().min(1)).max(30),
  constraints: z.array(z.string().min(1)).max(30),
  techStack: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(80),
        rationale: z.string().max(500).optional(),
      }),
    )
    .max(30),
  risks: z
    .array(
      z.strictObject({
        description: z.string().min(1).max(1000),
        mitigation: z.string().max(1000).optional(),
      }),
    )
    .max(30),
  openQuestions: z.array(z.string().min(1)).max(30),
});
export type SpecPayload = z.infer<typeof specPayloadSchema>;

const planRefKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, "expected stable task ref key");

const planTaskSchema = z.strictObject({
  refKey: planRefKeySchema,
  role: agentRoleSchema,
  title: z.string().min(3).max(160),
  detail: z.string().min(1).max(4000),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).max(20),
  dependsOn: z.array(planRefKeySchema).max(20),
});
export type PlanTask = z.infer<typeof planTaskSchema>;

const planPayloadSchema = z.strictObject({
  tasks: z.array(planTaskSchema).min(1).max(100),
});
export type PlanPayload = z.infer<typeof planPayloadSchema>;

const changeSetPayloadSchema = z.strictObject({
  branch: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\s~^:?*[\\]+$/, "invalid git branch name"),
  baseBranch: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\s~^:?*[\\]+$/, "invalid git branch name")
    .optional(),
  commits: z
    .array(
      z.strictObject({
        sha: commitShaSchema,
        message: z.string().min(1).max(500),
      }),
    )
    .max(100),
  /** Claims about files touched; every entry is hash-verified by DevMesh. */
  filesChanged: z.array(fileEvidenceSchema).min(1).max(2000),
  commandsRun: z.array(commandEvidenceSchema).max(200),
  notes: z.string().max(4000).optional(),
});
export type ChangeSetPayload = z.infer<typeof changeSetPayloadSchema>;

const testReportPayloadSchema = z
  .strictObject({
    /** The canonical test invocation this report describes. */
    invocation: commandEvidenceSchema,
    framework: z.string().min(1).max(60).optional(),
    verdict: z.enum(["pass", "fail", "error"]),
    totals: z.strictObject({
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    }),
    failures: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(300),
          message: z.string().max(4000).optional(),
          evidence: commandEvidenceSchema.optional(),
        }),
      )
      .max(200),
  })
  .refine(
    (r) => !(r.verdict === "fail" && r.totals.failed === 0 && r.failures.length === 0),
    { message: "verdict 'fail' requires totals.failed > 0 or at least one failure" },
  );
export type TestReportPayload = z.infer<typeof testReportPayloadSchema>;

export const reviewSeverities = ["info", "minor", "major", "critical"] as const;
export const reviewSeveritySchema = z.enum(reviewSeverities);
export type ReviewSeverity = z.infer<typeof reviewSeveritySchema>;

const reviewFindingSchema = z.strictObject({
  severity: reviewSeveritySchema,
  file: relPathSchema.optional(),
  line: z.number().int().positive().optional(),
  message: z.string().min(1).max(2000),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

const reviewPayloadSchema = z
  .strictObject({
    subject: z.strictObject({
      changeSetId: artifactIdSchema,
      testReportId: artifactIdSchema.optional(),
    }),
    verdict: z.enum(["approved", "changes_requested"]),
    findings: z.array(reviewFindingSchema).max(500),
    summary: z.string().min(1).max(4000),
  })
  .refine(
    (r) =>
      !(
        r.verdict === "approved" &&
        r.findings.some((f) => f.severity === "major" || f.severity === "critical")
      ),
    { message: "verdict 'approved' cannot carry major or critical findings" },
  );
export type ReviewPayload = z.infer<typeof reviewPayloadSchema>;

// ---------------------------------------------------------------------------
// Verification records (produced by DevMesh itself, never by agents)
// ---------------------------------------------------------------------------

const verificationCheckSchema = z
  .strictObject({
    kind: z.enum(["file_hash", "file_exists", "command_replay", "custom"]),
    path: relPathSchema.optional(),
    expectedSha256: sha256HexSchema.optional(),
    actualSha256: sha256HexSchema.optional(),
    command: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    passed: z.boolean(),
    detail: z.string().max(2000).optional(),
  })
  .refine((c) => c.kind !== "file_hash" || (c.path !== undefined && c.expectedSha256 !== undefined && c.actualSha256 !== undefined), {
    message: "file_hash check requires path, expectedSha256 and actualSha256",
  })
  .refine((c) => c.kind !== "file_exists" || c.path !== undefined, {
    message: "file_exists check requires path",
  })
  .refine((c) => c.kind !== "command_replay" || c.command !== undefined, {
    message: "command_replay check requires command",
  });
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;

const verificationPayloadSchema = z
  .strictObject({
    target: z.strictObject({ artifactId: artifactIdSchema }),
    checks: z.array(verificationCheckSchema).min(1).max(500),
    verdict: z.enum(["verified", "rejected"]),
  })
  .refine(
    (v) => v.verdict !== "verified" || v.checks.every((c) => c.passed),
    { message: "verdict 'verified' requires every check to have passed" },
  )
  .refine(
    (v) => v.verdict !== "rejected" || v.checks.some((c) => !c.passed),
    { message: "verdict 'rejected' requires at least one failed check" },
  );
export type VerificationPayload = z.infer<typeof verificationPayloadSchema>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

const envelopeBase = {
  id: artifactIdSchema,
  schemaVersion: z.literal(SCHEMA_VERSION),
  runId: runIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema.optional(),
  producedBy: artifactProducerSchema,
  createdAt: isoTimestampSchema,
};

export const artifactSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...envelopeBase, kind: z.literal("spec"), payload: specPayloadSchema }),
  z.strictObject({ ...envelopeBase, kind: z.literal("plan"), payload: planPayloadSchema }),
  z.strictObject({ ...envelopeBase, kind: z.literal("change_set"), payload: changeSetPayloadSchema }),
  z.strictObject({ ...envelopeBase, kind: z.literal("test_report"), payload: testReportPayloadSchema }),
  z.strictObject({ ...envelopeBase, kind: z.literal("review"), payload: reviewPayloadSchema }),
  z.strictObject({ ...envelopeBase, kind: z.literal("verification"), payload: verificationPayloadSchema }),
]);
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactInput = z.input<typeof artifactSchema>;

export function isArtifactKind<K extends ArtifactKind>(
  a: Artifact,
  kind: K,
): a is Extract<Artifact, { kind: K }> {
  return a.kind === kind;
}

/** Common fields shared by all artifacts of a run. */
export interface ArtifactContext {
  runId: ReturnType<typeof runIdSchema.parse>;
  projectId: ReturnType<typeof projectIdSchema.parse>;
  taskId?: ReturnType<typeof taskIdSchema.parse>;
  producedBy: ArtifactProducer;
}

export function newArtifactBase(ctx: ArtifactContext): {
  id: ReturnType<typeof artifactIdSchema.parse>;
  schemaVersion: typeof SCHEMA_VERSION;
  createdAt: string;
} & ArtifactContext {
  return {
    id: newArtifactId(),
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    ...ctx,
  };
}

// ---------------------------------------------------------------------------
// Plan graph integrity (referential + acyclicity checks)
// ---------------------------------------------------------------------------

export interface PlanIssue {
  taskRef: string | null;
  message: string;
}

/**
 * Validates a plan payload beyond schema level:
 * unique ref keys, no dangling/self dependencies, no dependency cycles,
 * at least one entry task.
 */
export function validatePlanIntegrity(payload: PlanPayload): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const seen = new Map<string, PlanTask>();
  for (const t of payload.tasks) {
    if (seen.has(t.refKey)) {
      issues.push({ taskRef: t.refKey, message: `duplicate refKey '${t.refKey}'` });
    }
    seen.set(t.refKey, t);
  }

  const deps = new Map<string, string[]>();
  for (const t of payload.tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.refKey) {
        issues.push({ taskRef: t.refKey, message: `task depends on itself` });
      } else if (!seen.has(dep)) {
        issues.push({
          taskRef: t.refKey,
          message: `depends on unknown refKey '${dep}'`,
        });
      }
    }
    deps.set(t.refKey, t.dependsOn.filter((d) => d !== t.refKey));
  }

  // Iterative DFS cycle detection over valid nodes only.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const key of deps.keys()) color.set(key, WHITE);
  const cyclic = new Set<string>();
  for (const start of deps.keys()) {
    if (color.get(start) !== WHITE) continue;
    const stack: Array<{ node: string; iter: Iterator<string> }> = [];
    const push = (node: string) => {
      color.set(node, GRAY);
      stack.push({ node, iter: (deps.get(node) ?? [])[Symbol.iterator]() });
    };
    push(start);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const next = top.iter.next();
      if (next.done) {
        color.set(top.node, BLACK);
        stack.pop();
        continue;
      }
      const dep = next.value;
      if (!deps.has(dep)) continue;
      const state = color.get(dep);
      if (state === GRAY) {
        // Back edge: every frame from `dep` down to the top of the stack
        // participates in this cycle.
        const idx = stack.findIndex((f) => f.node === dep);
        if (idx >= 0) {
          for (let i = idx; i < stack.length; i++) {
            const node = stack[i]?.node;
            if (node !== undefined) cyclic.add(node);
          }
        }
      } else if (state === WHITE) {
        push(dep);
      }
    }
  }
  for (const key of cyclic) {
    issues.push({ taskRef: key, message: `'${key}' participates in a dependency cycle` });
  }

  const dependedOn = new Set(payload.tasks.flatMap((t) => t.dependsOn));
  const hasEntry = payload.tasks.some((t) => !dependedOn.has(t.refKey));
  if (!hasEntry) {
    issues.push({
      taskRef: null,
      message: "plan has no entry task (every task has incoming dependencies)",
    });
  }

  return issues;
}
