import { describe, expect, it } from "vitest";
import { tokenUsageSchema, usageReportSchema, type TokenUsage, type UsageReport } from "./usage.js";

describe("tokenUsageSchema", () => {
  it("accepts non-negative integer token counts", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 50 };
    expect(tokenUsageSchema.parse(usage)).toEqual(usage);
  });

  it("accepts zero tokens (edge case, not fabricated)", () => {
    expect(tokenUsageSchema.parse({ inputTokens: 0, outputTokens: 0 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("rejects negative token counts", () => {
    expect(tokenUsageSchema.safeParse({ inputTokens: -1, outputTokens: 0 }).success).toBe(false);
    expect(tokenUsageSchema.safeParse({ inputTokens: 0, outputTokens: -5 }).success).toBe(false);
  });

  it("rejects non-integer token counts", () => {
    expect(tokenUsageSchema.safeParse({ inputTokens: 1.5, outputTokens: 0 }).success).toBe(false);
  });

  it("rejects missing or unknown fields", () => {
    expect(tokenUsageSchema.safeParse({ inputTokens: 1 }).success).toBe(false);
    expect(tokenUsageSchema.safeParse({ inputTokens: 1, outputTokens: 2, extra: 3 }).success).toBe(false);
  });
});

describe("usageReportSchema", () => {
  it("extends token usage with optional cost fields", () => {
    const report: UsageReport = {
      inputTokens: 200,
      outputTokens: 80,
      costUsdMicros: 5000,
      currency: "USD",
      usageSource: "derived",
    };
    expect(usageReportSchema.parse(report)).toEqual(report);
  });

  it("defaults currency to USD when omitted", () => {
    const parsed = usageReportSchema.parse({ inputTokens: 10, outputTokens: 20 });
    expect(parsed.currency).toBe("USD");
    expect(parsed.costUsdMicros).toBeUndefined();
    expect(parsed.usageSource).toBeUndefined();
  });

  it("rejects negative cost and invalid currency or source", () => {
    expect(
      usageReportSchema.safeParse({ inputTokens: 1, outputTokens: 1, costUsdMicros: -1 }).success,
    ).toBe(false);
    expect(
      usageReportSchema.safeParse({ inputTokens: 1, outputTokens: 1, currency: "usd" }).success,
    ).toBe(false);
    expect(
      usageReportSchema.safeParse({ inputTokens: 1, outputTokens: 1, usageSource: "guessed" }).success,
    ).toBe(false);
  });
});