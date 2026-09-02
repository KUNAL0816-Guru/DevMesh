import { type ProviderRequest, type ProviderResult } from "@devmesh/contracts";
import { ProviderError, type ProviderAdapter, type ProviderErrorCode } from "./provider.js";

export interface FakeProviderOutcome {
  content?: string;
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface FakeProviderGatewayOptions {
  /** Provider id this fake serves (default "fake"). */
  providerId?: string;
  /** Fixed model catalog for the served provider (default ["fake-model"]). */
  models?: readonly string[];
  /** Scripted completion output. */
  outcome?: FakeProviderOutcome;
  /** Script a deterministic failure for every supported call. */
  failure?: ProviderErrorCode;
}

/**
 * Deterministic in-process ProviderGateway for tests and offline development.
 * Serves a single provider id with a fixed model catalog; unknown providers
 * and models fail with the same typed ProviderErrors production gateways must
 * honor — never an implicit fallback.
 */
export class FakeProviderGateway implements ProviderAdapter {
  readonly name = "fake-provider";
  readonly providerId: string;
  readonly models: readonly string[];
  readonly supportedModels: readonly string[];
  readonly outcome: FakeProviderOutcome;
  readonly failure?: ProviderErrorCode;
  /** The last request observed by complete() (for passthrough assertions). */
  lastRequest?: ProviderRequest;

  constructor(options: FakeProviderGatewayOptions = {}) {
    this.providerId = options.providerId ?? "fake";
    this.models = options.models ?? ["fake-model"];
    this.supportedModels = this.models;
    this.outcome = options.outcome ?? {};
    this.failure = options.failure;
  }

  get providerIds(): readonly string[] {
    return [this.providerId];
  }

  supportsProvider(providerId: string): boolean {
    return providerId === this.providerId;
  }

  async complete(request: ProviderRequest): Promise<ProviderResult> {
    this.lastRequest = request;
    if (request.provider !== this.providerId) {
      throw new ProviderError(
        "provider/unknown",
        `provider '${request.provider}' is not registered`,
        { details: { provider: request.provider } },
      );
    }
    if (!this.models.includes(request.model)) {
      throw new ProviderError(
        "provider/model-unknown",
        `provider '${this.providerId}' does not support model '${request.model}'`,
        { details: { provider: this.providerId, model: request.model } },
      );
    }
    if (this.failure) {
      throw new ProviderError(this.failure, `scripted provider failure: ${this.failure}`);
    }
    return {
      provider: request.provider,
      model: request.model,
      content: this.outcome.content ?? "fake completion",
      finishReason: this.outcome.finishReason ?? "stop",
      ...(this.outcome.usage ? { usage: this.outcome.usage } : {}),
    };
  }
}