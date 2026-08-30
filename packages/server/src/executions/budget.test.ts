import { describe, expect, it } from "vitest";
import {
  BudgetError,
  BudgetLedger,
  evaluateBudget,
  scopeKeyFor,
  type BudgetEvalInput,
} from "./budget.js";
import type { ExecutionUsage } from "@devmesh/storage";

const empty: ExecutionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  costUsdMicros: 0,
  currency: null,
  usageSource: null,
};

const usage = (embed: Partial<ExecutionUsage>): ExecutionUsage => ({ ...empty, ...embed });

function evalOne(embed: { totals?: ExecutionUsage; input?: Partial<BudgetEvalInput> } = {}) {
  return evaluateBudget({
    profile: embed.input?.profile ?? {},
    totals: embed.totals ?? empty,
    unknownExecutionCount: 0,
    reservedTokens: 0,
    additionalTokens: 0,
    ...(embed.input ?? {}),
  });
}

describe("evaluateBudget (pure)", () => {
  it("always allows when no limits are configured (pre-8C behavior)", () => {
    expect(evalOne().outcome).toBe("allow");
    expect(evalOne({ input: { unknownExecutionCount: 3 } }).outcome).toBe("allow");
  });

  it("allows when projected tokens stay within the limit at the boundary", () => {
    const d = evalOne({
      input: {
        profile: { maxTokens: 100 },
        totals: usage({ inputTokens: 40, outputTokens: 60 }),
      },
    });
    expect(d.outcome).toBe("allow");
  });

  it("rejects when committed tokens already exceed the limit", () => {
    const d = evalOne({
      input: {
        profile: { maxTokens: 100 },
        totals: usage({ inputTokens: 80, outputTokens: 40 }),
      },
    });
    expect(d.outcome).toBe("reject");
    expect(d.reason).toBe("maxTokens");
  });

  it("rejects when the proposed reservation would bust the limit", () => {
    const d = evalOne({
      input: {
        profile: { maxTokens: 100 },
        totals: usage({ inputTokens: 40, outputTokens: 40 }),
        additionalTokens: 25,
      },
    });
    expect(d.outcome).toBe("reject");
  });

  it("accounts for already-reserved tokens from in-flight executions", () => {
    const d = evalOne({
      input: {
        profile: { maxTokens: 100 },
        totals: usage({ inputTokens: 30, outputTokens: 30 }),
        reservedTokens: 30,
        additionalTokens: 15,
      },
    });
    expect(d.outcome).toBe("reject");
  });

  it("rejects on committed cost when over the micro-USD limit", () => {
    const d = evalOne({
      input: {
        profile: { maxCostUsdMicros: 1_000_000 },
        totals: usage({ costUsdMicros: 1_200_000 }),
      },
    });
    expect(d.outcome).toBe("reject");
    expect(d.reason).toBe("maxCostUsdMicros");
  });

  it("skips the cost check when cost is UNKNOWN (never fabricates zero)", () => {
    const d = evalOne({
      input: {
        profile: { maxCostUsdMicros: 1_000_000 },
        totals: usage({ costUsdMicros: null }),
      },
    });
    expect(d.outcome).toBe("allow");
  });

  it("skips the token check when a token dimension is UNKNOWN", () => {
    const d = evalOne({
      input: {
        profile: { maxTokens: 50 },
        totals: usage({ inputTokens: 100, outputTokens: null }),
      },
    });
    expect(d.outcome).toBe("allow");
  });

  it("blocks when the scope contains unknown usage and unknownUsage=block", () => {
    const d = evalOne({
      input: { profile: { maxTokens: 1000, unknownUsage: "block" }, unknownExecutionCount: 1 },
    });
    expect(d.outcome).toBe("reject");
    expect(d.reason).toBe("unknownUsage");
  });

  it("warn behavior downgrades violations to warnings", () => {
    const d = evalOne({
      input: {
        profile: { maxTokens: 100, behavior: "warn" },
        totals: usage({ inputTokens: 120, outputTokens: 0 }),
      },
    });
    expect(d.outcome).toBe("warn");
  });

  it("warn behavior also downgrades unknown-usage violations", () => {
    const d = evalOne({
      input: {
        profile: { maxTokens: 1000, unknownUsage: "block", behavior: "warn" },
        unknownExecutionCount: 1,
      },
    });
    expect(d.outcome).toBe("warn");
  });
});

describe("BudgetLedger", () => {
  it("tracks reservations per scope and releases them", () => {
    const ledger = new BudgetLedger();
    expect(ledger.reservedTokens("run", "r1")).toBe(0);
    ledger.reserve("run", "r1", 100);
    ledger.reserve("run", "r1", 50);
    expect(ledger.reservedTokens("run", "r1")).toBe(150);
    ledger.release("run", "r1", 100);
    expect(ledger.reservedTokens("run", "r1")).toBe(50);
    ledger.release("run", "r1", 50);
    expect(ledger.reservedTokens("run", "r1")).toBe(0);
  });

  it("keeps task and run scopes isolated", () => {
    const ledger = new BudgetLedger();
    ledger.reserve("task", "t1", 10);
    ledger.reserve("run", "r1", 20);
    expect(ledger.reservedTokens("task", "t1")).toBe(10);
    expect(ledger.reservedTokens("run", "r1")).toBe(20);
  });

  it("is idempotent under over-release (terminal paths run at most once per scope key)", () => {
    const ledger = new BudgetLedger();
    ledger.reserve("run", "r1", 5);
    ledger.release("run", "r1", 5);
    ledger.release("run", "r1", 5);
    expect(ledger.reservedTokens("run", "r1")).toBe(0);
  });

  it("rejects malformed reserve amounts", () => {
    const ledger = new BudgetLedger();
    expect(() => ledger.reserve("run", "r1", -1)).toThrow();
    expect(() => ledger.reserve("run", "r1", 1.5)).toThrow();
  });
});

describe("scopeKeyFor / BudgetError", () => {
  it("builds stable scope keys", () => {
    expect(scopeKeyFor("run", "abc")).toBe("run:abc");
    expect(scopeKeyFor("task", "xyz")).toBe("task:xyz");
  });

  it("BudgetError carries the budget/exhausted code and scope information", () => {
    const err = new BudgetError("run:r1: too many tokens", "run", "r1");
    expect(err.code).toBe("budget/exhausted");
    expect(err.scopeKind).toBe("run");
    expect(err.scopeId).toBe("r1");
    expect(err.message).toContain("run:r1");
  });
});