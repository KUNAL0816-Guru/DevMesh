import { z } from "zod";
import { tokenUsageSchema } from "./usage.js";

/**
 * Neutral, provider-independent identifiers (ADR-0001 amendment 6). DevMesh
 * never hard-codes any vendor's names in core: a provider id is any
 * identifier-like token and a model id any dotted/hyphened token. Validation
 * is purely syntactic — there is NO vendor allow-list, so any provider can be
 * named as long as the string is well-formed.
 */
export const providerIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "expected a provider id (e.g. anthropic, openai, ollama)");

export const modelIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "expected a model id (e.g. claude-sonnet-4, gpt-4o)");

/**
 * A neutral model preference: a `provider/model-id` pair separated by exactly
 * one "/". Unknown providers are NOT silently skipped — they fail later with
 * a typed error at the gateway boundary.
 */
export const providerModelRefSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/i,
    "expected provider/model-id (e.g. anthropic/claude-sonnet-4)",
  );

export type ProviderModelRef = {
  provider: string;
  model: string;
};

/**
 * Split a neutral `provider/model-id` preference string into its parts.
 * Validation is syntactic and provider-independent; throws a ZodError on
 * malformed input (callers at the gateway boundary translate it into a typed
 * ProviderError).
 */
export function parseProviderModelRef(ref: string): ProviderModelRef {
  const validated = providerModelRefSchema.parse(ref);
  const slash = validated.indexOf("/");
  return {
    provider: validated.slice(0, slash),
    model: validated.slice(slash + 1),
  };
}

// ---------------------------------------------------------------------------
// ProviderRequest / ProviderResult — wire format for DevMesh's own LLM calls
// ---------------------------------------------------------------------------

export const providerMessageRoleSchema = z.enum(["system", "user", "assistant"]);
export type ProviderMessageRole = z.infer<typeof providerMessageRoleSchema>;

export const providerMessageSchema = z.strictObject({
  role: providerMessageRoleSchema,
  content: z.string().min(1).max(256_000),
});
export type ProviderMessage = z.infer<typeof providerMessageSchema>;

export const providerMessageListSchema = z.array(providerMessageSchema).min(1).max(200);

/**
 * A single completion request through the ProviderGateway port. This path is
 * for DevMesh's OWN LLM calls (ADR-0001 amendment 6) and is deliberately
 * separate from coding-agent execution, which stays behind AgentRuntime.
 */
export const providerRequestSchema = z.strictObject({
  provider: providerIdSchema,
  model: modelIdSchema,
  messages: providerMessageListSchema,
  maxTokens: z.number().int().positive().max(200_000).optional(),
});
export type ProviderRequest = z.infer<typeof providerRequestSchema>;

/**
 * The gateway's completion result. `provider`/`model` are echoed back for
 * provenance; `usage` is optional and follows the Phase 8A invariant that a
 * missing report is "unmeasured", never a fabricated zero.
 */
export const providerResultSchema = z.strictObject({
  provider: providerIdSchema,
  model: modelIdSchema,
  content: z.string(),
  finishReason: z.string().optional(),
  usage: tokenUsageSchema.optional(),
});
export type ProviderResult = z.infer<typeof providerResultSchema>;