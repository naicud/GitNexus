/**
 * Embedding Pipeline Module
 *
 * Orchestrates the embedding process:
 * 1. Query embeddable nodes from LadybugDB (paginated)
 * 2. Generate text representations
 * 3. Batch embed using the injected IEmbeddingProvider
 * 4. Update LadybugDB with embeddings
 * 5. Create vector index for semantic search
 */

import type { IEmbeddingProvider } from './providers/types.js';
import { generateBatchEmbeddingTexts } from './text-generator.js';
import {
  type EmbeddingProgress,
  type EmbeddingConfig,
  type EmbeddableNode,
  type SemanticSearchResult,
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDABLE_LABELS,
} from './types.js';

const isDev = process.env.NODE_ENV === 'development';
const PAGE_SIZE = 1000;

export type EmbeddingProgressCallback = (progress: EmbeddingProgress) => void;

/**
 * Smart label selection: skip File nodes for very large repos to limit embedding volume.
 */
export function getEmbeddableLabels(nodeCount: number): readonly string[] {
  if (nodeCount > 100_000) return ['Function', 'Class', 'Method', 'Interface'];
  return EMBEDDABLE_LABELS;
}

/**
 * Count embeddable nodes per label (used to compute total before paginated fetch).
 */
const countEmbeddableNodes = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  labels: readonly string[],
): Promise<number> => {
  let total = 0;
  for (const label of labels) {
    try {
      const rows = await executeQuery(`MATCH (n:${label}) RETURN count(n) AS cnt`);
      total += Number(rows[0]?.cnt ?? rows[0]?.[0] ?? 0);
    } catch { /* table may not exist */ }
  }
  return total;
};

/**
 * Paginated node query — yields one page at a time to control memory.
 */
async function* queryNodesPaginated(
  executeQuery: (cypher: string) => Promise<any[]>,
  label: string,
  skipNodeIds?: Set<string>,
): AsyncGenerator<EmbeddableNode[]> {
  let offset = 0;
  while (true) {
    const isFile = label === 'File';
    const query = isFile
      ? `MATCH (n:File) RETURN n.id AS id, n.name AS name, 'File' AS label, n.filePath AS filePath, n.content AS content SKIP ${offset} LIMIT ${PAGE_SIZE}`
      : `MATCH (n:${label}) RETURN n.id AS id, n.name AS name, '${label}' AS label, n.filePath AS filePath, n.content AS content, n.startLine AS startLine, n.endLine AS endLine SKIP ${offset} LIMIT ${PAGE_SIZE}`;

    const rows = await executeQuery(query);
    if (rows.length === 0) break;

    const page: EmbeddableNode[] = [];
    for (const row of rows) {
      const id = row.id ?? row[0];
      if (skipNodeIds?.has(id)) continue;
      page.push({
        id,
        name: row.name ?? row[1],
        label: row.label ?? row[2],
        filePath: row.filePath ?? row[3],
        content: row.content ?? row[4] ?? '',
        startLine: row.startLine ?? row[5],
        endLine: row.endLine ?? row[6],
      });
    }

    if (page.length > 0) yield page;
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
}

const batchInsertEmbeddings = async (
  executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>
  ) => Promise<void>,
  updates: Array<{ id: string; embedding: number[] }>
): Promise<void> => {
  const cypher = `CREATE (e:CodeEmbedding {nodeId: $nodeId, embedding: $embedding})`;
  const paramsList = updates.map(u => ({ nodeId: u.id, embedding: u.embedding }));
  await executeWithReusedStatement(cypher, paramsList);
};

/**
 * Create the vector index for semantic search
 * Now indexes the separate CodeEmbedding table
 */
let vectorExtensionLoaded = false;

const createVectorIndex = async (
  executeQuery: (cypher: string) => Promise<any[]>
): Promise<void> => {
  // LadybugDB v0.15+ requires explicit VECTOR extension loading (once per session)
  if (!vectorExtensionLoaded) {
    try {
      await executeQuery('INSTALL VECTOR');
      await executeQuery('LOAD EXTENSION VECTOR');
      vectorExtensionLoaded = true;
    } catch {
      vectorExtensionLoaded = true;
    }
  }

  try {
    await executeQuery(
      `CALL CREATE_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 'embedding', metric := 'cosine')`,
    );
  } catch (error) {
    if (isDev) console.warn('Vector index creation warning:', error);
  }
};

/**
 * Run the embedding pipeline with an injected provider.
 */
