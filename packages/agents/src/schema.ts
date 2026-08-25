import { z } from "zod";
import { agentRoleSchema } from "@devmesh/contracts";

/**
 * Declarative permissions an agent carries. Phase 3 keeps this honest but
 * small: `autoApprove` maps to the runtime's permission-approval posture
 * (OpenCode `--auto`), and `allowedOperations` documents what the agent may
 * do so the registry/auditing can reason about it.
 */
export const agentPermissionsSchema = z.strictObject({
  /**
   * When false (the safe default), headless runtimes auto-REJECT any
   * interactive permission request — the agent can only do what its
   * runtime sandbox allows without asking.
   */
  autoApprove: z.boolean().default(false),
});

export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;

/** Coarse, auditable capability tags (documentation + policy checks). */
export const allowedOperationsSchema = z
  .array(z.enum(["read_files", "write_files", "run_commands", "git_operations"]))
  .max(16);

export const agentDefinitionSchema = z.strictObject({
  /** Stable identifier, e.g. "developer". */
  id: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  role: agentRoleSchema,
  displayName: z.string().min(1).max(120),
  /** System-level instructions prepended to every task instruction. */
  systemInstructions: z.string().min(1).max(20_000),
  permissions: agentPermissionsSchema,
  allowedOperations: allowedOperationsSchema,
  /** Runtime port that executes this agent (must match AgentRuntime.name). */
  runtime: z.enum(["none", "opencode"]),
  /**
   * Optional provider/model hint ("provider/model"). Left unset in source:
   * the effective model comes from configuration at the composition root.
   */
  model: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .optional(),
  /** Per-attempt wall-clock budget for this agent. */
  timeoutMs: z.number().int().min(5_000).max(3_600_000),
  /** Max task attempts when driving a TaskCard with this agent. */
  maxAttempts: z.number().int().min(1).max(20),
  /** Only executable definitions may be started; others are config-only. */
  executable: z.boolean(),
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type AgentDefinitionInput = z.input<typeof agentDefinitionSchema>;
