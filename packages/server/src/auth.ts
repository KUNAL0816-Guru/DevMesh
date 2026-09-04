/**
 * Phase 14A: Centralized Bearer authentication hook.
 *
 * When auth is enabled (bearerToken is configured), every API request must
 * carry a valid `Authorization: Bearer <token>` header. Static assets,
 * the `/health` endpoint, and SPA fallback routes remain unauthenticated.
 *
 * The authentication boundary uses an API-path allowlist. Only routes under
 * known API prefixes require authentication; all other paths (static files,
 * SPA frontend routes, unknown paths) are passed through unauthenticated.
 *
 * On success the authenticated principal is placed on `request.auth` for
 * downstream authorization (Phase 14B+).
 *
 * Security properties:
 *   - Constant-time token comparison (crypto.timingSafeEqual)
 *   - Authorization headers are never logged
 *   - No credential leakage in error responses
 *   - Malformed/missing tokens → 401 (not 403)
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AuthPrincipal } from "@devmesh/contracts";
import type { AuthConfig } from "./config.js";

// Augment FastifyRequest so route handlers can access `request.auth`.
declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthPrincipal;
  }
}

/** Constant-time string comparison to prevent timing attacks. */
function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Pad the shorter buffer so timingSafeEqual doesn't throw.
    const maxLen = Math.max(bufA.length, bufB.length);
    const paddedA = Buffer.alloc(maxLen, 0);
    const paddedB = Buffer.alloc(maxLen, 0);
    bufA.copy(paddedA);
    bufB.copy(paddedB);
    timingSafeEqual(paddedA, paddedB); // always false here, but constant-time
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * API path prefixes that require authentication when auth is enabled.
 * All other paths (/, /assets/*, SPA fallback, unknown routes) are
 * unauthenticated — preserving the existing single-user dev workflow.
 */
const API_PREFIXES = ["/health", "/projects", "/pipelines", "/executions", "/approvals", "/auth"];

/**
 * Returns true when the path matches an API prefix and should be authenticated.
 * `/health` is in the list for discoverability but explicitly skipped in the
 * hook itself (operational probe must remain unauthenticated).
 */
function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Register the Phase 14A authentication hook on the Fastify instance.
 *
 * Only API paths (see API_PREFIXES) are authenticated. Static files, SPA
 * fallback, and health probes remain unauthenticated.
 * When auth is disabled (no bearerToken configured), no hook is registered
 * and the existing single-user workflow is preserved unchanged.
 */
export function registerAuth(
  app: FastifyInstance,
  authConfig: AuthConfig | null,
): void {
  if (!authConfig) return;

  app.addHook("onRequest", async function authHook(
    this: FastifyInstance,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const path = request.url.split("?")[0] ?? "";

    // Only authenticate known API paths. Everything else (/, /assets/*, SPA
    // routes, unknown paths) passes through unauthenticated.
    if (!isApiPath(path)) return;

    // /health — unauthenticated for operational probes.
    if (path === "/health") return;

    const authHeader = request.headers.authorization;

    if (!authHeader) {
      reply.code(401).send({
        error: { code: "auth/unauthenticated", message: "missing credentials" },
      });
      return;
    }

    // Require "Bearer <token>" format.
    const match = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      reply.code(401).send({
        error: { code: "auth/unauthenticated", message: "invalid credentials" },
      });
      return;
    }

    const suppliedToken = match[1]!;
    if (!secureCompare(suppliedToken, authConfig.bearerToken)) {
      reply.code(401).send({
        error: { code: "auth/unauthenticated", message: "invalid credentials" },
      });
      return;
    }

    // Authentication succeeded — attach principal for downstream authorization.
    request.auth = {
      id: "devmesh:default",
      method: "bearer",
    };
  });
}
