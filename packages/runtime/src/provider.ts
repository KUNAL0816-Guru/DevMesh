import {
  type ProviderRequest,
  type ProviderResult,
  providerRequestSchema,
} from "@devmesh/contracts";

export type ProviderErrorCode =
  | "provider/not-configured" // gateway wired with no/empty backend
  | "provider/unknown" // valid syntax, provider not registered — NO fallback
  | "provider/model-unknown" // provider known, model not supported by its adapter
  | "provider/invalid-request" // schema/parse failure, duplicate adapter registration
  | "provider/unavailable" // upstream network/timeout/5xx/connection error
  | "provider/unauthorized" // upstream 401/403 (missing/invalid API key)
  | "provider/rate-limited"; // upstream 429 (retryable)

/**
 * Typed failure for DevMesh's own LLM calls through the ProviderGateway port.
 * Deliberately distinct from RuntimeError: the gateway path never throws
 * RuntimeError and the AgentRuntime path never throws ProviderError, so the
 * two execution paths can never be confused.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    this.details = options?.details;
  }
}

/**
 * Port for DevMesh's OWN LLM calls (ADR-0001 amendment 6). Separate from and
 * never merged into AgentRuntime: it completes neutral provider/model
 * requests and has no notion of a workspace, a subprocess, or a coding agent.
 */
export interface ProviderGateway {
  /** Stable gateway id for observability ("composite", "fake-provider", ...). */
  readonly name: string;
  /** Provider ids this gateway can serve (empty = none configured). */
  readonly providerIds: readonly string[];
  /** Exact-match provider check; never implies a fallback. */
  supportsProvider(providerId: string): boolean;
  /** Single completion call. Rejects with ProviderError; never falls back. */
  complete(request: ProviderRequest): Promise<ProviderResult>;
}

/**
 * A gateway bound to one (or more) provider ids. Adapters may declare an
 * optional deterministic model catalog; when present the composite rejects
 * unknown models locally before delegating.
 */
export interface ProviderAdapter extends ProviderGateway {
  readonly supportedModels?: readonly string[];
}

/**
 * Catch-all ProviderGateway that routes each request to the registered
 * adapter serving the requested provider id. Resolution is exact-match:
 * a syntactically valid but unregistered provider throws provider/unknown —
 * there is NO default provider, NO fallback to another provider, and no
 * routing to the AgentRuntime path.
 */
export class CompositeProviderGateway implements ProviderGateway {
  readonly name = "composite";
  private readonly adapters = new Map<string, ProviderAdapter>();

  get providerIds(): readonly string[] {
    return [...this.adapters.keys()];
  }

  register(adapter: ProviderAdapter): this {
    for (const id of adapter.providerIds) {
      if (this.adapters.has(id)) {
        throw new ProviderError(
          "provider/invalid-request",
          `provider '${id}' is already registered`,
          { details: { provider: id } },
        );
      }
    }
    for (const id of adapter.providerIds) this.adapters.set(id, adapter);
    return this;
  }

  supportsProvider(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  async complete(request: ProviderRequest): Promise<ProviderResult> {
    const parsed = providerRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new ProviderError("provider/invalid-request", "malformed provider request", {
        cause: parsed.error,
      });
    }
    if (this.adapters.size === 0) {
      throw new ProviderError("provider/not-configured", "no provider gateway backend is wired");
    }
    const adapter = this.adapters.get(parsed.data.provider);
    if (!adapter) {
      throw new ProviderError(
        "provider/unknown",
        `provider '${parsed.data.provider}' is not registered`,
        { details: { provider: parsed.data.provider } },
      );
    }
    if (
      adapter.supportedModels !== undefined &&
      !adapter.supportedModels.includes(parsed.data.model)
    ) {
      throw new ProviderError(
        "provider/model-unknown",
        `provider '${parsed.data.provider}' does not support model '${parsed.data.model}'`,
        { details: { provider: parsed.data.provider, model: parsed.data.model } },
      );
    }
    return adapter.complete(parsed.data);
  }
}