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
});
