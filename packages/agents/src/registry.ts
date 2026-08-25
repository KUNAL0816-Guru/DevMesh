import { agentDefinitionSchema, type AgentDefinition, type AgentDefinitionInput } from "./schema.js";

export { agentDefinitionSchema };
export type { AgentDefinition, AgentDefinitionInput, AgentPermissions } from "./schema.js";

/** Thrown for registry-level problems (unknown id, not executable, ...). */
export class AgentRegistryError extends Error {
  constructor(
    readonly code: "agent/unknown" | "agent/not-executable" | "agent/duplicate",
    message: string,
  ) {
    super(message);
    this.name = "AgentRegistryError";
  }
}

/**
 * Immutable-by-convention registry of agent definitions. The orchestrator
 * (ExecutionService) resolves everything about an agent — instructions,
 * permissions, runtime, timeout, attempt limit — from here; no agent
 * behavior is hard-coded into orchestration code.
 */
export class AgentRegistry {
  private readonly defs = new Map<string, AgentDefinition>();

  register(input: AgentDefinitionInput): AgentDefinition {
    const def = agentDefinitionSchema.parse(input);
    if (this.defs.has(def.id)) {
      throw new AgentRegistryError("agent/duplicate", `agent '${def.id}' already registered`);
    }
    this.defs.set(def.id, def);
    return def;
  }

  get(id: string): AgentDefinition | null {
    return this.defs.get(id) ?? null;
  }

  /** Resolve or throw with a stable error code. */
  require(id: string): AgentDefinition {
    const def = this.get(id);
    if (!def) throw new AgentRegistryError("agent/unknown", `no agent '${id}' registered`);
    return def;
  }

  requireExecutable(id: string): AgentDefinition {
    const def = this.require(id);
    if (!def.executable || def.runtime === "none") {
      throw new AgentRegistryError(
        "agent/not-executable",
        `agent '${id}' is defined but not executable in this phase`,
      );
    }
    return def;
  }

  list(): AgentDefinition[] {
    return [...this.defs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  listByRole(role: AgentDefinition["role"]): AgentDefinition[] {
    return this.list().filter((d) => d.role === role);
  }
}
