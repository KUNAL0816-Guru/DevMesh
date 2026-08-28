/**
 * Artifact builders for agent-produced structured artifacts.
 *
 * Each agent produces a text reply. These builders parse the reply into
 * the closest valid structured artifact schema (spec, plan, test_report,
 * review). They are designed to be resilient: if parsing fails, they
 * return a minimal valid artifact with the full text as summary/detail.
 */
import {
  artifactSchema,
  newArtifactId,
  type Artifact,
  type ProjectId,
  type RunId,
  type TaskId,
  type AgentRole,
  type ArtifactId,
} from "@devmesh/contracts";

interface ArtifactCtx {
  runId: RunId;
  projectId: ProjectId;
  taskId: TaskId;
  producedBy: AgentRole;
}

// ---------------------------------------------------------------------------
// outputFormat JSON Schemas
// ---------------------------------------------------------------------------
//
// These are sent to the agent (via AgentExecutionRequest.outputFormat.schema)
// to shape its structured output. They describe the expected payload shape;
// DevMesh validates the produced payload against the authoritative Zod
// artifact schemas before accepting it.

const specOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    goals: { type: "array", items: { type: "string" } },
    nonGoals: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    techStack: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, rationale: { type: "string" } },
        required: ["name"],
      },
    },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { description: { type: "string" }, mitigation: { type: "string" } },
        required: ["description"],
      },
    },
    openQuestions: { type: "array", items: { type: "string" } },
  },
  required: ["title", "summary", "goals"],
};

const planOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          refKey: { type: "string" },
          role: { type: "string", enum: ["architect", "developer", "tester", "reviewer"] },
          title: { type: "string" },
          detail: { type: "string" },
          acceptanceCriteria: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
        },
        required: ["refKey", "role", "title", "detail", "acceptanceCriteria"],
      },
    },
  },
  required: ["tasks"],
};

const testReportOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    invocation: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        exitCode: { type: "integer" },
        durationMs: { type: "integer" },
        outputDigest: { type: "string" },
      },
      required: ["command", "exitCode", "durationMs"],
    },
    framework: { type: "string" },
    verdict: { type: "string", enum: ["pass", "fail", "error"] },
    totals: {
      type: "object",
      additionalProperties: false,
      properties: {
        passed: { type: "integer" },
        failed: { type: "integer" },
        skipped: { type: "integer" },
      },
      required: ["passed", "failed", "skipped"],
    },
    failures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          message: { type: "string" },
        },
        required: ["name"],
      },
    },
  },
  required: ["invocation", "verdict", "totals"],
};

const reviewOutputSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: {
      type: "object",
      additionalProperties: false,
      properties: {
        changeSetId: { type: "string" },
        testReportId: { type: "string" },
      },
      required: ["changeSetId"],
    },
    verdict: { type: "string", enum: ["approved", "changes_requested"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["info", "minor", "major", "critical"] },
          file: { type: "string" },
          line: { type: "integer" },
          message: { type: "string" },
        },
        required: ["severity", "message"],
      },
    },
    summary: { type: "string" },
  },
  required: ["subject", "verdict", "findings", "summary"],
};

/**
 * Per-role outputFormat schema. The architect emits a container holding both
 * the spec and the plan payloads; the tester and reviewer emit their single
 * artifact payload. These are passed to AgentExecutionRequest.outputFormat.
 */
export const ARTIFACT_OUTPUT_FORMATS: Record<
  "architect" | "tester" | "reviewer",
  { name: string; schema: Record<string, unknown> }
> = {
  architect: {
    name: "architecture-plan",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        spec: specOutputSchema,
        plan: planOutputSchema,
      },
      required: ["spec", "plan"],
    },
  },
  tester: { name: "test-report", schema: testReportOutputSchema },
  reviewer: { name: "review", schema: reviewOutputSchema },
};

// ---------------------------------------------------------------------------
// Structured-payload builders
// ---------------------------------------------------------------------------
//
// Build a full artifact envelope from a validated structured payload. These
// throw ZodError when the payload does not match the artifact schema; callers
// catch and fall back to text parsing.

function envelope(actx: ArtifactCtx) {
  return {
    id: newArtifactId(),
    schemaVersion: 1,
    runId: actx.runId,
    projectId: actx.projectId,
    taskId: actx.taskId,
    producedBy: actx.producedBy,
    createdAt: new Date().toISOString(),
  };
}

