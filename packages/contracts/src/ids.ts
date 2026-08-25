import { z } from "zod";

export const projectIdSchema = z.uuid().brand<"ProjectId">();
export type ProjectId = z.infer<typeof projectIdSchema>;

export const runIdSchema = z.uuid().brand<"RunId">();
export type RunId = z.infer<typeof runIdSchema>;

export const taskIdSchema = z.uuid().brand<"TaskId">();
export type TaskId = z.infer<typeof taskIdSchema>;

export const artifactIdSchema = z.uuid().brand<"ArtifactId">();
export type ArtifactId = z.infer<typeof artifactIdSchema>;

export const approvalIdSchema = z.uuid().brand<"ApprovalId">();
export type ApprovalId = z.infer<typeof approvalIdSchema>;

/** Opaque session identifier as assigned by the agent runtime (not a UUID). */
export const sessionIdSchema = z.string().min(1).max(128).brand<"SessionId">();
export type SessionId = z.infer<typeof sessionIdSchema>;

export const contextEntryIdSchema = z.uuid().brand<"ContextEntryId">();
export type ContextEntryId = z.infer<typeof contextEntryIdSchema>;

const uuid = (): string => crypto.randomUUID();

export const newProjectId = (): ProjectId => projectIdSchema.parse(uuid());
export const newRunId = (): RunId => runIdSchema.parse(uuid());
export const newTaskId = (): TaskId => taskIdSchema.parse(uuid());
export const newArtifactId = (): ArtifactId => artifactIdSchema.parse(uuid());
export const newApprovalId = (): ApprovalId => approvalIdSchema.parse(uuid());
export const newSessionId = (raw: string): SessionId =>
  sessionIdSchema.parse(raw);
export const newContextEntryId = (): ContextEntryId =>
  contextEntryIdSchema.parse(uuid());
