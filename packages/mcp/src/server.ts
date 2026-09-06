import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Storage } from "@devmesh/storage";
import type { AuthPrincipal } from "@devmesh/contracts";
import type { McpAuthorization, McpToolContext } from "./context.js";
import { executeTool, invalidRequest } from "./errors.js";
import { MCP_TOOLS, type McpToolDefinition } from "./tools/index.js";

export const MCP_SERVER_NAME = "devmesh-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

export interface DevMeshMcpServerOptions {
  storage: Storage;
  getPrincipal: () => AuthPrincipal | undefined;
  authorization: McpAuthorization;
  /** Override the advertised MCP implementation (name/version) in tests. */
  serverInfo?: { name: string; version: string };
}

function asToolCallback(
  fn: (...args: unknown[]) => Promise<CallToolResult> | CallToolResult,
): (...args: unknown[]) => Promise<CallToolResult> | CallToolResult {
  // The SDK's registerTool infers the handler argument shape from the input
  // schema (zero-arg tools get a bare callback, schema tools get (args, extra)).
  // A rest-param adapter is assignable to every one of those shapes, keeping
  // the per-tool registration free of SDK type plumbing.
  return fn;
}

async function handleToolCall(
  tool: McpToolDefinition,
  rawArgs: unknown,
  ctx: McpToolContext,
): Promise<CallToolResult> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  if (tool.schema) {
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
        .join("; ");
      return invalidRequest(`invalid arguments for ${tool.name}: ${detail}`);
    }
    return executeTool(tool.name, () => tool.execute(parsed.data as Record<string, unknown>, ctx));
  }
  return executeTool(tool.name, () => tool.execute(args, ctx));
}

/**
 * Build the Phase 14E read-only MCP server.
 *
 * The server advertises tools only — no resources, prompts, or subscriptions.
 * Authorization is injected (Phase 14B closures bound by the server package);
 * the MCP layer itself never authenticates. In unit/in-memory tests the caller
 * supplies authorizer stubs through `authorization`.
 */
export function createDevMeshMcpServer(opts: DevMeshMcpServerOptions): McpServer {
  const ctx: McpToolContext = {
    storage: opts.storage,
    getPrincipal: opts.getPrincipal,
    authorize: opts.authorization,
  };
  const server = new McpServer(
    { name: opts.serverInfo?.name ?? MCP_SERVER_NAME, version: opts.serverInfo?.version ?? MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema ?? undefined,
      },
      asToolCallback((...args) => handleToolCall(tool, args[0], ctx)),
    );
  }

  return server;
}

export { MCP_TOOLS } from "./tools/index.js";
export type { McpToolDefinition } from "./tools/index.js";
export type { McpAuthorization, McpToolContext, PrincipalProvider, ResolvedRun } from "./context.js";