export function buildSpecArtifactFromPayload(payload: unknown, actx: ArtifactCtx): Artifact {
  return artifactSchema.parse({ ...envelope(actx), kind: "spec", payload });
}

export function buildPlanArtifactFromPayload(payload: unknown, actx: ArtifactCtx): Artifact {
  return artifactSchema.parse({ ...envelope(actx), kind: "plan", payload });
}

export function buildTestReportArtifactFromPayload(
  payload: unknown,
  actx: ArtifactCtx,
): Artifact {
  return artifactSchema.parse({ ...envelope(actx), kind: "test_report", payload });
}

export function buildReviewArtifactFromPayload(payload: unknown, actx: ArtifactCtx): Artifact {
  return artifactSchema.parse({ ...envelope(actx), kind: "review", payload });
}

function extractSection(text: string, heading: string): string {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:#{1,4}|\\*\\*?)\\s*${escapeRegex(heading)}\\s*(?:\\*\\*)?\\s*\\n([\\s\\S]*?)(?=\\n\\s*(?:#{1,4}|\\*\\*?)|$)`,
    "i",
  );
  const m = text.match(re);
  return m?.[1]?.trim() ?? "";
}

function extractBulletList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((l) => l.length > 0 && l.length <= 4000);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// ---------------------------------------------------------------------------
// spec.v1
// ---------------------------------------------------------------------------

export function buildSpecArtifact(
  replyText: string,
  ctx: ArtifactCtx,
): Artifact {
  const title = clamp(
    extractSection(replyText, "Spec")?.split("\n")[0] ||
      extractSection(replyText, "Title") ||
      ctx.runId.slice(0, 8),
    120,
  );

  const summary = clamp(replyText.slice(0, 4000), 4000);

  const goals = extractBulletList(
    extractSection(replyText, "Goals?") || extractSection(replyText, "Objective"),
  );
  if (goals.length === 0) goals.push(clamp(replyText.slice(0, 200), 200));

  const nonGoals = extractBulletList(extractSection(replyText, "Non-Goals?"));
  const constraints = extractBulletList(extractSection(replyText, "Constraints?"));

  const risksBlock = extractSection(replyText, "Risks?");
  const risks = extractBulletList(risksBlock).map((d) => ({
    description: clamp(d, 1000),
  }));

  const openQuestions = extractBulletList(
    extractSection(replyText, "Open Questions?") ||
      extractSection(replyText, "Unknowns?"),
  );

  return artifactSchema.parse({
    id: newArtifactId(),
    schemaVersion: 1,
    runId: ctx.runId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    producedBy: ctx.producedBy,
    createdAt: new Date().toISOString(),
    kind: "spec",
    payload: {
      title,
      summary,
      goals,
      nonGoals,
      constraints,
      techStack: [],
      risks,
      openQuestions,
    },
  });
}

// ---------------------------------------------------------------------------
// plan.v1
// ---------------------------------------------------------------------------

export function buildPlanArtifact(
  replyText: string,
  ctx: ArtifactCtx,
): Artifact {
  const planBlock =
    extractSection(replyText, "Plan") ||
    extractSection(replyText, "Implementation Plan") ||
    replyText;

  // Try to extract numbered items
  const numberedItems = planBlock
    .split("\n")
    .filter((l) => /^\s*\d+[\.\)]\s+/.test(l))
    .map((l) => l.replace(/^\s*\d+[\.\)]\s+/, "").trim());

  const tasks = numberedItems.length > 0
    ? numberedItems.map((item, i) => ({
        refKey: `task-${i + 1}`,
        role: (ctx.producedBy === "architect" ? "developer" : ctx.producedBy) as AgentRole,
        title: clamp(item.split(":")[0] || item.slice(0, 80), 160),
        detail: clamp(item, 4000),
        acceptanceCriteria: ["Implementation complete"],
        dependsOn: i > 0 ? [`task-${i}`] : [],
      }))
    : [
        {
          refKey: "main",
          role: "developer" as AgentRole,
          title: "Implementation",
          detail: clamp(planBlock.slice(0, 4000), 4000),
          acceptanceCriteria: ["See task detail"],
          dependsOn: [],
        },
      ];

  return artifactSchema.parse({
    id: newArtifactId(),
    schemaVersion: 1,
    runId: ctx.runId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    producedBy: ctx.producedBy,
    createdAt: new Date().toISOString(),
    kind: "plan",
    payload: { tasks },
  });
}

