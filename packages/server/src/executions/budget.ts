import type { ExecutionUsage } from "@devmesh/storage";

/**
 * Budget configuration and enforcement (Phase 8C).
 *
 * Provider/price neutral: the service never inspects models or vendors here —
 * `evaluateBudget` reasons only over the committed usage aggregate (token and
 * integer micro-USD totals) produced by Phase 8B aggregation, plus in-process
 * reservations. All comparisons are integer-only.
 *
 * Scope map: one pipeline run = one run scope (`run:<pipelineRunId>`); every
 * task belongs to its run scope, and a task also has its own scope
 * (`task:<taskId>`). Executions started by the orchestrator land in BOTH; a
 * direct/API execution lands in the run scope of its linked run, or its own
 * transient run scope when unlinked.
 */

export type BudgetScopeKind = "run" | "task";

/** Configured limits for a single scope. Every field is optional. */
export interface BudgetProfile {
  /** Max committed+reserved tokens. null = no limit. */
  maxTokens?: number | null;
  /** Max committed cost in integer micro-USD. null = no limit. */
  maxCostUsdMicros?: number | null;
  /**
   * How to treat limit violations: "block" rejects new executions that would
   * exceed a limit; "warn" allows them but flags the concern as a warning.
   */
  behavior?: "warn" | "block";
  /** How to treat scopes containing executions with UNKNOWN usage. */
  unknownUsage?: "allow" | "block";
  /**
   * Optimistic token estimate reserved up-front for a new execution, letting
   * concurrent starts account for each other before anything commits.
   */
  reservationTokens?: number | null;
}

export interface BudgetConfig {
  run?: BudgetProfile | null;
  task?: BudgetProfile | null;
}

export interface BudgetEvalInput {
  profile: BudgetProfile;
  /** Committed (terminal-only) usage aggregate of the scope. */
  totals: ExecutionUsage;
  /** Committed executions whose usage was entirely UNKNOWN. */
  unknownExecutionCount: number;
  /** Tokens already reserved in-process for this scope. */
  reservedTokens: number;
  /** New reservation being proposed by the gate being evaluated. */
  additionalTokens: number;
}

export type BudgetOutcome = "allow" | "warn" | "reject";

export interface BudgetDecision {
  outcome: BudgetOutcome;
  /** Representative trigger, for diagnostics (first violated, fixed order). */
  reason: "maxCostUsdMicros" | "maxTokens" | "unknownUsage";
  detail: string;
}

function sumTokens(totals: ExecutionUsage): number | null {
  const { inputTokens, outputTokens } = totals;
  if (inputTokens === null || outputTokens === null) return null;
  return inputTokens + outputTokens;
}

function profileHasLimits(profile: BudgetProfile): boolean {
  return (
    (profile.maxTokens ?? null) !== null ||
    (profile.maxCostUsdMicros ?? null) !== null
  );
}

/**
 * Pure budget decision. Deterministic: same inputs always yield the same
 * outcome. No limits configured => always "allow" (pre-8C behavior).
 */
export function evaluateBudget(input: BudgetEvalInput): BudgetDecision {
  const { profile } = input;
  const maxTokens = profile.maxTokens ?? null;
  const maxCost = profile.maxCostUsdMicros ?? null;
  const warnOnly = profile.behavior === "warn";

  if (!profileHasLimits(profile)) {
    return { outcome: "allow", reason: "maxTokens", detail: "no budget limits configured" };
  }

  const violations: Array<{ reason: BudgetDecision["reason"]; text: string }> = [];

  if (profile.unknownUsage === "block" && input.unknownExecutionCount > 0) {
    violations.push({
      reason: "unknownUsage",
      text: `usage is UNKNOWN for ${input.unknownExecutionCount} committed execution(s)`,
    });
  }

  if (maxTokens !== null) {
    const committed = sumTokens(input.totals);
    if (committed !== null) {
      const projected = committed + input.reservedTokens + input.additionalTokens;
      if (projected > maxTokens) {
        violations.push({
          reason: "maxTokens",
          text: `projected ${projected} tokens exceeds limit of ${maxTokens}`,
        });
      }
    }
  }

  if (maxCost !== null && input.totals.costUsdMicros !== null) {
    if (input.totals.costUsdMicros > maxCost) {
      violations.push({
        reason: "maxCostUsdMicros",
        text: `committed cost ${input.totals.costUsdMicros} micro-USD exceeds limit of ${maxCost}`,
      });
    }
  }

  if (violations.length === 0) {
    return { outcome: "allow", reason: "maxTokens", detail: "within budget" };
  }

  const reason = violations[0]!.reason;
  const detail = violations.map((v) => v.text).join("; ");
  return { outcome: warnOnly ? "warn" : "reject", reason, detail };
}

export function scopeKeyFor(kind: BudgetScopeKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * In-process reservation ledger (single-process architecture). Reservations
 * are best-effort concurrency control — they die with the process, and the
 * durable source of truth remains the committed usage in SQLite, which is
 * reconciled after every execution completes.
 */
export class BudgetLedger {
  private readonly reserved = new Map<string, number>();

  reservedTokens(kind: BudgetScopeKind, id: string): number {
    return this.reserved.get(scopeKeyFor(kind, id)) ?? 0;
  }

  reserve(kind: BudgetScopeKind, id: string, tokens: number): void {
    if (!Number.isInteger(tokens) || tokens < 0) {
      throw new Error(`budget reserve requires a non-negative integer, got ${tokens}`);
    }
    const key = scopeKeyFor(kind, id);
    this.reserved.set(key, (this.reserved.get(key) ?? 0) + tokens);
  }

  release(kind: BudgetScopeKind, id: string, tokens: number): void {
    const key = scopeKeyFor(kind, id);
    const current = this.reserved.get(key) ?? 0;
    const next = current - tokens;
    if (next <= 0) {
      this.reserved.delete(key);
    } else {
      this.reserved.set(key, next);
    }
  }

  clear(): void {
    this.reserved.clear();
  }
}

/** Typed budget-gate failure, surfaced as HTTP 409 budget/exhausted. */
export class BudgetError extends Error {
  readonly code = "budget/exhausted" as const;
  readonly scopeKind: BudgetScopeKind;
  readonly scopeId: string;

  constructor(message: string, scopeKind: BudgetScopeKind, scopeId: string) {
    super(message);
    this.name = "BudgetError";
    this.scopeKind = scopeKind;
    this.scopeId = scopeId;
  }
}