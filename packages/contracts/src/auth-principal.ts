/**
 * Phase 14A: Authenticated principal — the result of successful authentication.
 *
 * This is an *identity-only* type: it answers "Who is calling?" and carries
 * no authorization data (no roles, permissions, or project memberships).
 * Those belong to Phase 14B+.
 */

export interface AuthPrincipal {
  /** Opaque identifier for the authenticated identity (e.g. "devmesh:default"). */
  readonly id: string;
  /** Authentication method that produced this principal. */
  readonly method: "bearer";
}
