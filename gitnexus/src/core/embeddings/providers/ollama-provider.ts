/**
 * Ollama Embedding Provider
 *
 * Uses Ollama's HTTP API for local/remote embedding generation.
 * Retries on ECONNREFUSED with exponential backoff.
 */

import type { IEmbeddingProvider, EmbeddingProviderConfig } from './types.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class OllamaProvider implements IEmbeddingProvider {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly dims: number;

  constructor(config: EmbeddingProviderConfig) {
    this.endpoint = (config.endpoint || 'http://localhost:11434').replace(/\/+$/, '');
    this.model = config.model;
    this.dims = config.dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const url = `${this.endpoint}/api/embed`;
    const body = JSON.stringify({ model: this.model, input: texts });

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(
            `Ollama embed failed (HTTP ${response.status}): ${text}`,
          );
        }

        const json = (await response.json()) as { embeddings: number[][] };

        if (!json.embeddings || !Array.isArray(json.embeddings)) {
          throw new Error(
            `Ollama returned unexpected response shape: missing "embeddings" array`,
          );
        }

        return json.embeddings;
      } catch (err: any) {
        lastError = err;
        const isConnectionError =
          err?.cause?.code === 'ECONNREFUSED' ||
          err?.code === 'ECONNREFUSED' ||
          err?.message?.includes('ECONNREFUSED');

        if (isConnectionError && attempt < MAX_RETRIES - 1) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
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
    return `ollama/${this.model}`;
  }

  maxBatchSize(): number {
    return 128;
  }

  async dispose(): Promise<void> {
    // HTTP is stateless — nothing to release
  }
}
