/**
 * Embedder Module (MCP Query-Time)
 *
 * Provider-aware embedding for search queries.
 * Caches providers by provider:model key to avoid re-initialization.
 * Falls back to local transformers.js if no config is provided (backward compat).
 */

import type { IEmbeddingProvider } from '../../core/embeddings/providers/types.js';
import { createEmbeddingProvider } from '../../core/embeddings/providers/factory.js';

export interface EmbeddingConfigInfo {
  provider: string;
  model: string;
  dimensions: number;
  endpoint?: string;
}

const DEFAULT_CONFIG: EmbeddingConfigInfo = {
  provider: 'local',
  model: 'Snowflake/snowflake-arctic-embed-xs',
  dimensions: 384,
};

const providerCache = new Map<string, IEmbeddingProvider>();
let initLock: Promise<IEmbeddingProvider> | null = null;

function cacheKey(cfg: EmbeddingConfigInfo): string {
  return `${cfg.provider}:${cfg.model}`;
}

async function getOrCreateProvider(cfg: EmbeddingConfigInfo): Promise<IEmbeddingProvider> {
  const key = cacheKey(cfg);
  const existing = providerCache.get(key);
  if (existing) return existing;

  // Serialize initialization to avoid duplicate model loads
  if (initLock) await initLock;

  // Re-check after awaiting lock
  const recheck = providerCache.get(key);
  if (recheck) return recheck;

  console.error(`GitNexus: Loading embedding provider ${key} (first search may take a moment)...`);

  initLock = createEmbeddingProvider({
    provider: cfg.provider as any,
    model: cfg.model,
    dimensions: cfg.dimensions,
    endpoint: cfg.endpoint,
  });

  try {
    const provider = await initLock;
    providerCache.set(key, provider);
    console.error(`GitNexus: Embedding provider ${key} loaded`);
    return provider;
  } finally {
    initLock = null;
  }
}

/**
 * Embed a query text for semantic search.
 * Uses the provider that matches the repo's embedding config.
 */
export const embedQuery = async (
  query: string,
  embeddingConfig?: EmbeddingConfigInfo,
): Promise<number[]> => {
  const cfg = embeddingConfig ?? DEFAULT_CONFIG;
  const provider = await getOrCreateProvider(cfg);
  const [embedding] = await provider.embed([query]);
  return embedding;
};

/**
 * Get embedding dimensions for a given config.
 */
export const getEmbeddingDims = (
  embeddingConfig?: { dimensions: number },
): number => {
  return embeddingConfig?.dimensions ?? 384;
};

/**
 * Check if any embedder is ready (backward compat).
 */
export const isEmbedderReady = (): boolean => providerCache.size > 0;

/**
 * Cleanup all cached providers.
 */
export const disposeEmbedder = async (): Promise<void> => {
  for (const provider of providerCache.values()) {
    try { await provider.dispose(); } catch {}
  }
  providerCache.clear();
};
