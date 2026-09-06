import {
  baselineProfile,
  makeDenyByDefaultProfile,
  permissionResources,
  type AgentRole,
  type PermissionAction,
  type PermissionProfile,
  type PermissionResource,
  type PolicyDecision,
} from "@devmesh/contracts";

/**
 * Phase 14C permission policy. Pure, deterministic, zero-dependency: the only
 * inputs are the role profile and a target string, so the same code path can
 * evaluate at the execution level (run disposition) and later at the tool
 * level (Phase 14D). Never touches storage or the runtime.
 */

/** A source of permission profiles for an agent role. */
export type ProfileProvider = (role: AgentRole) => PermissionProfile;

/** The canonical provider: manifests are the single source for baseline policy. */
export const DEFAULT_PROFILE_PROVIDER: ProfileProvider = baselineProfile;

/**
 * The canonical deny-by-default POSTURE. Only the `read` posture is
 * represented ("allow": the workspace is inspectable); non-read resources have
 * NO posture entry, so an authored non-read "deny" can never collide with a
 * derived default. A profile entry that equals this posture (currently only
 * `read: "allow"`) is treated as DERIVED (the "no explicit rule" state) at run
 * level.
 */
const POSTURE = makeDenyByDefaultProfile();

/** Coarse operation -> permission resource mapping (Phase 3 tags). */
export const OPERATION_TO_RESOURCE: Record<string, PermissionResource> = {
  read_files: "read",
  write_files: "edit",
  run_commands: "bash",
  git_operations: "bash",
};

/**
 * Map an agent's declared operation (from `allowedOperationsSchema`) to the
 * permission resource it touches. Unknown operations map to nothing — they are
 * outside the Phase 14C resource model and invisible to policy enforcement.
 */
export function resourceForOperation(operation: string): PermissionResource | undefined {
  return OPERATION_TO_RESOURCE[operation];
}

/** The run-level decision the policy makes for a whole execution. */
export type RunDecision = "allow" | "ask" | "deny";

/** A typed policy failure surfaced to the HTTP layer and the orchestrator. */
export class PermissionError extends Error {
  readonly code: "permission/denied" | "approval/denied" | "permission/cancelled";

  constructor(
    code: "permission/denied" | "approval/denied" | "permission/cancelled",
    message: string,
  ) {
    super(message);
    this.name = "PermissionError";
    this.code = code;
  }
}

/**
 * Translate a glob pattern into an anchored regular expression. Supports `**`
 * (deep match across path separators), `*` and `?` (single-segment wildcards),
 * and treats every other character literally. The result is anchored so it
 * matches the ENTIRE target, not a substring.
 */
