/**
 * Neptune Vector Search (App-Side)
 *
 * Neptune does not have native vector indexes. This module:
 * 1. Fetches all embeddings from Neptune on first call
 * 2. Caches them in a flat Float64Array matrix for fast cosine computation
 * 3. Computes cosine similarity app-side and returns top-K results
 *
 * Trade-off: first query is slow (fetches all embeddings via openCypher),
 * subsequent queries are fast (in-memory matrix dot products).
 *
 * Cache is per-adapter instance (keyed by endpoint+port).
 */

import type { NeptuneAdapter } from './neptune-adapter.js';

interface EmbeddingCache {
  nodeIds: string[];
  matrix: Float64Array;
  dims: number;
}

/** Module-level cache keyed by adapter identifier (endpoint:port) */
const cache = new Map<string, EmbeddingCache>();

/**
 * Derive a stable cache key from a NeptuneAdapter.
 *
 * NeptuneAdapter stores its config privately, so we use toString()
 * of the adapter instance as a fallback. However, since we control
 * the call sites, callers can also provide an explicit adapterId.
 */
function adapterKey(adapter: NeptuneAdapter): string {
  // NeptuneAdapter doesn't expose config, so we use its object identity
  // via a WeakMap approach would be cleaner, but a simple string key
  // derived from the adapter works if we supplement with an explicit id.
  // Fallback: use the adapter's constructor name + object hash
  return (adapter as unknown as { config?: { endpoint?: string; port?: number } }).config
    ? `${(adapter as unknown as { config: { endpoint: string; port: number } }).config.endpoint}:${(adapter as unknown as { config: { endpoint: string; port: number } }).config.port}`
    : `neptune-adapter-${String(adapter)}`;
}

/**
 * Compute cosine similarity between vector `a` and a row in a flat matrix.
 *
 * @param a       Query embedding
 * @param b       Flat matrix containing all stored embeddings
 * @param offset  Start index of the target row in `b`
 * @param dims    Dimensionality of the embeddings
 * @returns       Cosine similarity in [-1, 1]
 */
function cosineSimilarity(
  a: number[],
  b: Float64Array,
  offset: number,
  dims: number,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < dims; i++) {
    const ai = a[i];
    const bi = b[offset + i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Build the embedding cache by fetching all embeddings from Neptune.
 */
async function buildCache(adapter: NeptuneAdapter): Promise<EmbeddingCache> {
  const rows = await adapter.executeQuery(
    'MATCH (n) WHERE n.embedding IS NOT NULL RETURN n.id AS nodeId, n.embedding AS embedding',
  );

  if (rows.length === 0) {
    return { nodeIds: [], matrix: new Float64Array(0), dims: 0 };
  }

  // Determine dimensionality from the first valid embedding
  const firstEmbedding = rows[0]['embedding'] as number[];
  const dims = firstEmbedding.length;

  const nodeIds: string[] = [];
  const values: number[] = [];

  for (const row of rows) {
    const embedding = row['embedding'] as number[] | undefined;
    const nodeId = row['nodeId'] as string | undefined;

    if (!nodeId || !embedding || !Array.isArray(embedding) || embedding.length !== dims) {
      continue; // Skip malformed entries
    }

    nodeIds.push(nodeId);
    for (let i = 0; i < dims; i++) {
      values.push(embedding[i]);
    }
  }

  const matrix = new Float64Array(values);
  return { nodeIds, matrix, dims };
}

/**
 * Perform semantic search against Neptune-stored embeddings.
 *
 * On first call, fetches all embeddings from Neptune and caches them.
 * Subsequent calls use the in-memory cache for fast cosine computation.
 *
 * @param adapter         NeptuneAdapter instance for querying
 * @param queryEmbedding  The query vector to search against
 * @param k               Number of top results to return (default: 10)
 * @param maxDistance      Maximum cosine distance threshold (default: 0.6)
 * @returns               Top-K results sorted by distance ascending
 */
export async function neptuneSemanticSearch(
  adapter: NeptuneAdapter,
  queryEmbedding: number[],
  k: number = 10,
  maxDistance: number = 0.6,
): Promise<Array<{ nodeId: string; distance: number }>> {
  const key = adapterKey(adapter);

  // Build cache on first call (or after invalidation)
  if (!cache.has(key)) {
    const entry = await buildCache(adapter);
    cache.set(key, entry);
  }

  const entry = cache.get(key)!;

  // Handle empty cache
  if (entry.nodeIds.length === 0 || entry.dims === 0) {
    return [];
  }

  // Validate query embedding dimensionality
  if (queryEmbedding.length !== entry.dims) {
    throw new Error(
      `Query embedding dimensionality (${queryEmbedding.length}) does not match stored embeddings (${entry.dims})`,
    );
  }

  // Compute cosine distance for every stored embedding
  const results: Array<{ nodeId: string; distance: number }> = [];
  const nodeCount = entry.nodeIds.length;

  for (let i = 0; i < nodeCount; i++) {
    const similarity = cosineSimilarity(queryEmbedding, entry.matrix, i * entry.dims, entry.dims);
    const distance = 1 - similarity; // Cosine distance: 0 = identical, 2 = opposite

    if (distance < maxDistance) {
      results.push({ nodeId: entry.nodeIds[i], distance });
    }
  }

  // Sort by distance ascending, take top-K
  results.sort((a, b) => a.distance - b.distance);
  return results.slice(0, k);
}

/**
 * Invalidate the in-memory embedding cache.
 *
 * Call this after re-indexing or loading new embeddings to force
 * a fresh fetch on the next search.
 *
 * @param adapterId  If provided, invalidate only that adapter's cache.
 *                   Otherwise, clear all cached embeddings.
 */
export function invalidateNeptuneEmbeddingCache(adapterId?: string): void {
  if (adapterId) {
    cache.delete(adapterId);
  } else {
    cache.clear();
  }
}
