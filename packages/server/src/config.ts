import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { providerModelRefSchema, usdToMicros, type PricingRule } from "@devmesh/contracts";
import type { BudgetConfig, BudgetProfile } from "./executions/budget.js";

/**
 * Optional per-scope budget limits (Phase 8C). All fields optional; a profile
 * with every field absent behaves exactly like pre-8C (no budget enforcement).
 * `maxCostUsd` is written in human USD — DevMesh converts it to integer
 * micro-USD once at load time, matching the pricing conversions.
 */
const budgetProfileSchema = z.strictObject({
  /** Max committed+reserved tokens for the scope. null/absent = unlimited. */
  maxTokens: z.number().int().nonnegative().nullable().optional(),
  /** Max committed cost in human USD. null/absent = unlimited. */
  maxCostUsd: z.number().nonnegative().nullable().optional(),
  /** "block" rejects new starts at the limit; "warn" allows them with a warning. */
  behavior: z.enum(["warn", "block"]).optional(),
  /** "block" fails starts when the scope contains UNKNOWN usage. */
  unknownUsage: z.enum(["allow", "block"]).optional(),
  /** Optimistic token reservation applied to every new execution start. */
  reservationTokens: z.number().int().nonnegative().nullable().optional(),
});

const budgetConfigSchema = z.strictObject({
  run: budgetProfileSchema.nullable().optional(),
  task: budgetProfileSchema.nullable().optional(),
});

/** Human-friendly pricing: USD per one million tokens (float ok at load). */
const pricingProfileSchema = z.strictObject({
  model: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected provider/model"),
  inputUsdPerMillionTokens: z.number().nonnegative(),
  outputUsdPerMillionTokens: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
});

export const configSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(7601),
  /** Root directory for DevMesh state: SQLite db + managed workspaces. */
  dataRoot: z
    .string()
    .min(1)
    .default(resolve(homedir(), ".devmesh")),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  /** Which agent runtime to wire at the composition root ("none" = disabled). */
  runtime: z.enum(["none", "opencode", "opencode-local"]).default("none"),
  /** Binary used by the OpenCode adapter (PATH-resolvable or absolute). */
  opencodeBin: z.string().min(1).default("opencode"),
  /**
   * Approve OpenCode permission requests (--auto). Default false: the
   * headless CLI then auto-rejects tool permission requests.
   */
  opencodeAutoApprove: z.boolean().default(false),
  /**
   * Provider/model passed to OpenCode as `-m provider/model` (req 9/10:
   * comes from configuration, never a source-code constant, and no
   * credentials ever flow through DevMesh — auth stays in opencode's own
   * credential store).
   */
  opencodeModel: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected provider/model")
    .optional(),
  /** OpenAI-compatible local/offline endpoint (e.g. Ollama) — Phase 12. */
  localBaseUrl: z.string().url("expected an http(s) URL").optional(),
  /** Plain local model id sent to the local OpenAI-compatible endpoint. */
  localModel: z.string().min(1).optional(),
  /** Optional credentials for the local endpoint — env/config only, never source. */
  localApiKey: z.string().min(1).optional(),
  /** Wall-clock budget for a single local completion call. */
  localTimeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  /** Hard wall-clock budget for a single agent execution. */
  execTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  /**
   * Which ProviderGateway backend to wire at the composition root (Phase 10).
   * "none" (default) wires an empty gateway whose completions fail with
   * provider/not-configured; "openai-compatible" is the ADR Amendment 9
   * integration direction (interface-only until Phase 12 wires the network).
   */
  gateway: z.enum(["none", "openai-compatible"]).default("none"),
  /** OpenAI-compatible base URL (e.g. https://api.openai.com/v1). */
  gatewayBaseUrl: z.string().url("expected an http(s) URL").optional(),
  /** Credentials for the OpenAI-compatible endpoint — env/config only, never source code. */
  gatewayApiKey: z.string().min(1).optional(),
  /** Neutral provider/model preference for the gateway path, e.g. "openai/gpt-4o". */
  gatewayModel: providerModelRefSchema.optional(),
  /** Wall-clock request budget for a single gateway completion. */
  gatewayTimeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  /** Optional per-scope cost/token budgets (Phase 8C). Absent = pre-8C. */
  budget: budgetConfigSchema.optional(),
  /** Optional pricing rules for derived cost (Phase 8C). Absent = cost null. */
  pricing: z.array(pricingProfileSchema).optional(),
  /**
   * Phase 14A: Authentication configuration.
   * Absent or bearerToken absent => no authentication (single-user mode).
   * When bearerToken is set, API routes require a valid Bearer token.
   */
  auth: z
    .strictObject({
      /** API token used for Bearer authentication. Absent = no auth. */
      bearerToken: z.string().min(1).optional(),
    })
    .optional(),
}).superRefine((val, ctx) => {
  if (val.runtime === "opencode-local") {
    if (!val.localBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["localBaseUrl"],
        message: "localBaseUrl is required when runtime is opencode-local",
      });
    }
    if (!val.localModel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["localModel"],
        message: "localModel is required when runtime is opencode-local",
      });
    }
  }
});

export type Config = z.infer<typeof configSchema>;

function profileFromConfig(input: z.infer<typeof budgetProfileSchema> | null | undefined): BudgetProfile | null {
  if (!input) return null;
  return {
    maxTokens: input.maxTokens ?? null,
    maxCostUsdMicros:
      input.maxCostUsd === undefined || input.maxCostUsd === null
        ? null
        : usdToMicros(input.maxCostUsd),
    behavior: input.behavior ?? "block",
    unknownUsage: input.unknownUsage ?? "allow",
    reservationTokens: input.reservationTokens ?? null,
  };
}

