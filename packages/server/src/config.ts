import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { usdToMicros, type PricingRule } from "@devmesh/contracts";
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
  runtime: z.enum(["none", "opencode"]).default("none"),
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
  /** Hard wall-clock budget for a single agent execution. */
  execTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
  /** Optional per-scope cost/token budgets (Phase 8C). Absent = pre-8C. */
  budget: budgetConfigSchema.optional(),
  /** Optional pricing rules for derived cost (Phase 8C). Absent = cost null. */
  pricing: z.array(pricingProfileSchema).optional(),
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
 *   DEVMESH_PRICING (JSON array of pricing rules)
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
    execTimeoutMs:
      env.DEVMESH_EXEC_TIMEOUT_MS === undefined
        ? undefined
        : Number(env.DEVMESH_EXEC_TIMEOUT_MS),
    budget: env.DEVMESH_BUDGET ? parseJsonEnv(env.DEVMESH_BUDGET, "DEVMESH_BUDGET") : undefined,
    pricing: env.DEVMESH_PRICING
      ? parseJsonEnv(env.DEVMESH_PRICING, "DEVMESH_PRICING")
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