// ---------------------------------------------------------------------------
// test_report.v1
// ---------------------------------------------------------------------------

export function buildTestReportArtifact(
  replyText: string,
  ctx: ArtifactCtx,
): Artifact {
  const lower = replyText.toLowerCase();
  const verdict: "pass" | "fail" | "error" =
    /\bfail(?:ed|s)?\b/.test(lower)
      ? "fail"
      : /\berror\b/.test(lower)
        ? "error"
        : "pass";

  // Extract pass/fail counts if present
  const passedMatch = replyText.match(/(\d+)\s*passed/i);
  const failedMatch = replyText.match(/(\d+)\s*failed/i);
  const skippedMatch = replyText.match(/(\d+)\s*skipped/i);

  const passed = passedMatch ? Number(passedMatch[1]) : verdict === "pass" ? 1 : 0;
  const failed = failedMatch ? Number(failedMatch[1]) : verdict === "fail" ? 1 : 0;
  const skipped = skippedMatch ? Number(skippedMatch[1]) : 0;

  // Extract failure names
  const failures: Array<{ name: string; message?: string }> = [];
  if (verdict === "fail") {
    const failLines = replyText.split("\n").filter((l) => /fail|error|assert/i.test(l));
    for (const line of failLines.slice(0, 10)) {
      failures.push({ name: clamp(line.trim(), 300) });
    }
    if (failures.length === 0) {
      failures.push({ name: "test failure detected in output" });
    }
  }

  // Try to find test command
  const cmdMatch =
    replyText.match(/(?:ran|executed|command[:\s]+)\s*`([^`]+)`/i) ||
    replyText.match(/(?:node|npm|npx|yarn|vitest|jest|mocha)\s+[^\n]+/i);

  return artifactSchema.parse({
    id: newArtifactId(),
    schemaVersion: 1,
    runId: ctx.runId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    producedBy: ctx.producedBy,
    createdAt: new Date().toISOString(),
    kind: "test_report",
    payload: {
      invocation: {
        command: cmdMatch ? clamp(cmdMatch[0].trim(), 500) : "test",
        exitCode: verdict === "pass" ? 0 : 1,
        durationMs: 0,
      },
      verdict,
      totals: { passed, failed, skipped },
      failures,
    },
  });
}

// ---------------------------------------------------------------------------
// review.v1
// ---------------------------------------------------------------------------

export function buildReviewArtifact(
  replyText: string,
  changeSetId: ArtifactId,
  testReportId: ArtifactId | undefined,
  ctx: ArtifactCtx,
): Artifact {
  const lower = replyText.toLowerCase();
  const verdict: "approved" | "changes_requested" =
    /\bapproved\b|\bLGTM\b|\blooks good\b/.test(lower) &&
    !/\bchanges?\s*requested\b|\brejected\b|\bfix\b/i.test(lower)
      ? "approved"
      : "changes_requested";

  // Extract findings
  const findings: Array<{
    severity: "info" | "minor" | "major" | "critical";
    message: string;
  }> = [];
  const findingLines = replyText
    .split("\n")
    .filter((l) => /\b(minor|major|critical|info|warning|issue|bug)\b/i.test(l));
  for (const line of findingLines.slice(0, 10)) {
    const sev = /critical/i.test(line)
      ? "critical"
      : /major|bug|error/i.test(line)
        ? "major"
        : /minor|warning/i.test(line)
          ? "minor"
          : "info";
    findings.push({ severity: sev as "info" | "minor" | "major" | "critical", message: clamp(line.trim(), 2000) });
  }

  // If verdict is approved, strip major/critical findings
  const safeFindings =
    verdict === "approved"
      ? findings.filter((f) => f.severity !== "major" && f.severity !== "critical")
      : findings;

  return artifactSchema.parse({
    id: newArtifactId(),
    schemaVersion: 1,
    runId: ctx.runId,
    projectId: ctx.projectId,
    taskId: ctx.taskId,
    producedBy: ctx.producedBy,
    createdAt: new Date().toISOString(),
    kind: "review",
    payload: {
      subject: {
        changeSetId,
        ...(testReportId ? { testReportId } : {}),
      },
      verdict,
      findings: safeFindings,
      summary: clamp(replyText.slice(0, 4000), 4000),
    },
  });
}
