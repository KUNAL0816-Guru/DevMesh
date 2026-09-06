import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITIGNORE_CONTENT,
  GITIGNORE_FILE,
  OPENCODE_TOOL_RESOURCES,
  PLUGIN_FILE,
  PLUGIN_REL_DIR,
  TOOL_TARGET_FIELDS,
  devmeshPermissionPluginSource,
  installPlugin,
  permissionResourceForTool,
  pluginEnvVars,
  toolTargetFor,
} from "./index.js";

const KNOWN_TOOLS = {
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

describe("permissionResourceForTool", () => {
  it("maps every known tool to its resource class", () => {
    for (const [tool, resource] of Object.entries(KNOWN_TOOLS)) {
      expect(permissionResourceForTool(tool)).toBe(resource);
    }
  });

  it("returns undefined for unknown tools (default-deny at the endpoint)", () => {
    expect(permissionResourceForTool("some_future_tool")).toBeUndefined();
    expect(permissionResourceForTool("")).toBeUndefined();
  });

  it("OPENCODE_TOOL_RESOURCES covers exactly the known tool names", () => {
    expect(Object.keys(OPENCODE_TOOL_RESOURCES).sort()).toEqual(
      Object.keys(KNOWN_TOOLS).sort(),
    );
  });
});

describe("toolTargetFor", () => {
  it("extracts the configured field for each tool", () => {
    expect(toolTargetFor("bash", { command: "npm test" })).toBe("npm test");
    expect(toolTargetFor("edit", { filePath: "src/a.ts" })).toBe("src/a.ts");
    expect(toolTargetFor("webfetch", { url: "https://example.com" })).toBe(
      "https://example.com",
    );
    expect(toolTargetFor("websearch", { query: "devmesh" })).toBe("devmesh");
    expect(toolTargetFor("apply_patch", { patchText: "--- a\n+++ b\n" })).toBe(
      "--- a\n+++ b\n",
    );
  });

  it("falls back to the next field when the first is missing/empty", () => {
    expect(
      toolTargetFor("task", { type: "", description: "write tests" }),
    ).toBe("write tests");
    expect(
      toolTargetFor("agent", { description: "spawn dev" }),
    ).toBe("spawn dev");
  });

  it("returns undefined when there is no matching non-empty field", () => {
    expect(toolTargetFor("bash", {})).toBeUndefined();
    expect(toolTargetFor("bash", { command: "   " })).toBeUndefined();
    expect(toolTargetFor("edit", { filePath: 42 })).toBeUndefined();
    expect(toolTargetFor("unknown_tool", { command: "ls" })).toBeUndefined();
  });

  it("caps the target at 2000 characters", () => {
    const long = "x".repeat(5000);
    expect(toolTargetFor("bash", { command: long })).toHaveLength(2000);
    expect(TOOL_TARGET_FIELDS).toBeDefined();
  });
});

describe("devmeshPermissionPluginSource", () => {
  it("produces a syntactically valid ESM module exporting DevMeshPermission", async () => {
    const source = devmeshPermissionPluginSource();
    expect(source).toContain("export const DevMeshPermission");
    expect(source).toContain("'tool.execute.before'");
    expect(source).toContain("AbortSignal.timeout(300000)");
    // Must parse cleanly as a module and export the plugin hook.
    const mod = (await import(`data:text/javascript,${encodeURIComponent(source)}`)) as {
      DevMeshPermission?: unknown;
    };
    expect(typeof mod.DevMeshPermission).toBe("function");
  });

  it("never embeds env values via template-literal interpolation", () => {
    const source = devmeshPermissionPluginSource();
    // The generated file reads env at runtime (process.env lookups are the
    // DESIGN — nothing is baked in); it must not interpolate any values into
    // the shipped source.
    expect(source).not.toMatch(/\$\{/);
    expect(source).toContain("process.env.DEVMESH_PLUGIN_SERVER");
    expect(source).toContain("process.env.DEVMESH_PLUGIN_TOKEN");
  });
});

describe("installPlugin", () => {
  it("writes the plugin files under .opencode/plugins", () => {
    const root = mkdtempSync(join(tmpdir(), "devmesh-plugin-"));
    try {
      installPlugin(root);
      const dir = join(root, PLUGIN_REL_DIR);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, PLUGIN_FILE))).toBe(true);
      expect(existsSync(join(dir, GITIGNORE_FILE))).toBe(true);
      expect(readFileSync(join(dir, GITIGNORE_FILE), "utf8")).toBe(
        GITIGNORE_CONTENT,
      );
      expect(readFileSync(join(dir, PLUGIN_FILE), "utf8")).toBe(
        devmeshPermissionPluginSource(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is idempotent across repeated calls", () => {
    const root = mkdtempSync(join(tmpdir(), "devmesh-plugin-"));
    try {
      installPlugin(root);
      const first = readFileSync(
        join(root, PLUGIN_REL_DIR, PLUGIN_FILE),
        "utf8",
      );
      installPlugin(root);
      const second = readFileSync(
        join(root, PLUGIN_REL_DIR, PLUGIN_FILE),
        "utf8",
      );
      expect(second).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pluginEnvVars", () => {
  it("builds the minimal active-env (omits absent optionals)", () => {
    const env = pluginEnvVars({
      serverUrl: "http://127.0.0.1:7601",
      role: "developer",
      projectId: "00000000-0000-0000-0000-000000000001",
      runId: "00000000-0000-0000-0000-000000000002",
    });
    expect(env.DEVMESH_PLUGIN_SERVER).toBe("http://127.0.0.1:7601");
    expect(env.DEVMESH_AGENT_ROLE).toBe("developer");
    expect(env.DEVMESH_PLUGIN_PROJECT_ID).toBe(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(env.DEVMESH_PLUGIN_RUN_ID).toBe(
      "00000000-0000-0000-0000-000000000002",
    );
    expect(env.DEVMESH_PLUGIN_TOKEN).toBeUndefined();
    expect(env.DEVMESH_PLUGIN_TASK_ID).toBeUndefined();
  });

  it("includes token and taskId when provided", () => {
    const env = pluginEnvVars({
      serverUrl: "http://127.0.0.1:7601",
      token: "dpk_abc123",
      role: "tester",
      projectId: "p",
      runId: "r",
      taskId: "t",
    });
    expect(env.DEVMESH_PLUGIN_TOKEN).toBe("dpk_abc123");
    expect(env.DEVMESH_PLUGIN_TASK_ID).toBe("t");
  });
});

// ---------------------------------------------------------------------------
// Behavior tests: execute the GENERATED plugin module with a mocked control
// plane and assert enforcement (Phase 14D corrective: fail closed — ONLY an
// explicit { decision: "allow" } lets a tool run).
// ---------------------------------------------------------------------------

const PLUGIN_ENV_KEYS = [
  "DEVMESH_PLUGIN_SERVER",
  "DEVMESH_PLUGIN_TOKEN",
  "DEVMESH_AGENT_ROLE",
  "DEVMESH_PLUGIN_PROJECT_ID",
  "DEVMESH_PLUGIN_RUN_ID",
  "DEVMESH_PLUGIN_TASK_ID",
];

async function invokeToolDecision(opts: {
  env: Record<string, string>;
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  tool: string;
  args?: Record<string, unknown>;
}): Promise<{ rejected: boolean; error?: string }> {
  const saved = new Map<string, string | undefined>();
  for (const key of PLUGIN_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(opts.env)) process.env[key] = value;
  const realFetch = globalThis.fetch;
  globalThis.fetch = opts.fetchImpl as typeof fetch;
  try {
    // Fresh module instance per call (unique nonce) so PLUGIN_ENV is captured
    // from the current process.env and never reused across tests.
    const nonce = Math.random().toString(36).slice(2);
    const mod = (await import(
      `data:text/javascript,${encodeURIComponent(
        devmeshPermissionPluginSource() + `\n// invoked-with-${nonce}`,
      )}`
    )) as {
      DevMeshPermission?: () => Promise<Record<string, (input: unknown, output: unknown) => Promise<unknown>>>;
    };
    const hooks = await mod.DevMeshPermission!();
    const hook = hooks["tool.execute.before"]!;
    try {
      await hook({ tool: opts.tool }, { args: opts.args ?? {} });
      return { rejected: false };
    } catch (err) {
      return { rejected: true, error: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

const ACTIVE_ENV = {
  DEVMESH_PLUGIN_SERVER: "http://127.0.0.1:7601",
  DEVMESH_PLUGIN_TOKEN: "dpk_test_token",
  DEVMESH_AGENT_ROLE: "developer",
  DEVMESH_PLUGIN_PROJECT_ID: "00000000-0000-0000-0000-000000000001",
  DEVMESH_PLUGIN_RUN_ID: "00000000-0000-0000-0000-000000000002",
};

describe("generated plugin enforcement (Phase 14D fail-closed)", () => {
  it("lets the tool run ONLY on an explicit allow decision", async () => {
    const out = await invokeToolDecision({
      env: ACTIVE_ENV,
      fetchImpl: () => jsonResponse(200, { decision: "allow", reason: "ok" }),
      tool: "bash",
      args: { command: "npm test" },
    });
    expect(out).toEqual({ rejected: false });
  });

  it("denies on an explicit deny decision", async () => {
    const out = await invokeToolDecision({
      env: ACTIVE_ENV,
      fetchImpl: () => jsonResponse(200, { decision: "deny", reason: "blocked" }),
      tool: "bash",
      args: { command: "rm -rf /" },
    });
    expect(out.rejected).toBe(true);
    expect(out.error).toContain("blocked");
  });

  it("denies on an ask decision (standalone plugin cannot prompt)", async () => {
    const out = await invokeToolDecision({
      env: ACTIVE_ENV,
      fetchImpl: () => jsonResponse(200, { decision: "ask", reason: "human check" }),
      tool: "bash",
      args: { command: "git push" },
    });
    expect(out.rejected).toBe(true);
    expect(out.error).toContain("no allow decision");
  });

  it("denies on HTTP 200 with NO decision field (absent decision never = allow)", async () => {
    const out = await invokeToolDecision({
      env: ACTIVE_ENV,
      fetchImpl: () => jsonResponse(200, { reason: "no decision present" }),
      tool: "bash",
    });
    expect(out.rejected).toBe(true);
    expect(out.error).toContain("no allow decision");
  });

  it("denies on an unknown decision value", async () => {
    const out = await invokeToolDecision({
      env: ACTIVE_ENV,
      fetchImpl: () => jsonResponse(200, { decision: "maybe", reason: "???" }),
      tool: "bash",
    });
    expect(out.rejected).toBe(true);
  });

  it("denies on malformed JSON responses", async () => {
    const out = await invokeToolDecision({
      env: ACTIVE_ENV,
      fetchImpl: () =>
        Promise.resolve(
          new Response("not json at all {", { status: 200 }),
        ),
      tool: "bash",
    });
    expect(out.rejected).toBe(true);
    expect(out.error).toContain("unparseable");
  });

  it("denies on non-2xx responses (401/500)", async () => {
    for (const status of [401, 500]) {
      const out = await invokeToolDecision({
        env: ACTIVE_ENV,
        fetchImpl: () => jsonResponse(status, { error: { code: "x", message: "boom" } }),
        tool: "bash",
      });
      expect(out.rejected).toBe(true);
      expect(out.error).toContain(`HTTP ${status}`);
    }
  });

  it("denies when the control plane is unreachable", async () => {
    const out = await invokeToolDecision({
      env: ACTIVE_ENV,
      fetchImpl: () => {
        throw new Error("ECONNREFUSED");
      },
      tool: "bash",
    });
    expect(out.rejected).toBe(true);
    expect(out.error).toContain("cannot reach DevMesh control plane");
  });

  it("denies unknown tools with no network request (default deny)", async () => {
    let called = false;
    const out = await invokeToolDecision({
      env: ACTIVE_ENV,
      fetchImpl: () => {
        called = true;
        return jsonResponse(200, { decision: "allow" });
      },
      tool: "some_future_tool",
    });
    expect(called).toBe(false);
    expect(out.rejected).toBe(true);
    expect(out.error).toContain("unknown tool");
  });

  it("sends the project token header when configured", async () => {
    let sentHeader = "";
    await invokeToolDecision({
      env: ACTIVE_ENV,
      fetchImpl: (_input, init) => {
        sentHeader = String(
          (init?.headers as Record<string, string> | undefined)?.["x-devmesh-project-token"] ?? "",
        );
        return jsonResponse(200, { decision: "allow" });
      },
      tool: "bash",
      args: { command: "ls" },
    });
    expect(sentHeader).toBe("dpk_test_token");
  });
});