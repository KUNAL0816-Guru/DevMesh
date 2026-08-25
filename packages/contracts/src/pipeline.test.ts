import { describe, expect, it } from "vitest";
import { newProjectId, newRunId } from "./ids.js";
import {
  pipelineRunSchema,
  pipelineRunStatusSchema,
  type PipelineRun,
} from "./pipeline.js";

describe("pipelineRunStatusSchema", () => {
  it("accepts valid statuses", () => {
    for (const s of ["running", "completed", "failed", "cancelled", "timeout"]) {
      expect(pipelineRunStatusSchema.parse(s)).toBe(s);
    }
  });
  it("rejects unknown statuses", () => {
    expect(() => pipelineRunStatusSchema.parse("done")).toThrow();
    expect(() => pipelineRunStatusSchema.parse("")).toThrow();
  });
});

describe("pipelineRunSchema", () => {
  it("roundtrips a valid pipeline run", () => {
    const run: PipelineRun = {
      id: newRunId(),
      projectId: newProjectId(),
      status: "running",
      goal: "build the feature",
      errorMessage: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    };
    const parsed = pipelineRunSchema.parse(run);
    expect(parsed.id).toBe(run.id);
    expect(parsed.status).toBe("running");
    expect(parsed.goal).toBe("build the feature");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.finishedAt).toBeNull();
  });

  it("roundtrips a completed run with duration", () => {
    const run: PipelineRun = {
      id: newRunId(),
      projectId: newProjectId(),
      status: "completed",
      goal: "fix bug",
      errorMessage: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:05:00.000Z",
      durationMs: 300_000,
    };
    const parsed = pipelineRunSchema.parse(run);
    expect(parsed.finishedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(parsed.durationMs).toBe(300_000);
  });

  it("roundtrips a failed run with error message", () => {
    const run: PipelineRun = {
      id: newRunId(),
      projectId: newProjectId(),
      status: "failed",
      goal: "implement X",
      errorMessage: "developer failed",
      createdAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      durationMs: 60_000,
    };
    const parsed = pipelineRunSchema.parse(run);
    expect(parsed.errorMessage).toBe("developer failed");
  });

  it("rejects missing required fields", () => {
    expect(() =>
      pipelineRunSchema.parse({ id: newRunId(), projectId: newProjectId() }),
    ).toThrow();
  });

  it("rejects invalid status", () => {
    expect(() =>
      pipelineRunSchema.parse({
        id: newRunId(),
        projectId: newProjectId(),
        status: "invalid",
        goal: "x",
        errorMessage: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
      }),
    ).toThrow();
  });
});
