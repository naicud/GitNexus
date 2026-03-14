/**
 * OpenAI-compatible Embedding Provider
 *
 * Works with OpenAI, LiteLLM, vLLM, and Ollama's /v1 compatibility endpoint.
 * Requires an API key (config, GITNEXUS_EMBED_API_KEY, or OPENAI_API_KEY env).
 */

import type { IEmbeddingProvider, EmbeddingProviderConfig } from './types.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class OpenAIProvider implements IEmbeddingProvider {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dims: number;

  constructor(config: EmbeddingProviderConfig) {
    this.endpoint = (config.endpoint || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey =
      config.apiKey ||
      process.env.GITNEXUS_EMBED_API_KEY ||
      process.env.OPENAI_API_KEY ||
      '';
    if (!this.apiKey) {
      throw new Error(
        'OpenAI API key is required. Set config.apiKey, GITNEXUS_EMBED_API_KEY, or OPENAI_API_KEY environment variable.',
      );
    }
    this.model = config.model;
    this.dims = config.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `${this.endpoint}/embeddings`;
    const payload: Record<string, unknown> = {
      input: texts,
      model: this.model,
    };

    if (this.dims) {
      payload.dimensions = this.dims;
    }

    const body = JSON.stringify(payload);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body,
        });

        if (response.status === 429 && attempt < MAX_RETRIES - 1) {
          const retryAfter = response.headers.get('retry-after');
          const delay = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(
            `OpenAI embed failed (HTTP ${response.status}): ${text}`,
          );
        }

        const json = (await response.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        if (!json.data || !Array.isArray(json.data)) {
          throw new Error(
            'OpenAI returned unexpected response shape: missing "data" array',
          );
        }

        // Sort by index to guarantee order matches input
        const sorted = json.data.sort((a, b) => a.index - b.index);
        return sorted.map((item) => item.embedding);
      } catch (err: any) {
        lastError = err;

        if (err?.message?.includes('OpenAI embed failed') && err?.message?.includes('429')) {
          if (attempt < MAX_RETRIES - 1) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }

        throw err;
      }
    }

    throw lastError;
  }

  dimensions(): number {
    return this.dims;
  }

  name(): string {
    return `openai/${this.model}`;
  }

  maxBatchSize(): number {
    return 256;
  }

  async dispose(): Promise<void> {
    // HTTP is stateless — nothing to release
  }
}
