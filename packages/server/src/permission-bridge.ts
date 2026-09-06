/**
 * Phase 14D: control-plane bridge for the OpenCode permission plugin.
 *
 * POST /permissions/tool — the plugin delegates every tool-call decision to
 * the DevMesh server. This is a pure policy QUERY bridge over the canonical
 * engine (decisionForTool, same instance the live serve broker uses). It never
 * minted an approval and never gates: enforcement happens either in the live
 * broker (approval flow) or in the plugin (deny for any non-allow outcome).
 *
 * Authorization is the per-project permission token:
 *   - `x-devmesh-project-token` must equal the project's stored pluginToken
 *     (constant-time compare). Missing/invalid/wrong-project tokens are a 401
 *     and are indistinguishable from one another (no info leakage). The token
 *     is bound to `projectId` in the body, so a token minted for one project
 *     can never authorize another project.
 *   - The route does NOT require the operator Bearer token (Phase 14A). The
 *     token isolation above is the plugin's trust boundary.
 *
 * Fail closed:
 *   - unknown tool name                 -> { decision: "deny" }
 *   - malformed body                    -> 400 (no partial evaluation)
 *   - resource absent from the profile  -> policy default (deny for anything
 *     but the default allow posture on read).
 * The plugin is still authoritative on write: any response whose decision is
 * not exactly "allow" is rejected by the plugin.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { toolPermissionRequestSchema } from "@devmesh/contracts";
import { permissionResourceForTool } from "@devmesh/opencode-adapter";
import type { Storage } from "@devmesh/storage";
import { secureCompare } from "./auth.js";
import { decisionForTool, type ProfileProvider } from "./policy.js";

/** Header the OpenCode plugin sends on every permission query. */
export const PLUGIN_TOKEN_HEADER = "x-devmesh-project-token";

export interface PermissionBridgeDeps {
  storage: Storage;
  /** Same canonical policy source the live serve broker uses. */
  policyBaselines: ProfileProvider;
}

export function registerPermissionToolRoute(
  app: FastifyInstance,
  deps: PermissionBridgeDeps,
): void {
  const { storage, policyBaselines } = deps;

  app.post(
    "/permissions/tool",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const header = request.headers[PLUGIN_TOKEN_HEADER];
      const supplied = typeof header === "string" ? header : "";
      if (supplied.length === 0) {
        return reply.status(401).send({
          error: {
            code: "plugin/auth-required",
            message: `missing ${PLUGIN_TOKEN_HEADER} header`,
          },
        });
      }

      const parsed = toolPermissionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: { code: "request/invalid", message: "malformed tool permission request" },
        });
      }
      const { projectId, role, tool, target } = parsed.data;

      // Token is bound to the project named in the body. Unknown project,
      // missing token on file, or wrong token all produce the same 401.
      const project = storage.projects.get(projectId);
      if (
        !project ||
        typeof project.pluginToken !== "string" ||
        project.pluginToken.length === 0 ||
        !secureCompare(supplied, project.pluginToken)
      ) {
        return reply.status(401).send({
          error: { code: "plugin/auth-invalid", message: "invalid project permission token" },
        });
      }

      // Unknown tool names fail closed: never treat an unmapped tool as allow.
      const resource = permissionResourceForTool(tool);
      if (resource === undefined) {
        return reply.send({
          decision: "deny",
          action: "deny",
          tool,
          reason: `unknown tool "${tool}" — default deny (fail closed)`,
        });
      }

      const disposal = decisionForTool({
        profile: policyBaselines(role),
        resource,
        target,
      });
      return reply.send({
        decision: disposal.action,
        action: disposal.action,
        resource,
        tool,
        reason: disposal.reason,
      });
    },
  );
}