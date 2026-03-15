/**
 * Neptune Ingestion
 *
 * Loads a KnowledgeGraph into AWS Neptune via openCypher UNWIND+MERGE batches.
 * Uses batch size 500 to balance throughput vs request size.
 *
 * Neptune does NOT support KuzuDB's COPY FROM CSV — all inserts are HTTP requests.
 * For 177K nodes (PROJECT-NAME scale): ~354 requests ≈ 35-60s.
 */

import { NeptunedataClient, ExecuteOpenCypherQueryCommand } from '@aws-sdk/client-neptunedata';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { NeptuneDbConfig } from '../interfaces.js';

const NODE_BATCH_SIZE = 500;
const EDGE_BATCH_SIZE = 25;
const DELETE_BATCH_SIZE = 10_000;
const MAX_RETRIES = 5;

export interface NeptuneLoadResult {
  nodesInserted: number;
  edgesInserted: number;
  warnings: string[];
}

type NeptuneBatchRow = Record<string, unknown>;

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

async function batchedInsert(
  client: NeptunedataClient,
  items: NeptuneBatchRow[],
  cypher: string,
  batchSize: number = NODE_BATCH_SIZE,
  paramName: string = 'batch',
  onBatch?: (done: number, total: number) => void,
): Promise<void> {
  const MIN_BATCH = 5;
  let currentSize = batchSize;
  let i = 0;
  while (i < items.length) {
    const chunk = items.slice(i, i + currentSize);
    try {
      await sendCypher(client, cypher, { [paramName]: chunk });
      i += currentSize;
      onBatch?.(Math.min(i, items.length), items.length);
    } catch (err: any) {
      if (err.name === 'TimeLimitExceededException' && currentSize > MIN_BATCH) {
        currentSize = Math.max(MIN_BATCH, Math.floor(currentSize / 2));
        onBatch?.(-1, items.length); // signal: batch size reduced
        continue; // retry same offset with smaller batch
      }
      throw err;
    }
  }
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
 * 1. Clears all existing data (MATCH (n) DETACH DELETE n)
 * 2. Inserts nodes grouped by label via UNWIND+MERGE
 * 3. Inserts relationships via UNWIND+MERGE
 * 4. Creates indexes for query performance
 *
 * @param graph     The in-memory knowledge graph built by the ingestion pipeline
 * @param config    Neptune connection config
 * @param onProgress  Optional callback for progress messages (same signature as loadGraphToKuzu)
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
  let edgesInserted = 0;

  try {
    // 1. Clear existing data in batches (single DETACH DELETE times out on large graphs)
    onProgress?.('Clearing existing Neptune data...');
    let deleteRound = 0;
    for (;;) {
      deleteRound++;
      const res = await client.send(new ExecuteOpenCypherQueryCommand({
        openCypherQuery: `MATCH (n) WITH n LIMIT ${DELETE_BATCH_SIZE} DETACH DELETE n RETURN count(*) AS deleted`,
      }));
      const rows = (res.results as Record<string, unknown>[]) ?? [];
      const deleted = Number(rows[0]?.['deleted'] ?? 0);
      if (deleted === 0) break;
      onProgress?.(`Cleared ${deleted} nodes (round ${deleteRound})...`);
    }

    // 2. Group nodes by label
    const nodesByLabel = new Map<string, NeptuneBatchRow[]>();
    graph.forEachNode((node) => {
      const label = node.label ?? 'CodeElement';
      if (!nodesByLabel.has(label)) nodesByLabel.set(label, []);
      // Flatten node.properties into the batch row alongside the id
      nodesByLabel.get(label)!.push({
        id: node.id,
        ...sanitizeForNeptune(node.properties as Record<string, unknown>),
      });
    });

    // 3. Insert nodes by label
    const totalLabels = nodesByLabel.size;
    let labelIdx = 0;
    for (const [label, rows] of nodesByLabel) {
      labelIdx++;
      onProgress?.(`Inserting ${label} nodes (${labelIdx}/${totalLabels}, ${rows.length} nodes)...`);
      const cypher = `
        UNWIND $batch AS row
        MERGE (n:\`${label}\` {id: row.id})
        SET n += row
      `;
      await batchedInsert(client, rows, cypher, NODE_BATCH_SIZE, 'batch', (done, total) => {
        onProgress?.(`Inserting ${label} nodes (${labelIdx}/${totalLabels}, ${done}/${total})...`);
      });
      nodesInserted += rows.length;
    }

    // 4. Create indexes BEFORE edges — critical for MATCH performance
    //    Index ALL labels in the graph, not just a hardcoded set.
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

    // 5. Insert relationships (smaller batches — MATCH on two nodes is heavier)
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

    onProgress?.(`Inserting ${relRows.length.toLocaleString()} relationships (batch=${EDGE_BATCH_SIZE})...`);
    const relCypher = `
      UNWIND $batch AS row
      MATCH (a {id: row.from}), (b {id: row.to})
      MERGE (a)-[r:CodeRelation {type: row.type}]->(b)
      SET r += row
    `;
    await batchedInsert(client, relRows, relCypher, EDGE_BATCH_SIZE, 'batch', (done, total) => {
      if (done === -1) {
        onProgress?.(`Relationships: batch size reduced (timeout), retrying...`);
      } else {
        onProgress?.(`Inserting relationships ${done.toLocaleString()}/${total.toLocaleString()}...`);
      }
    });
    edgesInserted = relRows.length;

    onProgress?.('Neptune loading complete');
    return { nodesInserted, edgesInserted, warnings };
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
 *
 * @param config      Neptune connection config
 * @param embeddings  Array of { nodeId, embedding } pairs
 * @param onProgress  Optional callback for progress messages
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
      const batch = embeddings.slice(i, i + EMBEDDING_BATCH_SIZE);
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
