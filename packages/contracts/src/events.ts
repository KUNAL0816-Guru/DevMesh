import { z } from "zod";
import { commitShaSchema, isoTimestampSchema } from "./common.js";
import {
  approvalIdSchema,
  artifactIdSchema,
  sessionIdSchema,
  taskIdSchema,
} from "./ids.js";
import { globPatternSchema } from "./common.js";
import { actorRoleSchema, agentRoleSchema } from "./roles.js";
import { taskCardSchema, canTransition, taskStatusSchema } from "./tasks.js";
import { artifactKindSchema } from "./artifacts.js";

/**
 * Domain events are the single feed of truth for the UI, the persistence
 * layer, and any future out-of-process subscribers (SSE fan-out).
 * Envelope fields are shared; payloads are discriminated on `type`.
 */
const eventBase = {
  seq: z.number().int().nonnegative(),
  ts: isoTimestampSchema,
  runId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  actor: actorRoleSchema.optional(),
};

export const domainEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventBase,
    type: z.literal("run.started"),
    goal: z.string().min(1).max(8000),
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.completed"),
    summary: z.string().max(4000).optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.failed"),
    reason: z.string().min(1).max(2000),
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.cancelled"),
    reason: z.string().max(2000).optional(),
  }),

  z.object({
    ...eventBase,
    type: z.literal("task.created"),
    card: taskCardSchema,
  }),
  z
    .object({
      ...eventBase,
      type: z.literal("task.transitioned"),
      taskId: taskIdSchema,
      from: taskStatusSchema,
      to: taskStatusSchema,
    })
    .refine((e) => canTransition(e.from, e.to), {
      message: "illegal task transition",
    }),

  z.object({
    ...eventBase,
    type: z.literal("artifact.recorded"),
    artifactId: artifactIdSchema,
    kind: artifactKindSchema,
    producedBy: actorRoleSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal("verification.failed"),
    artifactId: artifactIdSchema,
    failingChecks: z.number().int().positive(),
    detail: z.string().max(2000).optional(),
  }),

  z.object({
    ...eventBase,
    type: z.literal("checkpoint.created"),
    label: z.string().min(1).max(200),
    commitSha: commitShaSchema,
  }),

  z.object({
    ...eventBase,
    type: z.literal("approval.requested"),
    approvalId: approvalIdSchema,
    title: z.string().min(1).max(200),
    detail: z.string().max(4000).default(""),
    risk: z.enum(["low", "medium", "high", "critical"]),
  }),
  z.object({
    ...eventBase,
    type: z.literal("approval.resolved"),
    approvalId: approvalIdSchema,
    decision: z.enum(["allow", "deny"]),
    decidedBy: z.literal("user"),
  }),

  z.object({
    ...eventBase,
    type: z.literal("permission.requested"),
    sessionId: sessionIdSchema,
    permissionId: z.string().min(1).max(128),
    tool: z.string().min(1).max(80),
    patterns: z.array(globPatternSchema).max(64).optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("permission.resolved"),
    sessionId: sessionIdSchema,
    permissionId: z.string().min(1).max(128),
    decision: z.enum(["allow", "deny"]),
  }),

  z.object({
    ...eventBase,
    type: z.literal("agent.session.opened"),
    role: agentRoleSchema,
    sessionId: sessionIdSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal("agent.reply.completed"),
    role: agentRoleSchema,
    sessionId: sessionIdSchema,
    durationMs: z.number().int().nonnegative(),
    stoppedReason: z.enum(["end_turn", "aborted", "error", "budget_exceeded"]).optional(),
  }),

  z.object({
    ...eventBase,
    type: z.literal("runtime.health.changed"),
    runtimeId: z.literal("opencode"),
    healthy: z.boolean(),
    version: z.string().max(40).optional(),
  }),

  z.object({
    ...eventBase,
    type: z.literal("error.raised"),
    scope: z.string().min(1).max(120),
    message: z.string().min(1).max(2000),
    fatal: z.boolean(),
  }),
]);

export type DomainEvent = z.infer<typeof domainEventSchema>;
export type DomainEventInput = z.input<typeof domainEventSchema>;
export type EventType = DomainEvent["type"];

/** Omit that distributes over the event union (plain Omit collapses unions). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
/** A DomainEvent without a client-chosen seq (storage assigns it). */
export type EventInput = DistributiveOmit<DomainEvent, "seq">;

/** Parse + validate an event from untrusted input (queue, network, disk). */
export function parseEvent(input: unknown): DomainEvent {
  return domainEventSchema.parse(input);
}
