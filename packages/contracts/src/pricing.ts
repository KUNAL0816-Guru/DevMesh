import { z } from "zod";

/**
 * Neutral, configuration-driven pricing rule for a single model.
 *
 * Provider neutrality (ADR-0001 amendment 6): the rule is keyed by the same
 * neutral `provider/model` string used by configuration — DevMesh never
 * hard-codes any vendor's prices or provider names in core.
 *
 * Prices are expressed in integer micro-USD per one million tokens so all
 * downstream cost arithmetic stays integer-only (no float accumulation).
 * `1 USD = 1_000_000 micro-USD`.
 */
export const pricingRuleSchema = z.strictObject({
  /** Neutral model selector, e.g. "anthropic/claude-sonnet-4". */
  model: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected provider/model"),
  /** Micro-USD per 1M input tokens (integer). */
  inputUsdMicrosPerMillion: z.number().int().nonnegative(),
  /** Micro-USD per 1M output tokens (integer). */
  outputUsdMicrosPerMillion: z.number().int().nonnegative(),
  /** ISO 4217 currency — currently only USD is priced. */
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
});
export type PricingRule = z.infer<typeof pricingRuleSchema>;

/**
 * Deterministically convert a config-level USD amount into integer micro-USD.
 *
 * Config authors write human-friendly decimals (e.g. `3.00` USD per million
 * tokens); DevMesh converts them ONCE at configuration load time and never
 * touches floats again for cost accounting. Rounding is the deterministic
 * IEEE-754 tie-breaking that `Math.round` performs and is stable for the
 * magnitudes a pricing table can realistically contain.
 */
export function usdToMicros(usdAmount: number): number {
  return Math.round(usdAmount * 1_000_000);
}