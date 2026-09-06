/**
 * Phase 14D: generates the plain-JS OpenCode plugin that enforces per-tool
 * permissions by delegating every tool call decision to the DevMesh control
 * plane. The generated module is written verbatim into
 * `<workspace>/.opencode/plugins/devmesh-permission.js` and auto-loaded by
 * opencode (plugins are found in `.opencode/plugins`).
 *
 * The generated code is intentionally dependency-free, self-contained ESM and
 * never interpolates untrusted values into the file (all env vars are read at
 * run time inside opencode). Standalone-safe: without DEVMESH_PLUGIN_SERVER
 * the plugin exports an empty object, so a manual opencode session in a
 * DevMesh workspace behaves normally.
 */

export const PLUGIN_REL_DIR = ".opencode/plugins";
export const PLUGIN_FILE = "devmesh-permission.js";
export const GITIGNORE_FILE = ".gitignore";
export const GITIGNORE_CONTENT = "*";
/** Server-side wait bound for a tool ASK (matches the server's ask timeout). */
export const PLUGIN_REQUEST_TIMEOUT_MS = 300_000;

function devmeshPermissionPluginModuleSource(): string {
  return [
    "// DevMesh permission enforcement plugin — packaged by @devmesh/plugin (Phase 14D).",
    "// Delegates every tool call decision to the DevMesh control plane.",
    "// Session-level 'tool.execute.before' hook: throwing denies the tool.",
    "",
    "const PLUGIN_ENV = {",
    "  server: (process.env.DEVMESH_PLUGIN_SERVER || '').replace(/\\/$/, ''),",
    "  token: process.env.DEVMESH_PLUGIN_TOKEN || '',",
    "  role: process.env.DEVMESH_AGENT_ROLE || '',",
    "  projectId: process.env.DEVMESH_PLUGIN_PROJECT_ID || '',",
    "  runId: process.env.DEVMESH_PLUGIN_RUN_ID || '',",
    "  taskId: process.env.DEVMESH_PLUGIN_TASK_ID || '',",
    "};",
    "",
    "// Tool -> permission resource (must mirror @devmesh/plugin OPENCODE_TOOL_RESOURCES).",
    "const TOOL_RESOURCES = {",
    "  read: 'read', grep: 'read', glob: 'read', lsp: 'read', skill: 'read',",
    "  todowrite: 'read', question: 'read', brain: 'read', plan: 'read',",
    "  agent: 'read', task: 'read', notify: 'read',",
    "  edit: 'edit', write: 'edit', apply_patch: 'edit',",
    "  bash: 'bash',",
    "  webfetch: 'webfetch',",
    "  websearch: 'net',",
    "};",
    "",
    "// Tool -> argument field(s) used as the decision target.",
    "const TOOL_TARGET_FIELDS = {",
    "  read: ['filePath'], edit: ['filePath'], write: ['filePath'],",
    "  apply_patch: ['patchText'], bash: ['command'],",
    "  webfetch: ['url'], websearch: ['query'],",
    "  grep: ['pattern'], glob: ['pattern'], lsp: ['operation'],",
    "  skill: ['name'], question: ['question'],",
    "  todowrite: ['description'], brain: ['key'], plan: ['id'],",
    "  agent: ['type', 'description'], task: ['type', 'description'],",
    "  notify: ['message'],",
    "};",
    "",
    "function toolTarget(tool, args) {",
    "  const fields = TOOL_TARGET_FIELDS[tool] || [];",
    "  for (const f of fields) {",
    "    const v = args && args[f];",
    "    if (typeof v === 'string' && v.trim() !== '') return v.slice(0, 2000);",
    "  }",
    "  return undefined;",
    "}",
    "",
    "function deny(message) {",
    "  throw new Error('DevMesh: permission denied — ' + message);",
    "}",
    "",
    "export const DevMeshPermission = async () => {",
    "  if (!PLUGIN_ENV.server) return {}; // standalone opencode: no enforcement",
    "",
    "  return {",
    "    'tool.execute.before': async (input, output) => {",
    "      const tool = input && input.tool ? String(input.tool) : '';",
    "      if (!tool) return;",
    "      const resource = TOOL_RESOURCES[tool];",
    "      if (!resource) {",
    "        deny(\"unknown tool '\" + tool + \"' — default-deny for unmatched operations\");",
    "        return;",
    "      }",
    "      const args = (output && output.args) || {};",
    "      const target = toolTarget(tool, args);",
    "      const body = {",
    "        role: PLUGIN_ENV.role,",
    "        tool: tool,",
    "        projectId: PLUGIN_ENV.projectId,",
    "        runId: PLUGIN_ENV.runId,",
    "      };",
    "      if (target !== undefined) body.target = target;",
    "      if (PLUGIN_ENV.taskId) body.taskId = PLUGIN_ENV.taskId;",
    "",
    "      let resp;",
    "      try {",
    "        resp = await fetch(PLUGIN_ENV.server + '/permissions/tool', {",
    "          method: 'POST',",
    "          headers: {",
    "            'content-type': 'application/json',",
    "            ...(PLUGIN_ENV.token ? { 'x-devmesh-project-token': PLUGIN_ENV.token } : {}),",
    "          },",
    "          body: JSON.stringify(body),",
    "          signal: AbortSignal.timeout(300000),",
    "        });",
    "      } catch (err) {",
    "        deny('cannot reach DevMesh control plane (' + (err && err.message ? err.message : String(err)) + ')');",
    "        return;",
    "      }",
    "",
    "      if (!resp.ok) {",
    "        deny('DevMesh control plane rejected the request (HTTP ' + resp.status + ')');",
    "        return;",
    "      }",
    "",
    "      let result;",
    "      try {",
    "        result = await resp.json();",
    "      } catch (err) {",
    "        deny('DevMesh control plane returned an unparseable response');",
    "        return;",
    "      }",
    "",
    "      if (result && result.decision === 'deny') {",
    "        deny(result.reason || 'tool not permitted');",
    "        return;",
    "      }",
    "      // FAIL CLOSED: only an explicit decision === 'allow' lets the tool run.",
    "      // 'ask' (policy wants a human decision; the standalone plugin cannot",
    "      // prompt) and any missing/malformed decision are rejected.",
    "      if (!(result && result.decision === 'allow')) {",
    "        deny('no allow decision from DevMesh control plane' +",
    "             (result && result.reason ? ' — ' + result.reason : ''));",
    "        return;",
    "      }",
    "    },",
    "  };",
    "};",
  ].join("\n");
}

/** The complete plugin module source, ready to write to disk. */
export function devmeshPermissionPluginSource(): string {
  return devmeshPermissionPluginModuleSource() + "\n";
}