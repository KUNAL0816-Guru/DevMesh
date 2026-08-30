import type { PricingRule } from "@devmesh/contracts";

/**
 * Neutral price-table lookup for Phase 8C cost derivation. Rules come from
 * configuration (see config.ts); the core never hard-codes a vendor price.
 * First rule wins when configuration duplicates a model selector.
 */
export interface PriceTable {
  readonly rules: ReadonlyArray<PricingRule>;
  /** null/undefined (no configured model) never matches a rule. */
  lookup(model: string | undefined): PricingRule | null;
}

export function createPriceTable(rules: ReadonlyArray<PricingRule>): PriceTable {
  const byModel = new Map<string, PricingRule>();
  for (const rule of rules) {
    if (!byModel.has(rule.model)) byModel.set(rule.model, rule);
  }
  return {
    rules,
    lookup(model: string | undefined): PricingRule | null {
      if (model === undefined) return null;
      return byModel.get(model) ?? null;
    },
  };
}

const MICROS_PER_MILLION_TOKENS = 1_000_000n;

/**
 * Derive cost in integer micro-USD from runtime-reported token counts using a
 * pricing rule. Integer-only BigInt arithmetic with deterministic round-half-up
 * on the final 1e6 division — no float accumulation anywhere in cost accounting.
 */
export function deriveCostUsdMicros(
  inputTokens: number,
  outputTokens: number,
  rule: PricingRule,
): number {
  const totalMicros =
    BigInt(inputTokens) * BigInt(rule.inputUsdMicrosPerMillion) +
    BigInt(outputTokens) * BigInt(rule.outputUsdMicrosPerMillion);
  let quotient = totalMicros / MICROS_PER_MILLION_TOKENS;
  const remainder = totalMicros % MICROS_PER_MILLION_TOKENS;
  if (remainder * 2n >= MICROS_PER_MILLION_TOKENS) quotient += 1n;
  return Number(quotient);
}

/** The usage shape ExecutionService persists (see persistedUsage). */
export interface CostableUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsdMicros: number | null;
  currency: string | null;
  usageSource: "reported" | "derived" | null;
}

/**
 * Attach derived cost to runtime-reported tokens when BOTH hold:
 * - the runtime did not already report a cost (reported cost is never
 *   overwritten), and
 * - both token counts are known AND a matching pricing rule is configured.
 * Otherwise the usage passes through untouched (cost stays null). Nobody ever
 * fabricates a zero or a guessed cost for unknown usage.
 */
export function usageWithDerivedCost(
  source: CostableUsage | null,
  rule: PricingRule | null,
): CostableUsage | null {
  if (source === null) return null;
  if (source.costUsdMicros !== null) return source;
  if (rule === null || source.inputTokens === null || source.outputTokens === null) {
    return source;
  }
  return {
    ...source,
    costUsdMicros: deriveCostUsdMicros(source.inputTokens, source.outputTokens, rule),
    currency: rule.currency,
    usageSource: "derived",
  };
}