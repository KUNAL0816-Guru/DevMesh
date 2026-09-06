import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDevMeshMcpServer } from "@devmesh/mcp";
import type { AuthPrincipal } from "@devmesh/contracts";
import type { Storage } from "@devmesh/storage";
import { authorizeProject, authorizeRun } from "./authorize.js";

/**
 * Phase 14E: expose the read-only MCP server over Streamable HTTP at POST /mcp.
 *
 * Stateless transport model (SDK 1.30): with `sessionIdGenerator: undefined`
 * every HTTP request MUST use a fresh transport and server instance — an SDK
 * constraint, not a choice. Each request therefore gets its own McpServer and
 * StreamableHTTPServerTransport; connect → handleRequest → close are scoped to
 * the request, so no locking or cross-request state is needed.
 *
 * The principal captured by Phase 14A (`request.auth`) is propagated to tool
 * handlers through AsyncLocalStorage; the MCP server reads it via
 * `getPrincipal`. Authorization uses the same Phase 14B authorize functions as
 * the REST layer — a tool call can never be judged by a different boundary.
 */

export interface RegisterMcpEndpointOptions {
  storage: Storage;
}

export function registerMcpEndpoint(app: FastifyInstance, opts: RegisterMcpEndpointOptions): void {
  const principalStore = new AsyncLocalStorage<{ principal: AuthPrincipal | undefined }>();

  app.post("/mcp", async (request, reply) => {
    reply.hijack();

    const server = createDevMeshMcpServer({
      storage: opts.storage,
      getPrincipal: () => principalStore.getStore()?.principal,
      authorization: {
        authorizeProject: (principal, projectId) =>
          authorizeProject(opts.storage, principal, projectId),
        authorizeRun: (principal, runId) => authorizeRun(opts.storage, principal, runId),
      },
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await principalStore.run({ principal: request.auth }, async () => {
        await server.connect(transport);
        try {
          await transport.handleRequest(request.raw, reply.raw, request.body);
        } finally {
          await server.close();
        }
      });
    } catch (err) {
      request.log.warn({ err }, "mcp request failed");
      try {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { "content-type": "application/json" });
        }
        if (!reply.raw.writableEnded) {
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "internal error" },
              id: null,
            }),
          );
        }
      } catch {
        // Response already gone — nothing to clean up.
      }
    }
  });
}