export function matchesGlob(target: string, pattern: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i++;
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (ch === "\\") {
      regex += "\\\\";
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regex += "$";
  try {
    return new RegExp(regex).test(target);
  } catch {
    return false;
  }
}

export interface SettingContribution {
  resource: PermissionResource;
  action: PermissionAction;
  /** How the disposition was derived (explicit action, rule, or default). */
  reason: string;
}

/** True when the setting equals the canonical default posture for its resource. */
function equalsPosture(resource: PermissionResource, setting: unknown): boolean {
  return setting === POSTURE[resource];
}

/**
 * Per-resource run-level disposition of a profile.
 *
 * - Absent setting: default posture — `read` allows inspecting the workspace,
 *   every other resource is non-blocking at run level (its posture is enforced
 *   at the future per-tool layer, Phase 14D).
 * - Setting equal to the canonical posture (`read: "allow"` only): treated as
 *   absence. Non-read resources have NO posture entry, so any value present on
 *   them was authored — including a real, blocking "deny".
 * - Shorthand action ("allow"/"ask"/"deny") DIFFERING from the posture: applies
 *   as-is — this is an authored policy position.
 * - Rule WITHOUT patterns: applies as-is — an authored policy position.
 * - Rule WITH patterns: TARGET-scoped only; produces no run-level disposition
 *   and cannot block or gate a run by itself.
 */
export function evaluateSetting(
  resource: PermissionResource,
  profile: PermissionProfile,
): PermissionAction | undefined {
  const setting = profile[resource];
  if (setting === undefined) {
    return resource === "read" ? "allow" : undefined;
  }
  if (typeof setting === "string") {
    return equalsPosture(resource, setting) ? undefined : setting;
  }
  if (setting.patterns && setting.patterns.length > 0) return undefined;
  return setting.action;
}

/** Human-readable origin of a disposition, for reporting and approvals. */
function describeContribution(
  resource: PermissionResource,
  profile: PermissionProfile,
): string {
  const setting = profile[resource];
  if (setting === undefined) return "resource default posture";
  if (typeof setting === "string") return "explicit profile action";
  return "unpatterned rule action";
}

/**
 * Compute the run-level decision for a role's profile. This is the ONLY place
 * a run is gated (`deny`) or held (`ask`) by policy. One authored deny on any
 * resource denies the whole run; otherwise one or more authored asks gate the
 * run; otherwise the run is allowed.
 */
export function runDisposition(profile: PermissionProfile): {
  decision: RunDecision;
  contributes: SettingContribution[];
} {
  const contributes: SettingContribution[] = [];
  for (const resource of permissionResources) {
    const action = evaluateSetting(resource, profile);
    if (action === undefined) continue;
    contributes.push({
      resource,
      action,
      reason: describeContribution(resource, profile),
    });
  }
  const blocking = contributes.filter((c) => c.action === "deny");
  if (blocking.length > 0) {
    return { decision: "deny", contributes };
  }
  const asks = contributes.filter((c) => c.action === "ask");
  if (asks.length > 0) {
    return { decision: "ask", contributes };
  }
  return { decision: "allow", contributes };
}

export interface ExecutionPermissionInput {
  role: AgentRole;
  /** Role's declared operations (Phase 3 tags); used for reporting only. */
  allowedOperations?: readonly string[];
  profile: PermissionProfile;
}

export interface ExecutionPermissionResult {
  decision: RunDecision;
  /** Wire-validated decisions for every contributing resource. */
  reasons: PolicyDecision[];
  /** Human-readable summary for error messages and approval detail. */
  summary: string;
}

/**
 * Decide whether an execution may start. Aggregates per-resource dispositions
 * into one run-level decision and produces the canonical decisions that flow
 * into `permission.requested`/`permission.resolved` events.
 * `allowedOperations` is descriptive metadata for the report; it never changes
 * the decision.
 */
export function decisionForExecution(
  input: ExecutionPermissionInput,
): ExecutionPermissionResult {
  const { decision, contributes } = runDisposition(input.profile);
  const reasons: PolicyDecision[] = contributes.map((c) => ({
    action: c.action,
    resource: c.resource,
    reason: `${input.role} ${c.resource}=${c.action} (${c.reason})`,
  }));
  const summary =
    reasons.length === 0
      ? `allow (no authored policy entries for ${input.role} beyond defaults)`
      : `${decision} from role policy: ${reasons.map((r) => `${r.resource}=${r.action}`).join(", ")}`;
  return { decision, reasons, summary };
}

/**
 * The single rule governing runtime auto-approval: only an ALLOW decision may
 * pass blanket auto-approval (`--auto`) to a runtime. ASK runs never carry it
 * (a human approval does not convert to tool-level trust), and DENY never
 * starts.
 */
export function effectiveAutoApprove(
  configAutoApprove: boolean,
  decision: RunDecision,
): boolean {
  return decision === "allow" && configAutoApprove;
}

/**
 * Phase 14D: per-tool disposal of a single tool-call request.
 *
 * Read this as the run-level disposition projected onto ONE tool invocation:
 * - No setting for the resource: `read` keeps its inspect posture (allow);
 *   every other resource FAILS CLOSED (deny) — absent policy never means allow
 *   for a mutating/network tool.
 * - Shorthand action equal to the default posture (`read: "allow"`): allow.
 * - Shorthand action otherwise: authored as-is (allow/ask/deny).
 * - Unpatterned rule: authored as-is.
 * - Patterned rule: applies ONLY when the tool's target matches a pattern;
 *   unmatched targets fall back to the resource posture (allow for read, deny
 *   for everything else — a scoped rule never widens a non-read tool).
 * An authored `deny` always lands as deny; nothing below overrules it.
 */
export function decisionForTool(input: {
  profile: PermissionProfile;
  resource: PermissionResource;
  target?: string;
}): { action: PermissionAction; reason: string } {
  const { profile, resource, target } = input;
  const setting = profile[resource];
  if (setting === undefined) {
    return resource === "read"
      ? { action: "allow", reason: "read has no authored policy — default posture allows inspection" }
      : {
          action: "deny",
          reason: `${resource} has no authored policy — default deny (fail closed)`,
        };
  }
  if (typeof setting === "string") {
    if (equalsPosture(resource, setting)) {
      return { action: "allow", reason: `${resource}=${setting} equals the default posture` };
    }
    return { action: setting, reason: `explicit profile action ${resource}=${setting}` };
  }
  if (setting.patterns && setting.patterns.length > 0) {
    if (target !== undefined && setting.patterns.some((p) => matchesGlob(target, p))) {
      return { action: setting.action, reason: `rule ${resource} matches target "${target}"` };
    }
    return resource === "read"
      ? { action: "allow", reason: `read rule matches nothing for "${target ?? ""}" — posture allows` }
      : {
          action: "deny",
          reason: `rule for ${resource} matches nothing for "${target ?? ""}" — default deny`,
        };
  }
  return { action: setting.action, reason: `unpatterned rule for ${resource}` };
}