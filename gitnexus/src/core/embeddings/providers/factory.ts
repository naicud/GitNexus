/**
 * Embedding Provider Factory
 *
 * Creates the appropriate IEmbeddingProvider based on config.
 * Provider modules are lazily imported to avoid loading unnecessary deps.
 */

import type { IEmbeddingProvider, EmbeddingProviderConfig } from './types.js';

export async function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
): Promise<IEmbeddingProvider> {
  switch (config.provider) {
    case 'ollama': {
      const { OllamaProvider } = await import('./ollama-provider.js');
      return new OllamaProvider(config);
    }
    case 'cohere': {
      const { CohereProvider } = await import('./cohere-provider.js');
      return new CohereProvider(config);
    }
    case 'openai': {
      const { OpenAIProvider } = await import('./openai-provider.js');
      return new OpenAIProvider(config);
    }
    case 'local': {
      const { TransformersJsProvider } = await import('./transformers-provider.js');
      return new TransformersJsProvider(config);
    }
    default:
      throw new Error(`Unknown embedding provider: ${(config as any).provider}`);
  }
}
