import { describe, expect, it } from "vitest";
import { contextEntrySchema, contextNamespaces, makeContextEntry } from "./context.js";
import { newContextEntryId } from "./ids.js";

describe("context entries (blackboard)", () => {
  it("builds attributable entries with makeContextEntry", () => {
    const entry = makeContextEntry({
      namespace: "decision",
      key: "auth/strategy",
      value: { choice: "session-cookie", reasons: ["simplicity"] },
      createdBy: "architect",
    });
    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toMatch(/Z$/);
    expect(contextEntrySchema.parse(entry)).toEqual(entry);
  });

  it("supports supersession chains", () => {
    const first = makeContextEntry({
      namespace: "spec",
      key: "api/base-url",
      value: "/api/v1",
      createdBy: "architect",
    });
    const second = makeContextEntry({
      namespace: "spec",
      key: "api/base-url",
      value: "/api/v2",
      createdBy: "architect",
      supersedes: first.id,
    });
    expect(second.supersedes).toBe(first.id);
  });

  it("enforces namespaces and rejects unknown actors", () => {
    expect(contextNamespaces).toContain("finding");
    expect(contextNamespaces).toContain("failure");
    expect(contextNamespaces).toContain("revision");
    expect(() =>
      makeContextEntry({
        namespace: "gossip" as never,
        key: "x",
        value: null,
        createdBy: "system",
      }),
    ).toThrow();
    expect(() =>
      contextEntrySchema.parse({
        id: newContextEntryId(),
        namespace: "spec",
        key: "k",
        value: null,
        createdBy: "devops",
        createdAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it("supports failure namespace with structured failure data", () => {
    const entry = makeContextEntry({
      namespace: "failure",
      key: "tester/attempt-1",
      value: {
        verdict: "fail",
        failures: [
          { message: "assertion error in test_login", location: "tests/auth.test.ts:42" },
          { message: "timeout in test_db", location: "tests/db.test.ts:15" },
        ],
        totals: { passed: 8, failed: 2 },
      },
      createdBy: "tester",
    });
    expect(entry.namespace).toBe("failure");
    expect(entry.key).toBe("tester/attempt-1");
    expect(contextEntrySchema.parse(entry)).toEqual(entry);
  });

  it("supports revision namespace with cycle tracking data", () => {
    const first = makeContextEntry({
      namespace: "revision",
      key: "developer/attempt-1",
      value: {
        cycleType: "tester_failure",
        attemptNumber: 1,
        failureSignature: "process_failure:assertion_error",
      },
      createdBy: "system",
    });
    const second = makeContextEntry({
      namespace: "revision",
      key: "developer/attempt-2",
      value: {
        cycleType: "tester_failure",
        attemptNumber: 2,
        failureSignature: "process_failure:assertion_error",
      },
      createdBy: "system",
      supersedes: first.id,
    });
    expect(second.supersedes).toBe(first.id);
    expect(second.namespace).toBe("revision");
  });
});
