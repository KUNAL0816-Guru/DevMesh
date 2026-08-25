import { z } from "zod";
import { isoTimestampSchema } from "./common.js";
import {
  artifactIdSchema,
  projectIdSchema,
  runIdSchema,
  taskIdSchema,
} from "./ids.js";
import { agentRoleSchema } from "./roles.js";

export const taskStatuses = [
  "pending",
  "ready",
  "running",
  "in_review",
  "revising",
  "done",
  "failed",
  "blocked",
  "cancelled",
] as const;
export const taskStatusSchema = z.enum(taskStatuses);
export type TaskStatus = (typeof taskStatuses)[number];

export const TASK_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskStatus[]>
> = {
  pending: ["ready", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["in_review", "failed", "blocked", "cancelled"],
  in_review: ["done", "revising", "failed", "cancelled"],
  revising: ["running", "cancelled"],
  blocked: ["ready", "cancelled"],
  done: [],
  failed: ["ready", "cancelled"],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`illegal task transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export const taskCardSchema = z.object({
  id: taskIdSchema,
  runId: runIdSchema,
  projectId: projectIdSchema,
  role: agentRoleSchema,
  title: z.string().min(3).max(200),
  detail: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).max(50),
  dependsOn: z.array(taskIdSchema).max(50),
  status: taskStatusSchema,
  attempts: z.number().int().min(0).default(0),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  /** Artifacts produced for/against this task so far. */
  artifacts: z.array(artifactIdSchema).default([]),
});
export type TaskCard = z.infer<typeof taskCardSchema>;
export type TaskCardInput = z.input<typeof taskCardSchema>;

/** Convenience constructor filling timestamps and defaults. */
export function makeTaskCard(
  input: Omit<TaskCardInput, "id" | "createdAt" | "updatedAt" | "attempts"> & {
    id?: ReturnType<typeof taskIdSchema.parse>;
  },
): TaskCard {
  const now = new Date().toISOString();
  return taskCardSchema.parse({
    ...input,
    id: input.id ?? taskIdSchema.parse(crypto.randomUUID()),
    createdAt: now,
    updatedAt: now,
  });
}
