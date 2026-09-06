import { z } from "zod";
import { artifactKindSchema, runIdSchema, type Artifact } from "@devmesh/contracts";
import { McpToolError } from "../errors.js";
import type { McpToolDefinition } from "./definition.js";

export const MAX_PREVIEW_LENGTH = 200;

function truncate(s: string, max = MAX_PREVIEW_LENGTH): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Safe representation of an artifact: envelope metadata plus a bounded,
 * path-free preview. Raw payloads — file evidence (paths, hashes), command
 * evidence (commands, cwd), or any other internals — are deliberately never
 * surfaced over MCP.
 */
function artifactSummary(a: Artifact): Record<string, unknown> {
  let preview: string;
  switch (a.kind) {
    case "spec":
      preview = `title: ${a.payload.title}`;
      break;
    case "plan":
      preview = `tasks: ${a.payload.tasks.length}`;
      break;
    case "change_set":
      preview = `filesChanged: ${a.payload.filesChanged.length}, commits: ${a.payload.commits.length}, branch: ${a.payload.branch}`;
      break;
    case "test_report":
      preview = `verdict: ${a.payload.verdict}, totals: passed=${a.payload.totals.passed} failed=${a.payload.totals.failed} skipped=${a.payload.totals.skipped}`;
      break;
    case "review":
      preview = `verdict: ${a.payload.verdict}, findings: ${a.payload.findings.length}`;
      break;
    case "verification":
      preview = `verdict: ${a.payload.verdict}, checks: ${a.payload.checks.length}`;
      break;
  }
  return {
    id: a.id,
    kind: a.kind,
    projectId: a.projectId,
    runId: a.runId,
    taskId: a.taskId ?? null,
    producedBy: a.producedBy,
    createdAt: a.createdAt,
    preview: truncate(preview),
  };
}

export const listArtifactsTool: McpToolDefinition = {
  name: "list_artifacts",
  description:
    "List artifacts produced by a pipeline run. Returns artifact metadata and a bounded " +
    "preview; file paths, command evidence, and raw payloads are not exposed.",
  schema: z.strictObject({
    runId: runIdSchema,
    kind: artifactKindSchema.optional(),
  }),
  execute(args, ctx) {
    const runId = runIdSchema.parse(args.runId);
    const kind = args.kind === undefined ? undefined : artifactKindSchema.parse(args.kind);
    const resolved = ctx.authorize.authorizeRun(ctx.getPrincipal(), runId);
    if (!resolved) {
      throw new McpToolError("not-found", "pipeline/not-found", "not found: no such pipeline run");
    }
    const artifacts = ctx.storage.artifacts.listByRun(runId, kind as never);
    return { artifacts: artifacts.map(artifactSummary) };
  },
};