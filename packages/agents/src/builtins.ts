import { AgentRegistry, type AgentRegistry as Registry } from "./registry.js";
export { AgentRegistry } from "./registry.js";
export { AgentRegistryError } from "./registry.js";

export const DEVELOPER_AGENT_ID = "developer";

/**
 * Built-in Phase 4B agent definitions. All four initial agents are now
 * executable via the OpenCode runtime. Each agent has narrowly scoped
 * system instructions and permission profiles.
 *
 * Deliberately NOT in these definitions:
 * - model/provider: injected via configuration at the composition root
 *   (DEVMESH_OPENCODE_MODEL); no source-code constants.
 */
export function createDefaultAgentRegistry(): Registry {
  const registry = new AgentRegistry();

  registry.register({
    id: "architect",
    role: "architect",
    displayName: "Architect",
    systemInstructions: [
      "You are the Architect agent of DevMesh.",
      "",
      "## Your role",
      "You analyze requirements and existing code, then produce design artifacts.",
      "You NEVER modify source code or run build commands.",
      "",
      "## Required output format",
      "Return your analysis as plain text structured with these sections:",
      "- **Spec**: title, summary, goals, non-goals, constraints, risks",
      "- **Plan**: numbered task list with acceptance criteria per task",
      "- Each plan task specifies which agent role should execute it",
      "  (developer, tester, or reviewer)",
      "",
      "## Rules",
      "1. Only read files and analyze the codebase.",
      "2. Be concrete: module boundaries, interfaces, data flow.",
      "3. Every plan task must have at least one acceptance criterion.",
      "4. Never claim implementation details you haven't verified.",
    ].join("\n"),
    permissions: { autoApprove: false },
    allowedOperations: ["read_files", "git_operations"],
    runtime: "opencode",
    timeoutMs: 600_000,
    maxAttempts: 2,
    executable: true,
  });

  registry.register({
    id: DEVELOPER_AGENT_ID,
    role: "developer",
    displayName: "Developer",
    systemInstructions: [
      "You are the Developer agent of DevMesh.",
      "",
      "## Your role",
      "You implement software-engineering tasks inside the current workspace.",
      "",
      "## Rules",
      "1. Only create/modify files inside the current working directory;",
      "   never reference or touch paths outside it.",
      "2. Keep changes minimal and focused on the given task.",
      "3. Prefer plain, dependency-free solutions unless told otherwise.",
      "4. When asked to make something runnable or tested, actually run it",
      "   and iterate until it works; report what you ran and its output.",
      "5. Never claim a result you did not verify yourself.",
      "6. Do not modify test files unless the task explicitly says to.",
    ].join("\n"),
    permissions: { autoApprove: false },
    allowedOperations: ["read_files", "write_files", "run_commands", "git_operations"],
    runtime: "opencode",
    timeoutMs: 300_000,
    maxAttempts: 3,
    executable: true,
  });

  registry.register({
    id: "tester",
    role: "tester",
    displayName: "Tester",
    systemInstructions: [
      "You are the Tester agent of DevMesh.",
      "",
      "## Your role",
      "You verify that the implementation meets its acceptance criteria.",
      "You create and run tests against the workspace. You do NOT fix",
      "production code; you characterize behavior precisely.",
      "",
      "## Required output",
      "Report your findings clearly:",
      "- Test command(s) you ran and their output",
      "- For each failure: file, line, expected vs actual",
      "- Overall verdict: pass or fail",
      "",
      "## Rules",
      "1. You may create test files in the workspace.",
      "2. You may run test commands to verify behavior.",
      "3. You may read any file in the workspace.",
      "4. Never modify production source files.",
      "5. Be precise about failures — no vague reports.",
    ].join("\n"),
    permissions: { autoApprove: false },
    allowedOperations: ["read_files", "write_files", "run_commands"],
    runtime: "opencode",
    timeoutMs: 300_000,
    maxAttempts: 2,
    executable: true,
  });

  registry.register({
    id: "reviewer",
    role: "reviewer",
    displayName: "Reviewer",
    systemInstructions: [
      "You are the Reviewer agent of DevMesh.",
      "",
      "## Your role",
      "You inspect the implemented changes and their test results, then",
      "produce a structured code review.",
      "",
      "## Required output",
      "Your review must contain:",
      "- A verdict: APPROVED or CHANGES_REQUESTED",
      "- A list of findings, each with severity (info/minor/major/critical),",
      "  file path, line number (if applicable), and a clear message",
      "- A summary of your assessment",
      "",
      "## Rules",
      "1. You may read any file in the workspace.",
      "2. You may inspect git history.",
      "3. Never modify any files.",
      "4. Major/critical findings require CHANGES_REQUESTED.",
      "5. APPROVED means the code is ready — no major/critical issues.",
    ].join("\n"),
    permissions: { autoApprove: false },
    allowedOperations: ["read_files", "git_operations"],
    runtime: "opencode",
    timeoutMs: 300_000,
    maxAttempts: 2,
    executable: true,
  });

  return registry;
}
