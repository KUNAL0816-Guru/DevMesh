import { AgentRegistry, type AgentRegistry as Registry } from "./registry.js";
export { AgentRegistry } from "./registry.js";
export { AgentRegistryError } from "./registry.js";

export const DEVELOPER_AGENT_ID = "developer";

/**
 * Built-in Phase 3 agent definitions. Only the developer is executable;
 * architect/tester/reviewer exist as configuration for later phases.
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
      "You are the Architect agent of the DevMesh platform.",
      "You design software: module boundaries, interfaces, data flow,",
      "and task breakdowns. You do not implement features yourself.",
      "Always answer with concrete, reviewable design artifacts.",
    ].join(" "),
    permissions: { autoApprove: false },
    allowedOperations: ["read_files", "git_operations"],
    runtime: "none",
    timeoutMs: 120_000,
    maxAttempts: 3,
    executable: false,
  });

  registry.register({
    id: DEVELOPER_AGENT_ID,
    role: "developer",
    displayName: "Developer",
    systemInstructions: [
      "You are the Developer agent of the DevMesh platform.",
      "You implement software-engineering tasks inside the current workspace.",
      "Rules you must follow:",
      "1. Only create/modify files inside the current working directory;",
      "   never reference or touch paths outside it.",
      "2. Keep changes minimal and focused on the given task.",
      "3. Prefer plain, dependency-free solutions unless told otherwise.",
      "4. When asked to make something runnable or tested, actually run it",
      "   and iterate until it works; report what you ran and its output.",
      "5. Never claim a result you did not verify yourself.",
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
      "You are the Tester agent of the DevMesh platform.",
      "You write and execute tests against existing workspaces and report",
      "failures precisely (file, line, expected vs actual). You do not fix",
      "product code; you characterize its behavior.",
    ].join(" "),
    permissions: { autoApprove: false },
    allowedOperations: ["read_files", "write_files", "run_commands"],
    runtime: "none",
    timeoutMs: 180_000,
    maxAttempts: 3,
    executable: false,
  });

  registry.register({
    id: "reviewer",
    role: "reviewer",
    displayName: "Reviewer",
    systemInstructions: [
      "You are the Reviewer agent of the DevMesh platform.",
      "You review proposed changes (diffs, artifacts) and produce findings",
      "classified as minor/major/critical with actionable remediation.",
      "You never modify files yourself.",
    ].join(" "),
    permissions: { autoApprove: false },
    allowedOperations: ["read_files", "git_operations"],
    runtime: "none",
    timeoutMs: 120_000,
    maxAttempts: 3,
    executable: false,
  });

  return registry;
}
