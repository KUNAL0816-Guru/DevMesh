import type { ExecutionStatus } from "@devmesh/runtime";

/**
 * Coarse, stable failure taxonomy for executions (Phase 3 req 16).
 * Persisted on the execution row and exposed via the API; intentionally
 * server-local (operational metadata, not cross-package wire law).
 */
export const failureKinds = [
  "provider_failure",
  "process_failure",
  "timeout",
  "cancelled",
  "invalid_output",
  "verification_failed",
  "task_failed",
  "internal",
] as const;
export type FailureKind = (typeof failureKinds)[number];

const PROVIDER_PATTERN =
  /network|econn(refused|reset|aborted)?|enotfound|etimedout|eai_again|rate.?limit|\b401\b|\b403\b|\b429\b|\b5[02][29]\b|api[_ ]?key|unauthorized|forbidden|provider|model .*(not found|unavailable)|credit|quota/i;

/**
 * Classify a terminal runtime result. `completed` returns null here —
 * verification/invalid-output classification happens in the service after
 * DevMesh inspects the workspace itself.
 */
export function classifyResult(result: {
  status: ExecutionStatus;
  failureReason?: string;
}): FailureKind | null {
  switch (result.status) {
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "failed": {
      const reason = result.failureReason ?? "";
      return PROVIDER_PATTERN.test(reason) ? "provider_failure" : "process_failure";
    }
    case "completed":
      return null;
  }
}

/** Classify a DevMesh-side error that prevented the run from starting. */
export function classifyStartError(err: unknown): FailureKind {
  const code = (err as { code?: string } | null)?.code ?? "";
  if (code === "runtime/not-configured" || code === "agent/not-executable") {
    return "task_failed";
  }
  if (code === "task/exhausted") return "task_failed";
  if (code === "workspace/locked") return "task_failed";
  if (code === "runtime/unavailable") return "process_failure";
  return "internal";
}
