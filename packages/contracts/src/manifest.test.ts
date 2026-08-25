import { describe, expect, it } from "vitest";
import { agentManifestSchema } from "./manifest.js";
import { makeDenyByDefaultProfile } from "./permissions.js";

const valid = {
  role: "developer",
  displayName: "Developer",
  description: "Implements tasks against the workspace",
  systemPromptFile: ".devmesh/prompts/developer.md",
  defaultModel: "anthropic/claude-sonnet-4",
  capabilities: ["read", "edit", "bash"],
  permissions: makeDenyByDefaultProfile({ edit: "allow" }),
};

describe("agentManifestSchema", () => {
  it("accepts a complete manifest", () => {
    expect(agentManifestSchema.parse(valid)).toMatchObject({ role: "developer" });
  });

  it("rejects malformed model refs", () => {
    expect(
      agentManifestSchema.safeParse({ ...valid, defaultModel: "claude-sonnet-4" }).success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(agentManifestSchema.safeParse({ ...valid, typoField: 1 }).success).toBe(false);
  });

  it("rejects empty capability lists and unknown roles", () => {
    expect(agentManifestSchema.safeParse({ ...valid, capabilities: [] }).success).toBe(false);
    expect(agentManifestSchema.safeParse({ ...valid, role: "devops" }).success).toBe(false);
  });
});
