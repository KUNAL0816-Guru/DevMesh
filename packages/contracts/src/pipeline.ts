import { z } from "zod";
import { isoTimestampSchema } from "./common.js";
import type { ProjectId, RunId } from "./ids.js";
import { projectIdSchema, runIdSchema } from "./ids.js";

export const pipelineRunStatuses = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const;

export const pipelineRunStatusSchema = z.enum(pipelineRunStatuses);
export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;

export const pipelineRunSchema = z.strictObject({
  id: runIdSchema,
  projectId: projectIdSchema,
  status: pipelineRunStatusSchema,
  goal: z.string().min(1).max(8000),
  errorMessage: z.string().max(2000).nullable(),
  createdAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});

export type PipelineRun = z.infer<typeof pipelineRunSchema>;

export interface PipelineRunInput {
  id: RunId;
  projectId: ProjectId;
  status: PipelineRunStatus;
  goal: string;
  errorMessage?: string | null;
  createdAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
}
