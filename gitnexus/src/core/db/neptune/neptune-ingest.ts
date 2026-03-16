/**
 * Neptune Ingestion
 *
 * Loads a KnowledgeGraph into AWS Neptune via openCypher UNWIND+MERGE batches.
 *
 * Design principles:
 * - Fault-tolerant: failed batches are skipped with warnings, never abort the load.
 * - Idempotent: MERGE upserts nodes/edges — re-running is always safe.
 * - No destructive clear: stale nodes are cleaned up AFTER successful insert.
 */

import { NeptunedataClient, ExecuteOpenCypherQueryCommand } from '@aws-sdk/client-neptunedata';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { NeptuneDbConfig } from '../interfaces.js';

const NODE_BATCH_SIZE = 500;
const EDGE_BATCH_SIZE = 25;
const MAX_RETRIES = 5;

export interface NeptuneLoadResult {
  nodesInserted: number;
  nodesFailed: number;
  edgesInserted: number;
  edgesFailed: number;
  warnings: string[];
}

type NeptuneBatchRow = Record<string, unknown>;

interface BatchResult {
  inserted: number;
  failed: number;
  failedBatches: NeptuneBatchRow[][];
}

async function sendCypher(
  client: NeptunedataClient,
  cypher: string,
  params?: Record<string, unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const command = new ExecuteOpenCypherQueryCommand({
        openCypherQuery: cypher,
        ...(params ? { parameters: JSON.stringify(params) } : {}),
      });
      await client.send(command);
      return;
    } catch (err: any) {
      const retryable = err.name === 'TimeLimitExceededException'
        || err.name === 'ConcurrentModificationException'
        || err.$retryable;
      if (!retryable || attempt === MAX_RETRIES - 1) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Insert items in batches with adaptive sizing and fault tolerance.
 * Failed batches (after all retries) are collected — never abort the load.
 */
async function batchedInsert(
  client: NeptunedataClient,
  items: NeptuneBatchRow[],
  cypher: string,
  batchSize: number = NODE_BATCH_SIZE,
  paramName: string = 'batch',
  onBatch?: (done: number, total: number) => void,
): Promise<BatchResult> {
  const MIN_BATCH = 5;
  let currentSize = batchSize;
  let i = 0;
  let inserted = 0;
  const failedBatches: NeptuneBatchRow[][] = [];

  while (i < items.length) {
    const chunk = items.slice(i, i + currentSize);
    try {
      await sendCypher(client, cypher, { [paramName]: chunk });
      inserted += chunk.length;
      i += currentSize;
      onBatch?.(Math.min(i, items.length), items.length);
    } catch (err: any) {
      if (err.name === 'TimeLimitExceededException' && currentSize > MIN_BATCH) {
        currentSize = Math.max(MIN_BATCH, Math.floor(currentSize / 2));
        onBatch?.(-1, items.length); // signal: batch size reduced
        continue; // retry same offset with smaller batch
      }
      // Persistent failure — skip this batch, continue with the next
      failedBatches.push(chunk);
      i += currentSize;
      onBatch?.(Math.min(i, items.length), items.length);
    }
  }

  return { inserted, failed: items.length - inserted, failedBatches };
}

/** Neptune openCypher only accepts simple literals (string, number, boolean) as property values. */
function sanitizeForNeptune(props: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) { clean[k] = v.join(','); continue; }
    if (typeof v === 'object') { clean[k] = JSON.stringify(v); continue; }
    clean[k] = v;
  }
  return clean;
}

/**
 * Load a KnowledgeGraph into Neptune.
 *
 * 1. Upserts nodes grouped by label via UNWIND+MERGE (idempotent)
 * 2. Creates indexes for query performance
 * 3. Upserts relationships via UNWIND+MERGE (idempotent)
 * 4. Cleans up orphan nodes no longer in the graph
 *
 * Failed batches are skipped with warnings — the load never aborts.
 * Re-running analyze is always safe thanks to MERGE idempotency.
 */
