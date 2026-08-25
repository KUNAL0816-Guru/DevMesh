import { describe, expect, it } from "vitest";
import { agentDefinitionSchema } from "./schema.js";
import { AgentRegistry, AgentRegistryError } from "./registry.js";
import { createDefaultAgentRegistry } from "./builtins.js";

describe("agent definition schema", () => {
  const valid = {
    id: "dev-x",
    role: "developer",
    displayName: "Dev X",
    systemInstructions: "do things well",
    permissions: { autoApprove: false },
    allowedOperations: ["read_files", "write_files"],
    runtime: "opencode",
    timeoutMs: 60_000,
    maxAttempts: 2,
    executable: true,
  };

  it("accepts a fully-specified definition", () => {
    const parsed = agentDefinitionSchema.parse(valid);
    expect(parsed.id).toBe("dev-x");
  });

  it("rejects bad model format and unknown operations", () => {
    expect(() =>
      agentDefinitionSchema.parse({ ...valid, model: "just-a-model" }),
    ).toThrow();
    expect(() =>
      agentDefinitionSchema.parse({ ...valid, allowedOperations: ["fly"] }),
    ).toThrow();
  });

  it("rejects ids with wrong shape", () => {
    expect(() => agentDefinitionSchema.parse({ ...valid, id: "Bad Id!" })).toThrow();
  });
});

describe("AgentRegistry", () => {
  it("registers, resolves and rejects duplicates/unknowns", () => {
    const reg = new AgentRegistry();
    reg.register({
      id: "a1",
      role: "tester",
      displayName: "A1",
      systemInstructions: "x",
      permissions: { autoApprove: false },
      allowedOperations: [],
      runtime: "none",
      timeoutMs: 10_000,
      maxAttempts: 1,
      executable: false,
    });
    expect(reg.get("a1")?.displayName).toBe("A1");
    expect(reg.get("nope")).toBeNull();
    expect(() => reg.require("nope")).toThrowError(AgentRegistryError);
    try {
      reg.require("nope");
      expect.unreachable();
    } catch (err) {
      expect((err as AgentRegistryError).code).toBe("agent/unknown");
    }
    try {
      reg.register({
        id: "a1",
        role: "tester",
        displayName: "dup",
        systemInstructions: "x",
        permissions: { autoApprove: false },
        allowedOperations: [],
        runtime: "none",
        timeoutMs: 10_000,
        maxAttempts: 1,
        executable: false,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as AgentRegistryError).code).toBe("agent/duplicate");
    }
  });

  it("gates execution on the executable flag", () => {
    const reg = new AgentRegistry();
    for (const [id, exec] of [
      ["ok", true],
      ["blocked", false],
    ] as const) {
      reg.register({
        id,
        role: "developer",
        displayName: id,
        systemInstructions: "x",
        permissions: { autoApprove: false },
        allowedOperations: [],
        runtime: exec ? "opencode" : "none",
        timeoutMs: 10_000,
        maxAttempts: 1,
        executable: exec,
      });
    }
    expect(reg.requireExecutable("ok").id).toBe("ok");
    try {
      reg.requireExecutable("blocked");
      expect.unreachable();
    } catch (err) {
      expect((err as AgentRegistryError).code).toBe("agent/not-executable");
    }
  });
});

describe("built-in definitions (Phase 4B)", () => {
  it("defines all four roles and all are executable", () => {
    const reg = createDefaultAgentRegistry();
    const ids = reg.list().map((d) => d.id);
    expect(ids).toEqual(["architect", "developer", "reviewer", "tester"]);

    for (const id of ["architect", "developer", "tester", "reviewer"]) {
      const def = reg.requireExecutable(id);
      expect(def.runtime).toBe("opencode");
      expect(def.systemInstructions.length).toBeGreaterThan(50);
    }
  });

  it("carries no hard-coded model constants", () => {
    const reg = createDefaultAgentRegistry();
    for (const def of reg.list()) expect(def.model).toBeUndefined();
  });

  it("respects permission profiles per agent", () => {
    const reg = createDefaultAgentRegistry();
    const architect = reg.require("architect");
    expect(architect.allowedOperations).not.toContain("write_files");
    const developer = reg.require("developer");
    expect(developer.allowedOperations).toContain("write_files");
    const tester = reg.require("tester");
    expect(tester.allowedOperations).toContain("write_files");
    const reviewer = reg.require("reviewer");
    expect(reviewer.allowedOperations).not.toContain("write_files");
  });
});
