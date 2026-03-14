/**
 * Neptune Ingestion
 *
 * Loads a KnowledgeGraph into AWS Neptune via openCypher UNWIND+MERGE batches.
 * Uses batch size 500 to balance throughput vs request size.
 *
 * Neptune does NOT support KuzuDB's COPY FROM CSV — all inserts are HTTP requests.
 * For 177K nodes (EPAGHE scale): ~354 requests ≈ 35-60s.
 */

import { NeptunedataClient, ExecuteOpenCypherQueryCommand } from '@aws-sdk/client-neptunedata';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { NeptuneDbConfig } from '../interfaces.js';

const BATCH_SIZE = 500;

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
  const command = new ExecuteOpenCypherQueryCommand({
    openCypherQuery: cypher,
    ...(params ? { parameters: JSON.stringify(params) } : {}),
  });
  await client.send(command);
}

async function batchedInsert(
  client: NeptunedataClient,
  items: NeptuneBatchRow[],
  cypher: string,
  paramName: string = 'batch',
): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    await sendCypher(client, cypher, { [paramName]: batch });
  }
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
    // 1. Clear existing data
    onProgress?.('Clearing existing Neptune data...');
    await sendCypher(client, 'MATCH (n) DETACH DELETE n');

    // 2. Group nodes by label
    const nodesByLabel = new Map<string, NeptuneBatchRow[]>();
    graph.forEachNode((node) => {
      const label = node.label ?? 'CodeElement';
      if (!nodesByLabel.has(label)) nodesByLabel.set(label, []);
      // Flatten node.properties into the batch row alongside the id
      nodesByLabel.get(label)!.push({
        id: node.id,
        ...node.properties,
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
      await batchedInsert(client, rows, cypher);
      nodesInserted += rows.length;
    }

    // 4. Insert relationships
    const relRows: NeptuneBatchRow[] = [];
    graph.forEachRelationship((rel) => {
      relRows.push({
        from: rel.sourceId,
        to: rel.targetId,
        type: rel.type ?? 'CALLS',
        confidence: rel.confidence ?? null,
        reason: rel.reason ?? null,
        step: rel.step ?? null,
      });
    });

    onProgress?.(`Inserting ${relRows.length} relationships...`);
    const relCypher = `
      UNWIND $batch AS row
      MATCH (a {id: row.from}), (b {id: row.to})
      MERGE (a)-[r:CodeRelation {type: row.type}]->(b)
      SET r += row
    `;
    await batchedInsert(client, relRows, relCypher);
    edgesInserted = relRows.length;

    // 5. Create indexes for query performance
    onProgress?.('Creating Neptune indexes...');
    const indexLabels = ['Function', 'File', 'Class', 'Method', 'Interface', 'Module'];
    for (const lbl of indexLabels) {
      try {
        await sendCypher(client, `CREATE INDEX ON :\`${lbl}\`(id)`);
      } catch {
        // Index may already exist or label may not exist — non-fatal
      }
    }

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
