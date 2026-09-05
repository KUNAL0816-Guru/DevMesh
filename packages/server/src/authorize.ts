/**
 * Phase 14B: Centralized project-scoped authorization.
 *
 * Authorization boundary:
 *   AuthPrincipal + ProjectId → ALLOW / DENY (403)
 *
 * Authentication remains Phase 14A's responsibility (request.auth).
 * This module answers: "Is this authenticated principal allowed to access
 * this resource?"
 *
 * When authentication is disabled (single-user mode), no principal is present
 * on the request and all authorization checks are skipped — preserving
 * existing single-user development workflows.
 *
 * When authentication IS enabled, a principal must own (or in future, be a
 * member of) the target project. Otherwise the request is rejected with 403.
 *
 * IMPORTANT: This module does NOT perform authentication. It reads the
 * already-authenticated principal from request.auth (Phase 14A).
 */

import type { FastifyRequest } from "fastify";
import type { AuthPrincipal, ProjectId } from "@devmesh/contracts";
import type { Storage } from "@devmesh/storage";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when authorization fails (authenticated but not permitted).
 * The Fastify error handler translates this to HTTP 403.
 */
export class AuthorizationError extends Error {
  readonly code = "auth/forbidden" as const;
  constructor(message?: string) {
    super(message ?? "forbidden");
    this.name = "AuthorizationError";
  }
}

// ---------------------------------------------------------------------------
// Authorization checks
// ---------------------------------------------------------------------------

/**
 * Return the authenticated principal from the request, or undefined when
 * authentication is disabled (single-user mode).
 */
export function currentPrincipal(request: FastifyRequest): AuthPrincipal | undefined {
  return request.auth;
}

/**
 * Phase 14B: Authorize a principal against a project.
 *
 * Rules:
 *   - No principal (auth disabled / single-user mode) → ALLOW (skip check)
 *   - Principal matches project owner → ALLOW
 *   - Otherwise → throw AuthorizationError (→ 403)
 */
export function authorizeProject(
  storage: Storage,
  principal: AuthPrincipal | undefined,
  projectId: ProjectId,
): void {
  // Single-user mode (auth disabled): no authorization checks.
  if (!principal) return;

  const project = storage.projects.get(projectId);
  if (!project) return; // Let route handler handle 404 for missing project.

  // Owner check: principal must match the project owner.
  if (project.ownerPrincipalId === principal.id) return;

  // Not the owner → forbidden.
  throw new AuthorizationError(
    `principal "${principal.id}" is not authorized to access project "${projectId}"`,
  );
}

/**
 * Authorize a principal against a resource that belongs to a project.
 * If the resource is null (not found), return null without authorization error
 * (the route handler should return 404).
 */
export function authorizeResource<T extends { projectId: string }>(
  storage: Storage,
  principal: AuthPrincipal | undefined,
  resource: T | null,
): T | null {
  if (!resource) return null;
  if (!principal) return resource;
  authorizeProject(storage, principal, resource.projectId as ProjectId);
  return resource;
}

/**
 * Resolve a pipeline run and authorize the principal against its project.
 * Returns the run if authorized, null if not found, throws if unauthorized.
 */
export function authorizeRun(
  storage: Storage,
  principal: AuthPrincipal | undefined,
  runId: string,
): { run: NonNullable<ReturnType<Storage["pipelineRuns"]["get"]>>; projectId: ProjectId } | null {
  const run = storage.pipelineRuns.get(runId);
  if (!run) return null;
  authorizeProject(storage, principal, run.projectId as ProjectId);
  return { run, projectId: run.projectId as ProjectId };
}

/**
 * Resolve an execution and authorize the principal against its project.
 */
export function authorizeExecution(
  storage: Storage,
  principal: AuthPrincipal | undefined,
  executionId: string,
): NonNullable<ReturnType<Storage["executions"]["get"]>> | null {
  const exec = storage.executions.get(executionId);
  if (!exec) return null;
  authorizeProject(storage, principal, exec.projectId as ProjectId);
  return exec;
}

/**
 * Resolve an approval and authorize the principal against its project.
 */
export function authorizeApproval(
  storage: Storage,
  principal: AuthPrincipal | undefined,
  approvalId: string,
): NonNullable<ReturnType<Storage["approvals"]["get"]>> | null {
  const approval = storage.approvals.get(approvalId);
  if (!approval) return null;
  authorizeProject(storage, principal, approval.projectId as ProjectId);
  return approval;
}
