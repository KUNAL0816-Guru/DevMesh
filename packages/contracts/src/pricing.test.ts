import { describe, expect, it } from "vitest";
import { pricingRuleSchema, usdToMicros } from "./pricing.js";

describe("pricingRuleSchema", () => {
  it("accepts a neutral provider/model rule with integer micro-USD prices", () => {
    const rule = pricingRuleSchema.parse({
      model: "anthropic/claude-sonnet-4",
      inputUsdMicrosPerMillion: 3_000_000,
      outputUsdMicrosPerMillion: 15_000_000,
    });
    expect(rule.currency).toBe("USD");
  });

  it("rejects non-provider/model selectors", () => {
    expect(() =>
      pricingRuleSchema.parse({
        model: "claude-sonnet-4",
        inputUsdMicrosPerMillion: 1,
        outputUsdMicrosPerMillion: 2,
      }),
    ).toThrow();
  });

  it("rejects fractional micro-USD prices (integer arithmetic only)", () => {
    expect(() =>
      pricingRuleSchema.parse({
        model: "anthropic/claude-sonnet-4",
        inputUsdMicrosPerMillion: 1.5,
        outputUsdMicrosPerMillion: 2,
      }),
    ).toThrow();
  });

  it("rejects negative prices", () => {
    expect(() =>
      pricingRuleSchema.parse({
        model: "anthropic/claude-sonnet-4",
        inputUsdMicrosPerMillion: -1,
        outputUsdMicrosPerMillion: 2,
      }),
    ).toThrow();
  });

  it("honours the explicitly configured currency", () => {
    const rule = pricingRuleSchema.parse({
      model: "openai/gpt-4o",
      inputUsdMicrosPerMillion: 1,
      outputUsdMicrosPerMillion: 1,
      currency: "USD",
    });
    expect(rule.currency).toBe("USD");
  });
});

describe("usdToMicros", () => {
  it("converts human USD to integer micro-USD deterministically", () => {
    expect(usdToMicros(3)).toBe(3_000_000);
    expect(usdToMicros(15)).toBe(15_000_000);
    expect(usdToMicros(0.5)).toBe(500_000);
    expect(usdToMicros(2.5)).toBe(2_500_000);
  });

  it("converts fractional USD into the nearest integer micro-USD", () => {
    expect(usdToMicros(1.25)).toBe(1_250_000);
    expect(usdToMicros(0.333333)).toBe(333_333);
    expect(usdToMicros(0)).toBe(0);
  });
});