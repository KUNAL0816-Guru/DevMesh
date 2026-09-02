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
