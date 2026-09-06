import type { McpToolDefinition } from "./definition.js";
import { listProjectsTool } from "./list-projects.js";
import { listPipelinesTool } from "./list-pipelines.js";
import { getPipelineTool } from "./get-pipeline.js";
import { listArtifactsTool } from "./list-artifacts.js";
import { getContextTool } from "./get-context.js";
import { listApprovalsTool } from "./list-approvals.js";
import { getRunUsageTool } from "./get-run-usage.js";

/**
 * The complete Phase 14E tool surface — strictly read-only. No mutation,
 * approval resolution, workspace, shell, or runtime tools are exposed.
 */
export const MCP_TOOLS: readonly McpToolDefinition[] = [
  listProjectsTool,
  listPipelinesTool,
  getPipelineTool,
  listArtifactsTool,
  getContextTool,
  listApprovalsTool,
  getRunUsageTool,
];

export type { McpToolDefinition } from "./definition.js";
export { MAX_PREVIEW_LENGTH } from "./list-artifacts.js";