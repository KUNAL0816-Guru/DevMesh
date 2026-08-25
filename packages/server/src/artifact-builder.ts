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
