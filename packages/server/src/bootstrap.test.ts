import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { startServer } from "./bootstrap.js";
import { FakeProviderGateway } from "@devmesh/runtime";

let dataRoot: string;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "devmesh-bootstrap-"));
});
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

function testConfig(overrides?: Record<string, string>) {
  return loadConfig({
    DEVMESH_DATA_ROOT: dataRoot,
    DEVMESH_LOG_LEVEL: "error",
    DEVMESH_PORT: "0",
    ...overrides,
  });
}

describe("buildProviderGateway (via startServer)", () => {
  it("default config wires a composite gateway with no adapters (provider/not-configured on use)", async () => {
    const config = testConfig();
    const server = await startServer({ config, installSignals: false });
    try {
      const gw = server.gateway;
      expect(gw).toBeDefined();
      expect(gw.name).toBe("composite");
      expect(gw.providerIds).toEqual([]);
      await expect(
        gw.complete({
          provider: "openai",
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toMatchObject({ code: "provider/not-configured" });
    } finally {
      await server.shutdown();
    }
  });

  it("gateway=openai-compatible registers an openai-compatible adapter", async () => {
    const config = testConfig({ DEVMESH_GATEWAY: "openai-compatible", DEVMESH_GATEWAY_MODEL: "openai/gpt-4o" });
    const server = await startServer({ config, installSignals: false });
    try {
      const gw = server.gateway;
      expect(gw).toBeDefined();
      expect(gw.name).toBe("composite");
      expect(gw.supportsProvider("openai")).toBe(true);
      // OpenAiCompatibleProvider is shape-only in Phase 10, so completions raise not-configured
      await expect(
        gw.complete({
          provider: "openai",
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toMatchObject({ code: "provider/not-configured" });
    } finally {
      await server.shutdown();
    }
  });

  it("opts.gateway overrides the composed gateway (for tests and tools)", async () => {
    const fake = new FakeProviderGateway({
      providerId: "test",
      models: ["test-model"],
      outcome: { content: "overridden" },
    });
    const config = testConfig();
    const server = await startServer({ config, gateway: fake, installSignals: false });
    try {
      const gw = server.gateway;
      expect(gw).toBe(fake);
      const res = await gw.complete({
        provider: "test",
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.content).toBe("overridden");
      expect(res.provider).toBe("test");
    } finally {
      await server.shutdown();
    }
  });

  it("opts.gateway=null is NOT allowed (gateway is always wired)", async () => {
    const config = testConfig();
    // null is not a valid ProviderGateway, but undefined means "use default"
    // This test confirms the default path still produces a non-null gateway
    const server = await startServer({ config, installSignals: false });
    try {
      expect(server.gateway).toBeDefined();
    } finally {
      await server.shutdown();
    }
  });
});

describe("runtime selection (buildRuntime)", () => {
  function healthEvents(server: Awaited<ReturnType<typeof startServer>>) {
    return [...server.storage.events.listAfter(0, 1000)].filter(
      (e) => e.type === "runtime.health.changed",
    );
  }

  it("runtime=opencode-local selects the local runtime and tags health with its name", async () => {
    // Port 1 is closed on virtually every host -> the local health probe fails
    // fast, but the health.changed event is still recorded with runtime.name.
    const config = testConfig({
      DEVMESH_RUNTIME: "opencode-local",
      DEVMESH_LOCAL_BASE_URL: "http://127.0.0.1:1/v1",
      DEVMESH_LOCAL_MODEL: "llama3.2",
      DEVMESH_LOCAL_TIMEOUT_MS: "1000",
    });
    const server = await startServer({ config, installSignals: false });
    try {
      const events = healthEvents(server);
      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1]!;
      expect(last.runtimeId).toBe("opencode-local");
    } finally {
      await server.shutdown();
    }
  });

  it("default runtime remains none (no runtime wired)", async () => {
    const server = await startServer({ config: testConfig(), installSignals: false });
    try {
      // No runtime wired => no runtime.health.changed event is emitted.
      expect(healthEvents(server)).toHaveLength(0);
    } finally {
      await server.shutdown();
    }
  });

  it("runtime=opencode remains the existing OpenCode path", async () => {
    // Attempting to select the OpenCode runtime still emits a health event
    // tagged with the runtime name ("opencode"), independent of whether the
    // binary is actually installed (health resolves unhealthy but is still
    // recorded with runtime.name).
    const config = testConfig({ DEVMESH_RUNTIME: "opencode" });
    const server = await startServer({ config, installSignals: false });
    try {
      const events = healthEvents(server);
      expect(events.length).toBeGreaterThanOrEqual(1);
      const last = events[events.length - 1]!;
      expect(last.runtimeId).toBe("opencode");
    } finally {
      await server.shutdown();
    }
  });

  it("rejects invalid runtime=opencode-local config missing localModel", () => {
    expect(() =>
      testConfig({
        DEVMESH_RUNTIME: "opencode-local",
        DEVMESH_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
      }),
    ).toThrow(/localModel is required/);
  });

  it("rejects invalid runtime=opencode-local config missing localBaseUrl", () => {
    expect(() =>
      testConfig({
        DEVMESH_RUNTIME: "opencode-local",
        DEVMESH_LOCAL_MODEL: "llama3.2",
      }),
    ).toThrow(/localBaseUrl is required/);
  });

  it("invalid runtime value is rejected", () => {
    expect(() => testConfig({ DEVMESH_RUNTIME: "bogus" })).toThrow(
      /invalid DevMesh configuration/,
    );
  });
});