export async function loadGraphToNeptune(
  graph: KnowledgeGraph,
  config: NeptuneDbConfig,
  onProgress?: (msg: string) => void,
): Promise<NeptuneLoadResult> {
  const client = new NeptunedataClient({
    endpoint: `https://${config.endpoint}:${config.port}`,
    region: config.region,
  });

  const warnings: string[] = [];
  let nodesInserted = 0;
  let nodesFailed = 0;
  let edgesInserted = 0;
  let edgesFailed = 0;

  // Unique generation marker — used to identify stale nodes after upsert
  const generation = `gen_${Date.now()}`;

  try {
    // 1. Group nodes by label
    const nodesByLabel = new Map<string, NeptuneBatchRow[]>();
    graph.forEachNode((node) => {
      const label = node.label ?? 'CodeElement';
      if (!nodesByLabel.has(label)) nodesByLabel.set(label, []);
      nodesByLabel.get(label)!.push({
        id: node.id,
        _gen: generation,
        ...sanitizeForNeptune(node.properties as Record<string, unknown>),
      });
    });

    // 2. Upsert nodes by label
    const totalLabels = nodesByLabel.size;
    let labelIdx = 0;
    for (const [label, rows] of nodesByLabel) {
      labelIdx++;
      onProgress?.(`Upserting ${label} nodes (${labelIdx}/${totalLabels}, ${rows.length} nodes)...`);
      const cypher = `
        UNWIND $batch AS row
        MERGE (n:\`${label}\` {id: row.id})
        SET n += row
      `;
      const result = await batchedInsert(client, rows, cypher, NODE_BATCH_SIZE, 'batch', (done, total) => {
        if (done === -1) {
          onProgress?.(`${label} nodes: batch size reduced (timeout), retrying...`);
        } else {
          onProgress?.(`Upserting ${label} nodes (${labelIdx}/${totalLabels}, ${done}/${total})...`);
        }
      });
      nodesInserted += result.inserted;
      nodesFailed += result.failed;
      if (result.failed > 0) {
        warnings.push(`${result.failed} ${label} nodes failed to insert (${result.failedBatches.length} batches skipped)`);
      }
    }

    // 3. Create indexes BEFORE edges — critical for MATCH performance
    const allLabels = new Set([...nodesByLabel.keys(),
      'Function', 'File', 'Class', 'Method', 'Interface', 'Module',
      'Namespace', 'Variable', 'Property', 'CodeElement']);
    onProgress?.(`Creating Neptune indexes on ${allLabels.size} labels...`);
    for (const lbl of allLabels) {
      try {
        await sendCypher(client, `CREATE INDEX ON :\`${lbl}\`(id)`);
      } catch {
        // Index may already exist or label may not exist — non-fatal
      }
    }

    // 4. Upsert relationships
    const relRows: NeptuneBatchRow[] = [];
    graph.forEachRelationship((rel) => {
      const row: NeptuneBatchRow = {
        from: rel.sourceId,
        to: rel.targetId,
        type: rel.type ?? 'CALLS',
        confidence: rel.confidence,
        reason: rel.reason,
      };
      if (rel.step != null) row.step = rel.step;
      relRows.push(row);
    });

    onProgress?.(`Upserting ${relRows.length.toLocaleString()} relationships (batch=${EDGE_BATCH_SIZE})...`);
    const relCypher = `
      UNWIND $batch AS row
      MATCH (a {id: row.from}), (b {id: row.to})
      MERGE (a)-[r:CodeRelation {type: row.type}]->(b)
      SET r += row
    `;
    const edgeResult = await batchedInsert(client, relRows, relCypher, EDGE_BATCH_SIZE, 'batch', (done, total) => {
      if (done === -1) {
        onProgress?.(`Relationships: batch size reduced (timeout), retrying...`);
      } else {
        onProgress?.(`Upserting relationships ${done.toLocaleString()}/${total.toLocaleString()}...`);
      }
    });
    edgesInserted = edgeResult.inserted;
    edgesFailed = edgeResult.failed;
    if (edgeResult.failed > 0) {
      warnings.push(`${edgeResult.failed} relationships failed to insert (${edgeResult.failedBatches.length} batches skipped)`);
    }

    // 5. Clean up stale nodes from previous runs.
    //    Any node without the current generation marker is orphaned.
    //    Batched to avoid timeouts on large graphs. Non-fatal if it fails.
    onProgress?.('Cleaning up stale nodes...');
    const CLEANUP_BATCH = 10_000;
    let cleanupTotal = 0;
    try {
      for (;;) {
        const res = await client.send(new ExecuteOpenCypherQueryCommand({
          openCypherQuery: `MATCH (n) WHERE n._gen <> '${generation}' OR NOT exists(n._gen) WITH n LIMIT ${CLEANUP_BATCH} DETACH DELETE n RETURN count(*) AS deleted`,
        }));
        const rows = (res.results as Record<string, unknown>[]) ?? [];
        const deleted = Number(rows[0]?.['deleted'] ?? 0);
        if (deleted === 0) break;
        cleanupTotal += deleted;
        onProgress?.(`Cleaned ${cleanupTotal} stale nodes...`);
      }
    } catch (err: any) {
      warnings.push(`Orphan cleanup failed after removing ${cleanupTotal} nodes (non-fatal): ${err.message ?? err.name}`);
    }

    onProgress?.('Neptune loading complete');
    return { nodesInserted, nodesFailed, edgesInserted, edgesFailed, warnings };
  } finally {
    client.destroy();
  }
}

