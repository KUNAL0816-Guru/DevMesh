import { type ProviderRequest, type ProviderResult } from "@devmesh/contracts";
import { ProviderError, type ProviderAdapter } from "./provider.js";

export interface OpenAiCompatibleProviderOptions {
  /** Neutral provider id this OpenAI-compatible endpoint serves (e.g. "openai", "ollama"). */
  providerId?: string;
  /** OpenAI-compatible base URL (e.g. https://api.openai.com/v1). */
  baseUrl?: string;
  /** API key. Credentials are env/config-only — never a source-code constant. */
  apiKey?: string;
  /** Wall-clock request budget. */
  timeoutMs?: number;
}

/**
 * Default gateway integration direction per ADR-0001 amendment 9: the
 * OpenAI-compatible shape. The mapping is Chat Completions — send
 * `{ model, messages, max_tokens }`, read
 * `choices[0].message.content` / `finish_reason` / `usage.prompt_tokens`,
 * `usage.completion_tokens`.
 *
 * PHASE 10 SCOPE: interface-only. No live network I/O ships here; invoking
 * this gateway raises a typed provider/not-configured error until Phase 12
 * wires the HTTP client (and a local/offline endpoint such as Ollama backs
 * it). Core stays provider-independent: provider/model travel as neutral
 * ids and no vendor allow-list exists anywhere.
 */
export class OpenAiCompatibleProvider implements ProviderAdapter {
  readonly name = "openai-compatible";
  readonly providerId: string | undefined;
  readonly baseUrl: string | undefined;
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleProviderOptions = {}) {
    this.providerId = options.providerId;
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  get providerIds(): readonly string[] {
    return this.providerId ? [this.providerId] : [];
  }

  supportsProvider(providerId: string): boolean {
    return this.providerId !== undefined && providerId === this.providerId;
  }

  async complete(_request: ProviderRequest): Promise<ProviderResult> {
    throw new ProviderError(
      "provider/not-configured",
      "the OpenAI-compatible gateway is not wired for live completions in Phase 10",
    );
  }
}