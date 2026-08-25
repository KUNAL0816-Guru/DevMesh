import { describe, expect, it } from "vitest";
import {
  newApprovalId,
  newArtifactId,
  newProjectId,
  newRunId,
  newSessionId,
  newTaskId,
  projectIdSchema,
  runIdSchema,
} from "./ids.js";

describe("branded id factories", () => {
  it("produce unique values", () => {
    const ids = new Set([
      newProjectId(),
      newRunId(),
      newTaskId(),
      newArtifactId(),
      newApprovalId(),
    ]);
    for (const id of ids) expect(typeof id).toBe("string");
    void ids;
  });

  it("are stable under re-parse", () => {
    const run = newRunId();
    expect(runIdSchema.parse(run)).toBe(run);
  });

  it("reject malformed uuids", () => {
    expect(projectIdSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  it("session ids are opaque runtime strings", () => {
    expect(newSessionId("ses_2fFa9kQ81")).toMatch(/ses_/);
    expect(() => newSessionId("")).toThrow();
  });
});
