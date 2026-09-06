import type { AuthPrincipal, ProjectId } from "@devmesh/contracts";
import type { PipelineRunRecord, Storage } from "@devmesh/storage";

/**
 * A pipeline run resolved against its authoritative project. The persisted
 * `run.projectId` is the single source of truth for authorization — never the
 * caller-supplied value.
 */
export interface ResolvedRun {
  run: PipelineRunRecord;
  projectId: ProjectId;
}

/**
 * Authorization contract injected by the server package. The MCP package never
 * performs authentication or authorization itself: it delegates to the Phase
 * 14B authorize functions wired by the composition root, which keeps the exact
 * 14A/14B semantics and prevents the MCP surface from re-implementing the
 * boundary.
 */
export interface McpAuthorization {
  /** Deny (throws `auth/forbidden`) or allow access to a project. */
  authorizeProject(principal: AuthPrincipal | undefined, projectId: ProjectId): void;
  /** Resolve a run and deny access to non-owners; null = not found. */
  authorizeRun(principal: AuthPrincipal | undefined, runId: string): ResolvedRun | null;
}

/** Supplies the authenticated principal for the current request (or undefined
 *  in single-user mode). Backed by AsyncLocalStorage at the HTTP layer. */
export type PrincipalProvider = () => AuthPrincipal | undefined;

export interface McpToolContext {
  storage: Storage;
  getPrincipal: PrincipalProvider;
  authorize: McpAuthorization;
}