/** Convert loaded config into the integer-micro-USD BudgetConfig core uses. */
export function budgetConfigFromConfig(config: Config): BudgetConfig | null {
  if (!config.budget) return null;
  const run = profileFromConfig(config.budget.run);
  const task = profileFromConfig(config.budget.task);
  if (!run && !task) return null;
  return { run, task };
}

/** Convert loaded human-USD pricing into integer micro-USD PricingRules. */
export function pricingRulesFromConfig(config: Config): PricingRule[] {
  return (config.pricing ?? []).map((p) => ({
    model: p.model,
    inputUsdMicrosPerMillion: usdToMicros(p.inputUsdPerMillionTokens),
    outputUsdMicrosPerMillion: usdToMicros(p.outputUsdPerMillionTokens),
    currency: p.currency ?? "USD",
  }));
}

/** Phase 14A: Extract auth configuration for the authentication hook. */
export interface AuthConfig {
  enabled: true;
  bearerToken: string;
}

export function authConfigFromConfig(config: Config): AuthConfig | null {
  if (config.auth?.bearerToken) {
    return { enabled: true, bearerToken: config.auth.bearerToken };
  }
  return null;
}

function parseJsonEnv(raw: string | undefined, label: string): unknown {
  if (raw === undefined || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid DevMesh configuration — ${label} must be valid JSON`);
  }
}

/**
 * Load configuration from the environment (all optional):
 *   DEVMESH_HOST, DEVMESH_PORT, DEVMESH_DATA_ROOT, DEVMESH_LOG_LEVEL,
 *   DEVMESH_RUNTIME, DEVMESH_OPENCODE_BIN, DEVMESH_OPENCODE_AUTO_APPROVE,
 *   DEVMESH_EXEC_TIMEOUT_MS, DEVMESH_BUDGET (JSON budget config),
 *   DEVMESH_PRICING (JSON array of pricing rules),
 *   DEVMESH_GATEWAY, DEVMESH_GATEWAY_BASE_URL, DEVMESH_GATEWAY_API_KEY,
 *   DEVMESH_GATEWAY_MODEL, DEVMESH_GATEWAY_TIMEOUT_MS,
 *   DEVMESH_LOCAL_BASE_URL, DEVMESH_LOCAL_MODEL, DEVMESH_LOCAL_API_KEY,
 *   DEVMESH_LOCAL_TIMEOUT_MS,
 *   DEVMESH_AUTH_TOKEN (Phase 14A: API token for Bearer authentication)
 * Throws a plain Error with a readable message on invalid values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    host: env.DEVMESH_HOST,
    port: env.DEVMESH_PORT === undefined ? undefined : Number(env.DEVMESH_PORT),
    dataRoot: env.DEVMESH_DATA_ROOT,
    logLevel: env.DEVMESH_LOG_LEVEL,
    runtime: env.DEVMESH_RUNTIME,
    opencodeBin: env.DEVMESH_OPENCODE_BIN,
    opencodeAutoApprove:
      env.DEVMESH_OPENCODE_AUTO_APPROVE === undefined
        ? undefined
        : ["1", "true", "yes"].includes(env.DEVMESH_OPENCODE_AUTO_APPROVE.toLowerCase()),
    opencodeModel: env.DEVMESH_OPENCODE_MODEL || undefined,
    localBaseUrl: env.DEVMESH_LOCAL_BASE_URL || undefined,
    localModel: env.DEVMESH_LOCAL_MODEL || undefined,
    localApiKey: env.DEVMESH_LOCAL_API_KEY || undefined,
    localTimeoutMs:
      env.DEVMESH_LOCAL_TIMEOUT_MS === undefined
        ? undefined
        : Number(env.DEVMESH_LOCAL_TIMEOUT_MS),
    execTimeoutMs:
      env.DEVMESH_EXEC_TIMEOUT_MS === undefined
        ? undefined
        : Number(env.DEVMESH_EXEC_TIMEOUT_MS),
    gateway: env.DEVMESH_GATEWAY || undefined,
    gatewayBaseUrl: env.DEVMESH_GATEWAY_BASE_URL || undefined,
    gatewayApiKey: env.DEVMESH_GATEWAY_API_KEY || undefined,
    gatewayModel: env.DEVMESH_GATEWAY_MODEL || undefined,
    gatewayTimeoutMs:
      env.DEVMESH_GATEWAY_TIMEOUT_MS === undefined
        ? undefined
        : Number(env.DEVMESH_GATEWAY_TIMEOUT_MS),
    budget: env.DEVMESH_BUDGET ? parseJsonEnv(env.DEVMESH_BUDGET, "DEVMESH_BUDGET") : undefined,
    pricing: env.DEVMESH_PRICING
      ? parseJsonEnv(env.DEVMESH_PRICING, "DEVMESH_PRICING")
      : undefined,
    auth: env.DEVMESH_AUTH_TOKEN
      ? { bearerToken: env.DEVMESH_AUTH_TOKEN }
      : undefined,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid DevMesh configuration — ${issues}`);
  }
  return parsed.data;
}

export function databasePath(config: Config): string {
  return resolve(config.dataRoot, "devmesh.db");
}

export function workspacesRoot(config: Config): string {
  return resolve(config.dataRoot, "workspaces");
}