/**
 * Store embedding vectors as node properties in Neptune.
 *
 * For each embedding, matches the node by id and sets n.embedding = float[].
 * Uses UNWIND batches of 200 (smaller than BATCH_SIZE because embedding arrays
 * are large payloads).
 */
export async function loadEmbeddingsToNeptune(
  config: NeptuneDbConfig,
  embeddings: Array<{ nodeId: string; embedding: number[] }>,
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (embeddings.length === 0) {
    onProgress?.('No embeddings to load — skipping');
    return;
  }

  const EMBEDDING_BATCH_SIZE = 200;
  const client = new NeptunedataClient({
    endpoint: `https://${config.endpoint}:${config.port}`,
    region: config.region,
  });

  try {
    const totalBatches = Math.ceil(embeddings.length / EMBEDDING_BATCH_SIZE);
    onProgress?.(`Loading ${embeddings.length} embeddings into Neptune (${totalBatches} batches)...`);

    const cypher = `
      UNWIND $batch AS row
      MATCH (n {id: row.nodeId})
      SET n.embedding = row.embedding
    `;

    for (let i = 0; i < embeddings.length; i += EMBEDDING_BATCH_SIZE) {
      // Neptune openCypher rejects list/array types as property values (CType error).
      // Serialize the float[] as a JSON string so Neptune sees a simple literal.
      const batch = embeddings.slice(i, i + EMBEDDING_BATCH_SIZE).map(e => ({
        nodeId: e.nodeId,
        embedding: JSON.stringify(e.embedding),
      }));
      const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;
      await sendCypher(client, cypher, { batch });
      onProgress?.(`Embedding batch ${batchNum}/${totalBatches} (${batch.length} vectors)`);
    }

    onProgress?.(`Neptune embedding loading complete (${embeddings.length} vectors stored)`);
  } finally {
    client.destroy();
  }
}

/**
 * Fetch node/edge counts from Neptune (equivalent to getKuzuStats).
 */
export async function getNeptuneStats(
  config: NeptuneDbConfig,
): Promise<{ nodes: number; edges: number }> {
  const client = new NeptunedataClient({
    endpoint: `https://${config.endpoint}:${config.port}`,
    region: config.region,
  });
  try {
    const nodeRes = await client.send(new ExecuteOpenCypherQueryCommand({
      openCypherQuery: 'MATCH (n) RETURN count(n) AS c',
    }));
    const edgeRes = await client.send(new ExecuteOpenCypherQueryCommand({
      openCypherQuery: 'MATCH ()-[r]->() RETURN count(r) AS c',
    }));
    const nodeRows = (nodeRes.results as Record<string, unknown>[]) ?? [];
    const edgeRows = (edgeRes.results as Record<string, unknown>[]) ?? [];
    return {
      nodes: Number(nodeRows[0]?.['c'] ?? 0),
      edges: Number(edgeRows[0]?.['c'] ?? 0),
    };
  } finally {
    client.destroy();
  }
}
