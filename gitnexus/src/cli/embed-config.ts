/**
 * Shared Embedding Configuration
 *
 * Resolves embedding provider config from CLI options + env vars.
 * Used by both `analyze` and `embed` commands.
 */

import type { EmbeddingProviderConfig, EmbeddingProviderType } from '../core/embeddings/providers/types.js';

export interface EmbedOptions {
  embedProvider?: string;
  embedModel?: string;
  embedDims?: string;
  embedEndpoint?: string;
  embedApiKey?: string;
}

/**
 * Resolve embedding provider config from CLI options + env vars.
 * Priority: CLI flags > env vars > provider-specific defaults.
 */
export function resolveEmbeddingConfig(options: EmbedOptions): EmbeddingProviderConfig {
  const provider = (options.embedProvider
    ?? process.env.GITNEXUS_EMBED_PROVIDER
    ?? 'local') as EmbeddingProviderType;

  const defaultModel = provider === 'local'
    ? 'Snowflake/snowflake-arctic-embed-xs'
    : provider === 'ollama' ? 'nomic-embed-text'
    : provider === 'cohere' ? 'embed-english-light-v3.0'
    : 'text-embedding-3-small';

  const model = options.embedModel
    ?? process.env.GITNEXUS_EMBED_MODEL
    ?? defaultModel;

  const dimensions = parseInt(
    options.embedDims ?? process.env.GITNEXUS_EMBED_DIMS ?? '384', 10,
  );

  const endpoint = options.embedEndpoint
    ?? process.env.GITNEXUS_EMBED_ENDPOINT
    ?? undefined;

  const apiKey = options.embedApiKey
    ?? process.env.GITNEXUS_EMBED_API_KEY
    ?? undefined;

  return { provider, model, dimensions, endpoint, apiKey };
}
