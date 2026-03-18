/**
 * Embedding Provider Abstraction
 *
 * Defines the contract all embedding providers must implement,
 * plus the configuration type used to select and configure a provider.
 */

export type EmbeddingProviderType = 'ollama' | 'cohere' | 'openai' | 'local';

export interface IEmbeddingProvider {
  /** Embed an array of texts and return their vectors. */
  embed(texts: string[]): Promise<number[][]>;
  /** Number of dimensions produced by this provider/model. */
  dimensions(): number;
  /** Human-readable provider name (e.g. "ollama/nomic-embed-text"). */
  name(): string;
  /** Maximum texts per single embed() call. Callers should batch accordingly. */
  maxBatchSize(): number;
  /** Release any held resources (connections, ONNX sessions, etc.). */
  dispose(): Promise<void>;
}

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderType;
  model: string;
  dimensions: number;
  endpoint?: string;
  apiKey?: string;
}
