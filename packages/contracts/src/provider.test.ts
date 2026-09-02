import { describe, expect, it } from "vitest";
import {
  modelIdSchema,
  parseProviderModelRef,
  providerIdSchema,
  providerMessageListSchema,
  providerModelRefSchema,
  providerRequestSchema,
  providerResultSchema,
} from "./provider.js";

describe("provider/model-id (neutral preference)", () => {
  it("accepts provider-independent neutral refs", () => {
    for (const ref of [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "ollama/llama3.1",
      "local/my-model",
      "anyvendor/some.model-v2",
    ]) {
      expect(providerModelRefSchema.parse(ref)).toBe(ref);
    }
  });

  it("is purely syntactic — no vendor allow-list", () => {
    expect(providerModelRefSchema.parse("fictitious-vendor/any-model")).toBe(
      "fictitious-vendor/any-model",
    );
  });

  it("rejects malformed neutral refs", () => {
    for (const ref of [
      "claude-sonnet-4", // no provider/model separator
      "anthropic/", // empty model segment
      "/gpt-4o", // empty provider segment
      "a/b/c", // model segment contains a slash
      "open ai/x", // whitespace in provider
      "x/ y", // whitespace in model
      "anthropic/claude-sonnet-4/", // trailing slash
    ]) {
      expect(() => providerModelRefSchema.parse(ref)).toThrow();
    }
  });

  it("validates provider and model segments individually", () => {
    expect(providerIdSchema.parse("anthropic")).toBe("anthropic");
    expect(modelIdSchema.parse("claude-sonnet-4")).toBe("claude-sonnet-4");
    expect(() => providerIdSchema.parse(".anthropic")).toThrow();
    expect(() => providerIdSchema.parse("anthropic/openai")).toThrow();
    expect(() => modelIdSchema.parse("claude/4")).toThrow();
    expect(() => modelIdSchema.parse("")).toThrow();
  });
});

describe("parseProviderModelRef", () => {
  it("splits a neutral ref into provider and model", () => {
    expect(parseProviderModelRef("anthropic/claude-sonnet-4")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
  });

  it("throws on a ref without a separator", () => {
    expect(() => parseProviderModelRef("claude-sonnet-4")).toThrow();
  });
});

describe("providerRequestSchema", () => {
  const valid = {
    provider: "anthropic",
    model: "claude-sonnet-4",
    messages: [{ role: "user" as const, content: "hello" }],
  };

  it("accepts a complete request with optional maxTokens", () => {
    const req = providerRequestSchema.parse({ ...valid, maxTokens: 8000 });
    expect(req.maxTokens).toBe(8000);
  });

  it("accepts a request without maxTokens", () => {
    const req = providerRequestSchema.parse(valid);
    expect(req.maxTokens).toBeUndefined();
  });

  it("rejects a missing provider or model", () => {
    expect(() => providerRequestSchema.parse({ ...valid, provider: undefined })).toThrow();
    expect(() => providerRequestSchema.parse({ ...valid, model: undefined })).toThrow();
  });

  it("rejects malformed provider/model selectors", () => {
    expect(() =>
      providerRequestSchema.parse({ ...valid, provider: "anthropic/openai" }),
    ).toThrow();
    expect(() => providerRequestSchema.parse({ ...valid, model: "claude/4" })).toThrow();
  });

  it("rejects unknown message roles", () => {
    expect(() =>
      providerRequestSchema.parse({
        ...valid,
        messages: [{ role: "tool", content: "x" }],
      }),
    ).toThrow();
  });

  it("rejects an empty or oversized message list", () => {
    expect(() => providerRequestSchema.parse({ ...valid, messages: [] })).toThrow();
    expect(() =>
      providerRequestSchema.parse({ ...valid, messages: Array.from({ length: 201 }, () => valid.messages[0]) }),
    ).toThrow();
  });

  it("rejects non-positive or oversized maxTokens", () => {
    expect(() => providerRequestSchema.parse({ ...valid, maxTokens: 0 })).toThrow();
    expect(() => providerRequestSchema.parse({ ...valid, maxTokens: -1 })).toThrow();
    expect(() => providerRequestSchema.parse({ ...valid, maxTokens: 200_001 })).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      providerRequestSchema.parse({ ...valid, temperature: 0.7 }),
    ).toThrow();
  });
});

describe("providerResultSchema", () => {
  it("accepts a result with content plus optional usage/finishReason", () => {
    const res = providerResultSchema.parse({
      provider: "openai",
      model: "gpt-4o",
      content: "here is the answer",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 25 },
    });
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 25 });
    expect(res.finishReason).toBe("stop");
  });

  it("accepts a bare result (no usage, no finishReason)", () => {
    const res = providerResultSchema.parse({
      provider: "openai",
      model: "gpt-4o",
      content: "ok",
    });
    expect(res.usage).toBeUndefined();
    expect(res.finishReason).toBeUndefined();
  });

  it("rejects missing content", () => {
    expect(() =>
      providerResultSchema.parse({ provider: "openai", model: "gpt-4o" }),
    ).toThrow();
  });

  it("rejects malformed usage (negative tokens)", () => {
    expect(() =>
      providerResultSchema.parse({
        provider: "openai",
        model: "gpt-4o",
        content: "x",
        usage: { inputTokens: -1, outputTokens: 0 },
      }),
    ).toThrow();
  });
});

describe("providerMessageListSchema", () => {
  it("requires at least one message", () => {
    expect(providerMessageListSchema.parse([{ role: "system", content: "rules" }])).toHaveLength(1);
    expect(() => providerMessageListSchema.parse([])).toThrow();
  });

  it("rejects empty message content", () => {
    expect(() => providerMessageListSchema.parse([{ role: "user", content: "" }])).toThrow();
  });
});