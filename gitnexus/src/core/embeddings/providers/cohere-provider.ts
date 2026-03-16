/**
 * Cohere Embedding Provider
 *
 * Uses Cohere's v2 Embed API. Requires an API key (config or COHERE_API_KEY env).
 * Handles 429 rate-limit responses with exponential backoff.
 */

import type { IEmbeddingProvider, EmbeddingProviderConfig } from './types.js';

const COHERE_API_URL = 'https://api.cohere.com/v2/embed';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

type CohereInputType = 'search_document' | 'search_query';

export class CohereProvider implements IEmbeddingProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dims: number;
  private inputType: CohereInputType = 'search_document';

  constructor(config: EmbeddingProviderConfig) {
    this.apiKey = config.apiKey || process.env.COHERE_API_KEY || '';
    if (!this.apiKey) {
      throw new Error(
        'Cohere API key is required. Set config.apiKey or COHERE_API_KEY environment variable.',
      );
    }
    this.model = config.model;
    this.dims = config.dimensions;
  }

  setInputType(type: CohereInputType): void {
    this.inputType = type;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const body = JSON.stringify({
      texts,
      model: this.model,
      input_type: this.inputType,
      embedding_types: ['float'],
    });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(COHERE_API_URL, {
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
            `Cohere embed failed (HTTP ${response.status}): ${text}`,
          );
        }

        const json = (await response.json()) as {
          embeddings: { float: number[][] };
        };

        if (!json.embeddings?.float || !Array.isArray(json.embeddings.float)) {
          throw new Error(
            'Cohere returned unexpected response shape: missing "embeddings.float" array',
          );
        }

        return json.embeddings.float;
      } catch (err: any) {
        lastError = err;

        if (err?.message?.includes('Cohere embed failed') && err?.message?.includes('429')) {
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
    return `cohere/${this.model}`;
  }

  maxBatchSize(): number {
    return 96;
  }

  async dispose(): Promise<void> {
    // HTTP is stateless — nothing to release
  }
}
