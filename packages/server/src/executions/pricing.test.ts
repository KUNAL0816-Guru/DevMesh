import { describe, expect, it } from "vitest";
import {
  createPriceTable,
  deriveCostUsdMicros,
  usageWithDerivedCost,
  type CostableUsage,
} from "./pricing.js";
import type { PricingRule } from "@devmesh/contracts";

const rule: PricingRule = {
  model: "anthropic/claude-sonnet-4",
  inputUsdMicrosPerMillion: 3_000_000,
  outputUsdMicrosPerMillion: 15_000_000,
  currency: "USD",
};

const usage = (embed: Partial<CostableUsage> = {}): CostableUsage => ({
  inputTokens: null,
  outputTokens: null,
  costUsdMicros: null,
  currency: null,
  usageSource: null,
  ...embed,
});

describe("createPriceTable", () => {
  it("looks up rules by neutral model selector", () => {
    const table = createPriceTable([rule]);
    expect(table.lookup("anthropic/claude-sonnet-4")).toEqual(rule);
    expect(table.lookup("openai/gpt-4o")).toBeNull();
  });

  it("first configured rule wins on duplicate model selectors", () => {
    const table = createPriceTable([
      { ...rule, model: "x/y", inputUsdMicrosPerMillion: 1 },
      { ...rule, model: "x/y", inputUsdMicrosPerMillion: 999 },
    ]);
    expect(table.lookup("x/y")?.inputUsdMicrosPerMillion).toBe(1);
  });
});

describe("deriveCostUsdMicros", () => {
  it("computes integer micro-USD round-half-up from token counts", () => {
    // 1M in * 3 + 0.5M out * 15 = 3e6 + 7.5e6 = 10.5e6 -> 10_500_000
    expect(deriveCostUsdMicros(1_000_000, 500_000, rule)).toBe(10_500_000);
  });

  it("rounds half-up (not down) on the 1e6 division", () => {
    // Price of 1 micro-USD per million tokens.
    const r: PricingRule = { ...rule, inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 0 };
    // 500_000 * 1 / 1e6 = 0.5 micro-USD exactly -> rounds UP to 1.
    expect(deriveCostUsdMicros(500_000, 0, r)).toBe(1);
    // Just below halfway -> rounds DOWN to 0.
    expect(deriveCostUsdMicros(499_999, 0, r)).toBe(0);
    // 1_500_000 * 1 / 1e6 = 1.5 micro-USD exactly -> rounds UP to 2.
    expect(deriveCostUsdMicros(1_500_000, 0, r)).toBe(2);
  });

  it("is pure integer arithmetic (no float drift on large counts)", () => {
    const big: PricingRule = { ...rule, inputUsdMicrosPerMillion: 1_000_000 };
    // 3_000_000_000 tokens * 1e6 / 1e6 = 3_000_000_000 exactly
    expect(deriveCostUsdMicros(3_000_000_000, 0, big)).toBe(3_000_000_000);
  });
});

describe("usageWithDerivedCost", () => {
  it("derives cost from known tokens with a matching rule", () => {
    const out = usageWithDerivedCost(
      usage({ inputTokens: 1_000_000, outputTokens: 500_000 }),
      rule,
    );
    expect(out).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      costUsdMicros: 10_500_000,
      currency: "USD",
      usageSource: "derived",
    });
  });

  it("never overwrites a runtime-reported cost", () => {
    const reported = usage({ inputTokens: 100, outputTokens: 50, costUsdMicros: 42, usageSource: "reported", currency: "USD" });
    const out = usageWithDerivedCost(reported, rule);
    expect(out?.costUsdMicros).toBe(42);
    expect(out?.usageSource).toBe("reported");
  });

  it("leaves cost null when no pricing rule matches", () => {
    const out = usageWithDerivedCost(usage({ inputTokens: 10, outputTokens: 5 }), null);
    expect(out?.costUsdMicros).toBeNull();
    expect(out?.usageSource).toBeNull();
  });

  it("keeps cost null when a token count is unknown (never fabricates)", () => {
    const out = usageWithDerivedCost(usage({ inputTokens: 10, outputTokens: null }), rule);
    expect(out?.costUsdMicros).toBeNull();
    expect(out?.currency).toBeNull();
    expect(out?.usageSource).toBeNull();
  });

  it("passes null source through untouched", () => {
    expect(usageWithDerivedCost(null, rule)).toBeNull();
  });
});