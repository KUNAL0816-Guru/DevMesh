import { describe, expect, it } from "vitest";
import { type ProviderRequest, providerResultSchema } from "@devmesh/contracts";
import {
  CompositeProviderGateway,
  ProviderError,
  type ProviderGateway,
} from "./provider.js";
import { FakeProviderGateway } from "./fake-provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";

const baseRequest = (): ProviderRequest => ({
  provider: "fake",
  model: "fake-model",
  messages: [{ role: "user", content: "hello" }],
});

async function capture(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    return err as ProviderError;
  }
  throw new Error("expected promise to reject");
}

describe("ProviderGateway port contract", () => {
  it("is satisfied by the fake gateway", () => {
    const gateway: ProviderGateway = new FakeProviderGateway();
    expect(gateway.name).toBe("fake-provider");
    expect(gateway.providerIds).toEqual(["fake"]);
    expect(gateway.supportsProvider("fake")).toBe(true);
    expect(gateway.supportsProvider("openai")).toBe(false);
  });
});

describe("FakeProviderGateway", () => {
  it("returns the scripted result and echoes provider/model", async () => {
    const gateway = new FakeProviderGateway({
      outcome: { content: "the answer", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } },
    });
    const res = await gateway.complete(baseRequest());
    expect(providerResultSchema.parse(res)).toEqual(res);
    expect(res.provider).toBe("fake");
    expect(res.model).toBe("fake-model");
    expect(res.content).toBe("the answer");
    expect(res.finishReason).toBe("stop");
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("passes the exact request through", async () => {
    const gateway = new FakeProviderGateway();
    const req = { ...baseRequest(), maxTokens: 500 };
    await gateway.complete(req);
    expect(gateway.lastRequest).toEqual(req);
  });

  it("throws provider/unknown for an unregistered provider (no fallback)", async () => {
    const gateway = new FakeProviderGateway();
    const err = await capture(gateway.complete({ ...baseRequest(), provider: "openai" }));
    expect(err.name).toBe("ProviderError");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("provider/unknown");
    expect(err.details).toEqual({ provider: "openai" });
  });

  it("throws provider/model-unknown for a known provider with an unsupported model", async () => {
    const gateway = new FakeProviderGateway();
    await expect(gateway.complete({ ...baseRequest(), model: "claude-sonnet-4" })).rejects.toMatchObject({
      code: "provider/model-unknown",
      details: { provider: "fake", model: "claude-sonnet-4" },
    });
  });

  it("can script a deterministic provider failure", async () => {
    const gateway = new FakeProviderGateway({ failure: "provider/unavailable" });
    await expect(gateway.complete(baseRequest())).rejects.toMatchObject({
      code: "provider/unavailable",
    });
  });
});

describe("CompositeProviderGateway", () => {
  it("routes to the registered adapter by provider id", async () => {
    const gateway = new CompositeProviderGateway().register(
      new FakeProviderGateway({ providerId: "fake", outcome: { content: "composite ok" } }),
    );
    expect(gateway.providerIds).toEqual(["fake"]);
    const res = await gateway.complete(baseRequest());
    expect(res.content).toBe("composite ok");
  });

  it("throws provider/not-configured when no backend is wired", async () => {
    const gateway = new CompositeProviderGateway();
    await expect(gateway.complete(baseRequest())).rejects.toMatchObject({
      code: "provider/not-configured",
    });
  });

  it("throws provider/unknown for an unregistered provider even with a backend", async () => {
    const gateway = new CompositeProviderGateway().register(new FakeProviderGateway());
    await expect(gateway.complete({ ...baseRequest(), provider: "openai" })).rejects.toMatchObject({
      code: "provider/unknown",
    });
  });

  it("rejects duplicate provider registration", async () => {
    const gateway = new CompositeProviderGateway().register(new FakeProviderGateway());
    expect(() => gateway.register(new FakeProviderGateway())).toThrowError(ProviderError);
  });

  it("rejects unknown models from an adapter with a declared catalog", async () => {
    const gateway = new CompositeProviderGateway().register(
      new FakeProviderGateway({ models: ["a", "b"] }),
    );
    await expect(gateway.complete({ ...baseRequest(), model: "zzz" })).rejects.toMatchObject({
      code: "provider/model-unknown",
    });
  });

  it("validates the request at the boundary", async () => {
    const gateway = new CompositeProviderGateway().register(new FakeProviderGateway());
    const err = await capture(
      gateway.complete({ provider: "fake", model: "fake-model", messages: [] } as ProviderRequest),
    );
    expect(err.code).toBe("provider/invalid-request");
  });
});

describe("OpenAiCompatibleProvider (Phase 10: shape-only)", () => {
  it("serves the configured provider id", () => {
    const p = new OpenAiCompatibleProvider({ providerId: "openai" });
    expect(p.name).toBe("openai-compatible");
    expect(p.providerIds).toEqual(["openai"]);
    expect(p.supportsProvider("openai")).toBe(true);
  });

  it("serves no provider when unconfigured", () => {
    const p = new OpenAiCompatibleProvider();
    expect(p.providerIds).toEqual([]);
    expect(p.supportsProvider("openai")).toBe(false);
  });

  it("is not wired for live completions in Phase 10", async () => {
    const p = new OpenAiCompatibleProvider({ providerId: "openai" });
    await expect(
      p.complete({
        provider: "openai",
        model: "gpt-4o",
        messages: [{ role: "user", content: "ping" }],
      }),
    ).rejects.toMatchObject({ code: "provider/not-configured" });
  });
});