export const runEmbeddingPipeline = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  executeWithReusedStatement: (cypher: string, paramsList: Array<Record<string, any>>) => Promise<void>,
  onProgress: EmbeddingProgressCallback,
  provider: IEmbeddingProvider,
  config: Partial<EmbeddingConfig> = {},
  skipNodeIds?: Set<string>,
  embeddableLabels?: readonly string[],
): Promise<void> => {
  const finalConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
  const labels = embeddableLabels ?? EMBEDDABLE_LABELS;
  const batchSize = Math.min(provider.maxBatchSize(), finalConfig.batchSize || provider.maxBatchSize());

  try {
    onProgress({ phase: 'loading-model', percent: 0, modelDownloadPercent: 0 });

    // Warm up the provider (triggers lazy model load for local providers)
    await provider.embed(['warmup']);

    onProgress({ phase: 'loading-model', percent: 20, modelDownloadPercent: 100 });

    if (isDev) console.log('Querying embeddable nodes...');

    const totalNodes = await countEmbeddableNodes(executeQuery, labels);
    const skipped = skipNodeIds?.size ?? 0;
    const estimatedToEmbed = Math.max(0, totalNodes - skipped);

    if (isDev) console.log(`Found ${totalNodes} total, ${skipped} cached, ~${estimatedToEmbed} to embed`);

    if (estimatedToEmbed === 0) {
      onProgress({ phase: 'ready', percent: 100, nodesProcessed: 0, totalNodes: 0 });
      return;
    }

    let processedNodes = 0;
    let pendingBatch: EmbeddableNode[] = [];

    const flushBatch = async () => {
      if (pendingBatch.length === 0) return;

      const texts = generateBatchEmbeddingTexts(pendingBatch, finalConfig);
      const embeddings = await provider.embed(texts);
      const updates = pendingBatch.map((node, i) => ({
        id: node.id,
        embedding: embeddings[i],
      }));

      await batchInsertEmbeddings(executeWithReusedStatement, updates);
      processedNodes += pendingBatch.length;

      const embeddingProgress = 20 + ((processedNodes / estimatedToEmbed) * 70);
      onProgress({
        phase: 'embedding',
        percent: Math.min(90, Math.round(embeddingProgress)),
        nodesProcessed: processedNodes,
        totalNodes: estimatedToEmbed,
      });

      pendingBatch = [];
    };

    onProgress({ phase: 'embedding', percent: 20, nodesProcessed: 0, totalNodes: estimatedToEmbed });

    // Process one label at a time, paginated, to control memory
    for (const label of labels) {
      for await (const page of queryNodesPaginated(executeQuery, label, skipNodeIds)) {
        for (const node of page) {
          pendingBatch.push(node);
          if (pendingBatch.length >= batchSize) {
            await flushBatch();
          }
        }
      }
    }

    // Flush remaining
    await flushBatch();

    // Create vector index
    onProgress({ phase: 'indexing', percent: 90, nodesProcessed: processedNodes, totalNodes: estimatedToEmbed });

    if (isDev) console.log('Creating vector index...');
    await createVectorIndex(executeQuery);

    onProgress({ phase: 'ready', percent: 100, nodesProcessed: processedNodes, totalNodes: estimatedToEmbed });

    if (isDev) console.log('Embedding pipeline complete!');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (isDev) console.error('Embedding pipeline error:', error);
    onProgress({ phase: 'error', percent: 0, error: errorMessage });
    throw error;
  }
};

/**
 * Perform semantic search using the vector index.
 * Uses CodeEmbedding table and queries each node table to get metadata.
 */
export const semanticSearch = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  queryVec: number[],
  dims: number,
  k: number = 10,
  maxDistance: number = 0.5
): Promise<SemanticSearchResult[]> => {
  const queryVecStr = `[${queryVec.join(',')}]`;

  const vectorQuery = `
    CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx',
      CAST(${queryVecStr} AS FLOAT[${dims}]), ${k})
    YIELD node AS emb, distance
    WITH emb, distance
    WHERE distance < ${maxDistance}
    RETURN emb.nodeId AS nodeId, distance
    ORDER BY distance
  `;

  const embResults = await executeQuery(vectorQuery);
  if (embResults.length === 0) return [];

  // Group results by label for batched metadata queries
  const byLabel = new Map<string, Array<{ nodeId: string; distance: number }>>();
  for (const embRow of embResults) {
    const nodeId = embRow.nodeId ?? embRow[0];
    const distance = embRow.distance ?? embRow[1];
    const labelEndIdx = nodeId.indexOf(':');
    const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push({ nodeId, distance });
  }

  // Batch-fetch metadata per label
  const results: SemanticSearchResult[] = [];

  for (const [label, items] of byLabel) {
    const idList = items.map(i => `'${i.nodeId.replace(/'/g, "''")}'`).join(', ');
    try {
      let nodeQuery: string;
      if (label === 'File') {
        nodeQuery = `
          MATCH (n:File) WHERE n.id IN [${idList}]
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath
        `;
      } else {
        nodeQuery = `
          MATCH (n:${label}) WHERE n.id IN [${idList}]
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
                 n.startLine AS startLine, n.endLine AS endLine
        `;
      }
      const nodeRows = await executeQuery(nodeQuery);
      const rowMap = new Map<string, any>();
      for (const row of nodeRows) {
        const id = row.id ?? row[0];
        rowMap.set(id, row);
      }
      for (const item of items) {
        const nodeRow = rowMap.get(item.nodeId);
        if (nodeRow) {
          results.push({
            nodeId: item.nodeId,
            name: nodeRow.name ?? nodeRow[1] ?? '',
            label,
            filePath: nodeRow.filePath ?? nodeRow[2] ?? '',
            distance: item.distance,
            startLine: label !== 'File' ? (nodeRow.startLine ?? nodeRow[3]) : undefined,
            endLine: label !== 'File' ? (nodeRow.endLine ?? nodeRow[4]) : undefined,
          });
        }
      }
    } catch { /* table might not exist, skip */ }
  }

  // Re-sort by distance since batch queries may have mixed order
  results.sort((a, b) => a.distance - b.distance);

  return results;
};

/**
 * Semantic search with graph expansion (flattened results).
 * For full graph traversal, use execute_vector_cypher tool directly.
 */
export const semanticSearchWithContext = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  queryVec: number[],
  dims: number,
  k: number = 5,
  _hops: number = 1
): Promise<any[]> => {
  const results = await semanticSearch(executeQuery, queryVec, dims, k, 0.5);

  return results.map(r => ({
    matchId: r.nodeId,
    matchName: r.name,
    matchLabel: r.label,
    matchPath: r.filePath,
    distance: r.distance,
    connectedId: null,
    connectedName: null,
    connectedLabel: null,
    relationType: null,
  }));
};
