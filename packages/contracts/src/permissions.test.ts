import { describe, expect, it } from "vitest";
import {
  makeDenyByDefaultProfile,
  permissionResourceSchema,
  permissionSettingSchema,
  policyDecisionSchema,
} from "./permissions.js";

describe("permission profiles", () => {
  it("deny-by-default profile: read posture is explicit; non-read entries carry no value", () => {
    const profile = makeDenyByDefaultProfile();
    for (const resource of permissionResourceSchema.options) {
      if (resource === "read") {
        expect(profile[resource]).toBe("allow");
      } else {
        expect(profile[resource]).toBeUndefined();
      }
    }
  });

  it("explicit overrides win over deny-by-default", () => {
    const profile = makeDenyByDefaultProfile({
      edit: "allow",
      bash: { action: "ask", patterns: ["git *", "npm test*"] },
    });
    expect(profile.edit).toBe("allow");
    expect(profile.bash).toMatchObject({ action: "ask" });
    expect(profile.net).toBeUndefined();
    expect(profile.read).toBe("allow");
  });

  it("accepts shorthand action and pattern-scoped rule settings", () => {
    expect(permissionSettingSchema.parse("allow")).toBe("allow");
    expect(permissionSettingSchema.parse("ask")).toBe("ask");
    expect(permissionSettingSchema.parse("deny")).toBe("deny");
    expect(
      permissionSettingSchema.parse({ action: "deny", patterns: ["**/secrets/**"] }),
    ).toMatchObject({ action: "deny" });
    expect(permissionSettingSchema.parse({ action: "allow" })).toMatchObject({
      action: "allow",
    });
  });

  it("rejects empty glob lists and unknown rule actions", () => {
    expect(permissionSettingSchema.safeParse({ action: "ask", patterns: [] }).success).toBe(
      false,
    );
    expect(permissionSettingSchema.safeParse({ action: "maybe" }).success).toBe(false);
  });
});

describe("policy decision schema", () => {
  it("parses a canonical decision", () => {
    expect(
      policyDecisionSchema.parse({
        action: "deny",
        resource: "edit",
        reason: "role policy denies edit outside explicit targets",
      }),
    ).toMatchObject({ action: "deny", resource: "edit" });
  });

  it("rejects invalid actions, resources, or missing reasons", () => {
    for (const bad of [
      { action: "maybe", resource: "bash", reason: "x" },
      { action: "deny", resource: "sudo", reason: "x" },
      { action: "deny", resource: "bash" },
      { action: "deny", resource: "bash", reason: "" },
    ]) {
      expect(policyDecisionSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("covers every declared resource and preserves decision fidelity", () => {
    for (const action of ["allow", "ask", "deny"] as const) {
      for (const resource of permissionResourceSchema.options) {
        expect(policyDecisionSchema.parse({ action, resource, reason: "ok" }).action).toBe(
          action,
        );
      }
    }
  });
});