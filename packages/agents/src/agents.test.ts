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

describe("built-in definitions", () => {
  const ALL_IDS = [
    "architect",
    "debugger",
    "developer",
    "devops",
    "documenter",
    "planner",
    "reviewer",
    "tester",
  ];

  it("defines all eight roles and all are executable", () => {
    const reg = createDefaultAgentRegistry();
    const ids = reg.list().map((d) => d.id);
    expect(ids).toEqual(ALL_IDS);

    for (const id of ALL_IDS) {
      const def = reg.requireExecutable(id);
      expect(def.runtime).toBe("opencode");
      expect(def.systemInstructions.length).toBeGreaterThan(50);
      expect(def.executable).toBe(true);
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

  it("applies the approved least-privilege matrix to the new roles", () => {
    const reg = createDefaultAgentRegistry();
    const has = (id: string, op: string) =>
      reg.require(id).allowedOperations.includes(op as never);

    // planner: read only.
    const planner = reg.require("planner");
    expect(planner.allowedOperations).toEqual(["read_files"]);
    expect(planner.permissions.autoApprove).toBe(false);

    // debugger: read + diagnostics + git history, no writes.
    const debuggerDef = reg.require("debugger");
    expect(debuggerDef.allowedOperations).toEqual([
      "read_files",
      "run_commands",
      "git_operations",
    ]);
    expect(debuggerDef.permissions.autoApprove).toBe(false);

    // documenter: read + write docs, no commands/git.
    const documenter = reg.require("documenter");
    expect(documenter.allowedOperations).toEqual(["read_files", "write_files"]);
    expect(documenter.permissions.autoApprove).toBe(false);

    // devops: read + write + run + git.
    const devops = reg.require("devops");
    expect(new Set(devops.allowedOperations)).toEqual(
      new Set(["read_files", "write_files", "run_commands", "git_operations"]),
    );
    expect(devops.permissions.autoApprove).toBe(false);

    // None of the new roles gets write-only operations beyond the matrix.
    for (const id of ["planner", "debugger", "documenter", "devops"]) {
      expect(has(id, "git_operations")).toBe(
        id === "debugger" || id === "devops",
      );
      expect(has(id, "run_commands")).toBe(
        id === "debugger" || id === "devops",
      );
      expect(has(id, "write_files")).toBe(
        id === "documenter" || id === "devops",
      );
      expect(has(id, "read_files")).toBe(true);
    }
  });

  it("every new role is executable and has a non-empty prompt", () => {
    const reg = createDefaultAgentRegistry();
    for (const id of ["planner", "debugger", "documenter", "devops"]) {
      const def = reg.requireExecutable(id);
      expect(def.id).toBe(id);
      expect(def.role).toBe(id);
      expect(def.executable).toBe(true);
      expect(def.runtime).toBe("opencode");
      expect(def.systemInstructions.trim().length).toBeGreaterThan(0);
      expect(def.maxAttempts).toBe(2); // non-developer default
    }
  });
});
