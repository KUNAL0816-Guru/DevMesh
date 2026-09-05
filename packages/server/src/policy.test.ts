import { describe, expect, it } from "vitest";
import {
  baselineProfile,
  makeDenyByDefaultProfile,
  permissionResources,
  type PermissionProfile,
  type PermissionResource,
} from "@devmesh/contracts";
import {
  decisionForExecution,
  effectiveAutoApprove,
  evaluateSetting,
  matchesGlob,
  OPERATION_TO_RESOURCE,
  resourceForOperation,
} from "./policy.js";

describe("matchesGlob", () => {
  it("matches deep and single-segment wildcards with anchoring", () => {
    expect(matchesGlob("src/foo.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/a/b.ts", "src/*.ts")).toBe(false);
    expect(matchesGlob("src/a/b.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/a/b/c.ts", "src/**/*.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "src/**/*.ts")).toBe(false);
  });

  it("matches command globs used by the developer baseline", () => {
    expect(matchesGlob("git status", "git *")).toBe(true);
    expect(matchesGlob("git commit -m hi", "git *")).toBe(true);
    expect(matchesGlob("rm -rf prod", "git *")).toBe(false);
    expect(matchesGlob("npm test -- --watch", "npm test*")).toBe(true);
    expect(matchesGlob("npm run test:unit", "npm run test*")).toBe(true);
  });

  it("treats ? as a single non-separator character", () => {
    expect(matchesGlob("a.b", "a?b")).toBe(true);
    expect(matchesGlob("ab", "a?b")).toBe(false);
    expect(matchesGlob("a/b", "a?b")).toBe(false);
  });

  it("escapes regex metacharacters literally", () => {
    expect(matchesGlob("[secret].env", "[secret]*")).toBe(true);
    expect(matchesGlob("a.b", "a.b")).toBe(true);
    expect(matchesGlob("axb", "a.b")).toBe(false);
  });

  it("never partially matches: the whole target must satisfy the pattern", () => {
    expect(matchesGlob("src/deep/file.ts", "src/*")).toBe(false);
    expect(matchesGlob("src", "src/**")).toBe(false);
  });
});

describe("resourceForOperation", () => {
  it("maps declared operations to permission resources", () => {
    expect(resourceForOperation("read_files")).toBe("read");
    expect(resourceForOperation("write_files")).toBe("edit");
    expect(resourceForOperation("run_commands")).toBe("bash");
    expect(resourceForOperation("git_operations")).toBe("bash");
    expect(resourceForOperation("deploy_prod")).toBeUndefined();
  });

  it("covers exactly the schema operations", () => {
    expect(Object.keys(OPERATION_TO_RESOURCE).sort()).toEqual([
      "git_operations",
      "read_files",
      "run_commands",
      "write_files",
    ]);
  });
});

describe("evaluateSetting (run-level disposition)", () => {
  it("defaults read to allow and everything else to non-blocking when absent", () => {
    const profile = {};
    for (const resource of permissionResources) {
      if (resource === "read") {
        expect(evaluateSetting(resource, profile)).toBe("allow");
      } else {
        expect(evaluateSetting(resource, profile)).toBeUndefined();
      }
    }
  });

  it("treats the derived posture (read=allow) and absent non-read resources as absence", () => {
    const profile = makeDenyByDefaultProfile({ bash: "allow" });
    expect(evaluateSetting("net", profile)).toBeUndefined();
    expect(evaluateSetting("external_directory", profile)).toBeUndefined();
    expect(evaluateSetting("webfetch", profile)).toBeUndefined();
    expect(evaluateSetting("edit", profile)).toBeUndefined();
    expect(evaluateSetting("read", profile)).toBeUndefined();
    expect(evaluateSetting("bash", profile)).toBe("allow");
  });

  it("honors authored actions that differ from the posture", () => {
    expect(evaluateSetting("read", { read: "deny" })).toBe("deny");
    expect(evaluateSetting("edit", { edit: "ask" })).toBe("ask");
    expect(evaluateSetting("bash", { bash: "allow" })).toBe("allow");
  });

  it("honors an authored non-read shorthand deny as a real deny (Phase 14C fix)", () => {
    for (const resource of permissionResources) {
      if (resource === "read") continue;
      const profile = { [resource]: "deny" } as PermissionProfile;
      expect(evaluateSetting(resource, profile), `${resource}=deny must evaluate to deny`).toBe(
        "deny",
      );
    }
  });

  it("treats patterned rules as target-scoped (no run-level disposition)", () => {
    expect(
      evaluateSetting("bash", {
        bash: { action: "ask", patterns: ["git *"] },
      }),
    ).toBeUndefined();
  });

  it("treats unpatterned rules as authored actions", () => {
    expect(evaluateSetting("bash", { bash: { action: "deny" } })).toBe("deny");
    expect(evaluateSetting("edit", { edit: { action: "allow" } })).toBe("allow");
  });
});

describe("runDisposition and decisionForExecution", () => {
  it("allows every builtin role baseline (Phase 14C invariant)", () => {
    const roles = [
      "architect",
      "developer",
      "tester",
      "reviewer",
      "planner",
      "debugger",
      "documenter",
      "devops",
    ] as const;
    for (const role of roles) {
      const result = decisionForExecution({
        role,
        allowedOperations: [],
        profile: baselineProfile(role),
      });
      expect(result.decision, `${role} baseline must allow`).toBe("allow");
    }
  });

  it("denies a run when a resource that otherwise allows is denied", () => {
    const result = decisionForExecution({
      role: "developer",
      allowedOperations: ["read_files"],
      profile: { read: "deny", edit: "allow" },
    });
    expect(result.decision).toBe("deny");
    expect(result.reasons.some((r) => r.resource === "read" && r.action === "deny")).toBe(
      true,
    );
  });

  it("denies a run on an unpatterned deny rule", () => {
    const result = decisionForExecution({
      role: "tester",
      profile: { bash: { action: "deny" } },
    });
    expect(result.decision).toBe("deny");
  });

  it("denies a run on an authored non-read shorthand deny for every non-read resource", () => {
    const cases: Array<{ resource: PermissionResource; profile: PermissionProfile }> = [
      { resource: "edit", profile: { edit: "deny" } },
      { resource: "bash", profile: { bash: "deny" } },
      { resource: "net", profile: { net: "deny" } },
      { resource: "external_directory", profile: { external_directory: "deny" } },
      { resource: "webfetch", profile: { webfetch: "deny" } },
    ];
    for (const c of cases) {
      const result = decisionForExecution({ role: "developer", profile: c.profile });
      expect(result.decision, `${c.resource}=deny must deny the run`).toBe("deny");
      expect(
        result.reasons.some((r) => r.resource === c.resource && r.action === "deny"),
        `reasons must include the ${c.resource} deny`,
      ).toBe(true);
    }
  });

  it("gates a run on an authored ask", () => {
    const result = decisionForExecution({
      role: "developer",
      profile: { bash: "ask" },
    });
    expect(result.decision).toBe("ask");
    expect(result.reasons.some((r) => r.resource === "bash" && r.action === "ask")).toBe(
      true,
    );
  });

  it("does not gate a run on a patterned ask (target-scoped only)", () => {
    const result = decisionForExecution({
      role: "developer",
      profile: makeDenyByDefaultProfile({
        edit: "allow",
        bash: { action: "ask", patterns: ["git *"] },
      }),
    });
    expect(result.decision).toBe("allow");
  });

  it("produces reasons that satisfy the canonical decision schema", () => {
    const result = decisionForExecution({
      role: "developer",
      profile: { bash: "ask", read: "deny" },
    });
    for (const reason of result.reasons) {
      expect(["allow", "ask", "deny"]).toContain(reason.action);
      expect(permissionResources).toContain(reason.resource);
      expect(reason.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("effectiveAutoApprove", () => {
  it("only permits --auto under an explicit ALLOW decision", () => {
    expect(effectiveAutoApprove(true, "allow")).toBe(true);
    expect(effectiveAutoApprove(false, "allow")).toBe(false);
    expect(effectiveAutoApprove(true, "ask")).toBe(false);
    expect(effectiveAutoApprove(true, "deny")).toBe(false);
  });
});