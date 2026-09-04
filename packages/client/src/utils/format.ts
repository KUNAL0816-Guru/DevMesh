/**
 * Pure formatting helpers for the pipeline dashboard. Kept free of React /
 * DOM dependencies so they can be unit-tested directly.
 */

export const NULL_LABEL = "unknown";

/** True when the runtime-provided token value is known (not null/undefined). */
export function isKnown(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Format an integer token count with thousands separators, or "unknown". */
export function formatTokenCount(n: number | null | undefined): string {
  if (!isKnown(n)) return NULL_LABEL;
  return n.toLocaleString("en-US");
}

/**
 * Format a cost given in integer micro-units of `currency` (always a millionth
 * of the base unit) into a human-readable string. Returns null when the cost is
 * unknown — callers must not fabricate a monetary figure.
 */
export function formatCostUsdMicros(
  micros: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (!isKnown(micros)) return null;
  const symbol = currency && currency.trim().length > 0 ? currency : null;
  const amount = micros / 1_000_000;
  // Trim trailing fractional zeros of a plain decimal without committing to a
  // specific locale/currency symbol (the backend owns all pricing semantics).
  const numeral =
    Number.isInteger(amount)
      ? amount.toLocaleString("en-US", { maximumFractionDigits: 0 })
      : amount.toLocaleString("en-US", { minimumFractionDigits: 2 });
  return symbol ? `${numeral} ${symbol}` : numeral;
}

const PREVIEW_CHARS = 12_000;

export interface ArtifactPreview {
  text: string;
  truncated: boolean;
  renderable: boolean;
}

/**
 * Produce a safe, bounded preview of an artifact payload for display.
 *
 * Artifact payloads are structured JSON objects (spec/plan/change_set/etc.),
 * so the strongest content representation the existing listing API supports is
 * that object serialized to JSON. `renderable` is true when the payload can be
 * serialized; huge payloads are truncated to PREVIEW_CHARS to avoid rendering
 * unbounded content directly into the DOM.
 */
export function previewArtifactPayload(
  payload: unknown,
  maxChars: number = PREVIEW_CHARS,
): ArtifactPreview {
  if (payload === null || payload === undefined) {
    return { text: "No content recorded for this artifact.", truncated: false, renderable: false };
  }

  let text: string;
  try {
    // Prefer the structured object when present; fall back to primitive string
    // for payloads that were stored as plain text.
    if (typeof payload === "string") {
      text = payload;
    } else {
      text = JSON.stringify(payload, null, 2);
    }
  } catch {
    return { text: "Content cannot be previewed.", truncated: false, renderable: false };
  }

  if (typeof text !== "string" || text.length === 0) {
    return { text: "No content recorded for this artifact.", truncated: false, renderable: true };
  }

  const truncated = text.length > maxChars;
  return {
    text: truncated ? `${text.slice(0, maxChars)}… (truncated)` : text,
    truncated,
    renderable: true,
  };
}

/** Total tokens (input + output) when both are known, else null. */
export function totalTokens(
  input: number | null | undefined,
  output: number | null | undefined,
): number | null {
  if (isKnown(input) && isKnown(output)) return input + output;
  return null;
}

// ---------------------------------------------------------------------------
// Approval display helpers (Phase 13G). Kept pure so they can be unit-tested
// directly, mirroring the approval contract in api/types.ts.
// ---------------------------------------------------------------------------

/** Human label for an approval status enum value. */
export function approvalStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    default:
      return status;
  }
}

/** True when an approval is still awaiting a decision (actionable). */
export function isApprovalPending(status: string): boolean {
  return status === "pending";
}

/**
 * Filter a list of project approvals down to those belonging to a specific
 * pipeline run. The existing list endpoint is project-scoped, so the client
 * narrows to the run shown on the pipeline detail page.
 */
export function filterApprovalsForRun<T extends { runId: string }>(
  approvals: readonly T[],
  runId: string,
): T[] {
  return approvals.filter((a) => a.runId === runId);
}