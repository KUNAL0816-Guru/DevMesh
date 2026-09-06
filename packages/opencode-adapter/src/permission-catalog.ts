import type { PermissionResource } from "@devmesh/contracts";

/**
 * Phase 14D: OpenCode tool name -> contracts permission resource mapping for
 * the serve-mode broker. Vendor knowledge, confined to this package (mirrored
 * by the shipped plugin's self-contained copy in `@devmesh/plugin`).
 *
 * read-class: inspection and internal bookkeeping tools (grep/glob/skill/lsp
 * read files; todowrite/question/brain/plan/agent/task/notify are internal
 * session bookkeeping that never touches the project in a mutating way — a
 * spawned subagent's DANGEROUS leaf tools are still individually gated by the
 * same rules, so mapping the spawn tool to "read" cannot bypass policy).
 * edit-class: tools that modify the project tree.
 * bash: command execution.
 * webfetch: URL fetch; websearch: network-only abstraction.
 * Any tool NOT listed is unknown and resolves to DENY (fail closed).
 */
export const OPENCODE_TOOL_RESOURCES: Record<string, PermissionResource> = {
  read: "read",
  grep: "read",
  glob: "read",
  lsp: "read",
  skill: "read",
  todowrite: "read",
  question: "read",
  brain: "read",
  plan: "read",
  agent: "read",
  task: "read",
  notify: "read",
  edit: "edit",
  write: "edit",
  apply_patch: "edit",
  bash: "bash",
  webfetch: "webfetch",
  websearch: "net",
};

/** Per-tool argument fields that carry the decision target (order matters). */
export const OPENCODE_TOOL_TARGET_FIELDS: Record<string, string[]> = {
  read: ["filePath"],
  edit: ["filePath"],
  write: ["filePath"],
  apply_patch: ["patchText"],
  bash: ["command"],
  webfetch: ["url"],
  websearch: ["query"],
  grep: ["pattern"],
  glob: ["pattern"],
  lsp: ["operation"],
  skill: ["name"],
  question: ["question"],
  todowrite: ["description"],
  brain: ["key"],
  plan: ["id"],
  agent: ["type", "description"],
  task: ["type", "description"],
  notify: ["message"],
};

/** Map an OpenCode tool name to its permission resource. */
export function permissionResourceForTool(
  tool: string,
): PermissionResource | undefined {
  return OPENCODE_TOOL_RESOURCES[tool];
}

/**
 * Extract the decision target for a tool call: the first non-empty string
 * argument field, capped at 2000 chars. Returns undefined when the tool has
 * no field or all fields are empty — the default-deny posture then applies.
 */
export function toolTargetFor(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  const fields = OPENCODE_TOOL_TARGET_FIELDS[tool] ?? [];
  for (const field of fields) {
    const value = args[field];
    if (typeof value === "string" && value.trim() !== "") {
      return value.slice(0, 2000);
    }
  }
  return undefined;
}