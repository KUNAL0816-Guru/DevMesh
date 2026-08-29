import { z } from "zod";

/**
 * Token usage reported by a runtime adapter for a single execution. This is
 * the TRUTH a runtime can state about itself; cost is never a runtime constant
 * and is either reported explicitly or derived by DevMesh from config pricing.
 */
export const tokenUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

/**
 * Versioned usage/cost report used by persistence, budget events, and the
 * accounting API. `costUsdMicros` is integer micro-USD to avoid float drift;
 * `usageSource` distinguishes "reported" (runtime supplied) from "derived"
 * (DevMesh computed from config pricing). Absence of cost fields means
 * "no cost known" — never a fabricated zero.
 */
export const usageReportSchema = tokenUsageSchema.extend({
  costUsdMicros: z.number().int().nonnegative().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, "expected an ISO 4217 currency code").default("USD"),
  usageSource: z.enum(["reported", "derived"]).optional(),
});
export type UsageReport = z.infer<typeof usageReportSchema>;