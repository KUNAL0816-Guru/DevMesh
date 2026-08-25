import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

export const configSchema = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().min(0).max(65535).default(7601),
  /** Root directory for DevMesh state: SQLite db + managed workspaces. */
  dataRoot: z
    .string()
    .min(1)
    .default(resolve(homedir(), ".devmesh")),
  logLevel: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  /** Which agent runtime to wire at the composition root ("none" = disabled). */
  runtime: z.enum(["none", "opencode"]).default("none"),
  /** Binary used by the OpenCode adapter (PATH-resolvable or absolute). */
  opencodeBin: z.string().min(1).default("opencode"),
  /**
   * Approve OpenCode permission requests (--auto). Default false: the
   * headless CLI then auto-rejects tool permission requests.
   */
  opencodeAutoApprove: z.boolean().default(false),
  /**
   * Provider/model passed to OpenCode as `-m provider/model` (req 9/10:
   * comes from configuration, never a source-code constant, and no
   * credentials ever flow through DevMesh — auth stays in opencode's own
   * credential store).
   */
  opencodeModel: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "expected provider/model")
    .optional(),
  /** Hard wall-clock budget for a single agent execution. */
  execTimeoutMs: z.number().int().min(1000).max(3_600_000).default(300_000),
});

export type Config = z.infer<typeof configSchema>;

/**
 * Load configuration from the environment (all optional):
 *   DEVMESH_HOST, DEVMESH_PORT, DEVMESH_DATA_ROOT, DEVMESH_LOG_LEVEL,
 *   DEVMESH_RUNTIME, DEVMESH_OPENCODE_BIN, DEVMESH_OPENCODE_AUTO_APPROVE,
 *   DEVMESH_EXEC_TIMEOUT_MS
 * Throws a plain Error with a readable message on invalid values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    host: env.DEVMESH_HOST,
    port: env.DEVMESH_PORT === undefined ? undefined : Number(env.DEVMESH_PORT),
    dataRoot: env.DEVMESH_DATA_ROOT,
    logLevel: env.DEVMESH_LOG_LEVEL,
    runtime: env.DEVMESH_RUNTIME,
    opencodeBin: env.DEVMESH_OPENCODE_BIN,
    opencodeAutoApprove:
      env.DEVMESH_OPENCODE_AUTO_APPROVE === undefined
        ? undefined
        : ["1", "true", "yes"].includes(env.DEVMESH_OPENCODE_AUTO_APPROVE.toLowerCase()),
    opencodeModel: env.DEVMESH_OPENCODE_MODEL || undefined,
    execTimeoutMs:
      env.DEVMESH_EXEC_TIMEOUT_MS === undefined
        ? undefined
        : Number(env.DEVMESH_EXEC_TIMEOUT_MS),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid DevMesh configuration — ${issues}`);
  }
  return parsed.data;
}

export function databasePath(config: Config): string {
  return resolve(config.dataRoot, "devmesh.db");
}

export function workspacesRoot(config: Config): string {
  return resolve(config.dataRoot, "workspaces");
}
