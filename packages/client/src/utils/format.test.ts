import { describe, expect, it } from "vitest";
import {
  formatTokenCount,
  formatCostUsdMicros,
  previewArtifactPayload,
  totalTokens,
  isKnown,
  approvalStatusLabel,
  isApprovalPending,
  filterApprovalsForRun,
} from "./format.js";

describe("isKnown", () => {
  it("is true for finite numbers", () => {
    expect(isKnown(0)).toBe(true);
    expect(isKnown(100)).toBe(true);
  });

  it("is false for null/undefined/NaN/Infinity", () => {
    expect(isKnown(null)).toBe(false);
    expect(isKnown(undefined)).toBe(false);
    expect(isKnown(Number.NaN)).toBe(false);
    expect(isKnown(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("formatTokenCount", () => {
  it("formats with thousands separators", () => {
    expect(formatTokenCount(1234567)).toBe("1,234,567");
    expect(formatTokenCount(0)).toBe("0");
  });

  it("returns 'unknown' for null/undefined", () => {
    expect(formatTokenCount(null)).toBe("unknown");
    expect(formatTokenCount(undefined)).toBe("unknown");
  });
});

describe("formatCostUsdMicros", () => {
  it("formats micro-USD as a decimal with currency", () => {
    expect(formatCostUsdMicros(1_250_000, "USD")).toBe("1.25 USD");
  });

  it("formats amounts without fractional cents cleanly", () => {
    expect(formatCostUsdMicros(3_000_000, "USD")).toBe("3 USD");
  });

  it("returns null (never fabricates) when cost is unknown", () => {
    expect(formatCostUsdMicros(null, "USD")).toBeNull();
    expect(formatCostUsdMicros(undefined, "USD")).toBeNull();
  });

  it("omits currency label when currency is absent", () => {
    expect(formatCostUsdMicros(500_000, null)).toBe("0.50");
  });
});

describe("previewArtifactPayload", () => {
  it("serializes a structured object as JSON", () => {
    const r = previewArtifactPayload({ title: "T", goals: ["g"] });
    expect(r.renderable).toBe(true);
    expect(r.text).toContain('"title"');
    expect(r.text).toContain("T");
  });

  it("keeps primitive string payloads readable", () => {
    const r = previewArtifactPayload("plain text");
    expect(r.renderable).toBe(true);
    expect(r.text).toBe("plain text");
  });

  it("marks null/undefined payloads as empty and non-renderable", () => {
    expect(previewArtifactPayload(null).renderable).toBe(false);
    expect(previewArtifactPayload(undefined).renderable).toBe(false);
  });

  it("truncates payloads that exceed the bound and flags truncation", () => {
    const big = { blob: "x".repeat(50_000) };
    const r = previewArtifactPayload(big, 1_000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(2_000);
    expect(r.text).toContain("(truncated)");
  });

  it("does not truncate small payloads", () => {
    const r = previewArtifactPayload({ a: "b" }, 1_000);
    expect(r.truncated).toBe(false);
  });

  it("never renders an unbounded blob beyond the configured cap", () => {
    const huge = { data: "z".repeat(200_000) };
    const r = previewArtifactPayload(huge, 1_048_576);
    expect(r.text.length).toBeLessThanOrEqual(1_048_576);
  });
});

describe("totalTokens", () => {
  it("sums input and output when both are known", () => {
    expect(totalTokens(100, 50)).toBe(150);
  });

  it("returns null when either side is unknown", () => {
    expect(totalTokens(null, 50)).toBeNull();
    expect(totalTokens(100, null)).toBeNull();
    expect(totalTokens(null, null)).toBeNull();
  });
});

describe("approvalStatusLabel", () => {
  it("labels each status enum value", () => {
    expect(approvalStatusLabel("pending")).toBe("Pending");
    expect(approvalStatusLabel("approved")).toBe("Approved");
    expect(approvalStatusLabel("denied")).toBe("Denied");
  });

  it("falls back to the raw value for unknown statuses", () => {
    expect(approvalStatusLabel("weird")).toBe("weird");
  });
});

describe("isApprovalPending", () => {
  it("is true only for pending approvals", () => {
    expect(isApprovalPending("pending")).toBe(true);
    expect(isApprovalPending("approved")).toBe(false);
    expect(isApprovalPending("denied")).toBe(false);
  });
});

describe("filterApprovalsForRun", () => {
  it("keeps only approvals belonging to the given run", () => {
    const approvals = [
      { runId: "run-1" },
      { runId: "run-2" },
      { runId: "run-1" },
    ];
    expect(filterApprovalsForRun(approvals, "run-1").map((a) => a.runId)).toEqual([
      "run-1",
      "run-1",
    ]);
  });

  it("returns an empty list when the run has no approvals", () => {
    expect(filterApprovalsForRun([{ runId: "other" }], "run-1")).toEqual([]);
  });
});