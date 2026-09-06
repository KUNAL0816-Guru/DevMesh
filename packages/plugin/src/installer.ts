import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GITIGNORE_CONTENT,
  GITIGNORE_FILE,
  PLUGIN_FILE,
  PLUGIN_REL_DIR,
  devmeshPermissionPluginSource,
} from "./plugin-source.js";

/**
 * Install the DevMesh permission enforcement plugin into an opencode workspace
 * root. Writes `.opencode/plugins/devmesh-permission.js` plus a `.gitignore`
 * containing `*` so plugin artifacts never show up in the managed project's
 * git status. Idempotent: overwriting is safe and cheap.
 */
export function installPlugin(root: string): void {
  const dir = join(root, PLUGIN_REL_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, PLUGIN_FILE), devmeshPermissionPluginSource(), "utf8");
  writeFileSync(join(dir, GITIGNORE_FILE), GITIGNORE_CONTENT, "utf8");
}

export interface PluginEnvConfig {
  /** Control-plane base URL the plugin calls (no trailing slash). */
  serverUrl: string;
  /** Per-project plugin token (sent as x-devmesh-project-token). */
  token?: string;
  /** Agent role driving the run (policy lookup). */
  role: string;
  /** Project id the plugin tags its requests with. */
  projectId: string;
  /** Pipeline run id the plugin tags its requests with. */
  runId: string;
  /** Optional task id within the run. */
  taskId?: string;
}

/**
 * Environment variables passed to the opencode child process to activate the
 * installed plugin. When `serverUrl` is absent the caller should not pass these
 * at all — the plugin then exports a no-op.
 */
export function pluginEnvVars(config: PluginEnvConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    DEVMESH_PLUGIN_SERVER: config.serverUrl,
    DEVMESH_AGENT_ROLE: config.role,
    DEVMESH_PLUGIN_PROJECT_ID: config.projectId,
    DEVMESH_PLUGIN_RUN_ID: config.runId,
  };
  if (config.token) env.DEVMESH_PLUGIN_TOKEN = config.token;
  if (config.taskId) env.DEVMESH_PLUGIN_TASK_ID = config.taskId;
  return env;
}