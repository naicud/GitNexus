/**
 * Resume: creates indexes then inserts only edges into Neptune.
 * Uses already-compiled dist files — no ts-node needed.
 */

import { runPipelineFromRepo } from '../dist/core/ingestion/pipeline.js';
import { NeptunedataClient, ExecuteOpenCypherQueryCommand } from '@aws-sdk/client-neptunedata';

const ENDPOINT = process.env.GITNEXUS_NEPTUNE_ENDPOINT
  ?? 'dbc-paghe-cobol-modernization.cluster-cbus6uio60pc.eu-north-1.neptune.amazonaws.com';
const REGION = process.env.GITNEXUS_NEPTUNE_REGION ?? 'eu-north-1';
const PORT = parseInt(process.env.GITNEXUS_NEPTUNE_PORT ?? '8182', 10);
const EDGE_BATCH = 100;
const MAX_RETRIES = 5;

const repoPath = process.argv[2];
if (!repoPath) { console.error('Usage: ... <repo-path>'); process.exit(1); }

async function sendCypher(client, cypher, params) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await client.send(new ExecuteOpenCypherQueryCommand({
        openCypherQuery: cypher,
        ...(params ? { parameters: JSON.stringify(params) } : {}),
      }));
      return;
    } catch (err) {
      const retryable = err.name === 'TimeLimitExceededException'
        || err.name === 'ConcurrentModificationException'
        || err.$retryable;
      if (!retryable || attempt === MAX_RETRIES - 1) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      console.log(`  Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (${err.name})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

console.log('\n  Neptune Edge Resume\n');
console.log(`  Repo: ${repoPath}`);
console.log(`  Endpoint: ${ENDPOINT}:${PORT} (${REGION})\n`);

// 1. Run pipeline
console.log('  [1/3] Running pipeline...');
const t0 = Date.now();
const result = await runPipelineFromRepo(repoPath, (p) => {
  if (p.phase === 'parsing') {
    process.stdout.write(`\r  Parsing: ${p.percent}%`);
  }
});
console.log(`\r  Pipeline done in ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

// 2. Create indexes
console.log('  [2/3] Creating indexes...');
const client = new NeptunedataClient({
  endpoint: `https://${ENDPOINT}:${PORT}`,
  region: REGION,
});

const labels = ['Function', 'File', 'Class', 'Method', 'Interface', 'Module',
  'Namespace', 'Variable', 'Property', 'CodeElement'];
for (const lbl of labels) {
  try {
    await sendCypher(client, `CREATE INDEX ON :\`${lbl}\`(id)`);
    console.log(`    Index on ${lbl}: created`);
  } catch {
    console.log(`    Index on ${lbl}: exists/skipped`);
  }
}

// 3. Insert edges
const relRows = [];
result.graph.forEachRelationship((rel) => {
  relRows.push({
    from: rel.sourceId,
    to: rel.targetId,
    type: rel.type ?? 'CALLS',
    confidence: rel.confidence ?? null,
    reason: rel.reason ?? null,
    step: rel.step ?? null,
  });
});

console.log(`\n  [3/3] Inserting ${relRows.length.toLocaleString()} edges (batch=${EDGE_BATCH})...\n`);

const relCypher = `
  UNWIND $batch AS row
  MATCH (a {id: row.from}), (b {id: row.to})
  MERGE (a)-[r:CodeRelation {type: row.type}]->(b)
  SET r += row
`;

const t1 = Date.now();
let inserted = 0;
for (let i = 0; i < relRows.length; i += EDGE_BATCH) {
  const batch = relRows.slice(i, i + EDGE_BATCH);
  await sendCypher(client, relCypher, { batch });
  inserted += batch.length;
  const pct = ((inserted / relRows.length) * 100).toFixed(1);
  const elapsed = ((Date.now() - t1) / 1000).toFixed(0);
  const rate = (inserted / ((Date.now() - t1) / 1000)).toFixed(0);
  process.stdout.write(`\r  Edges: ${inserted.toLocaleString()}/${relRows.length.toLocaleString()} (${pct}%) | ${elapsed}s | ${rate} edges/s`);
}

console.log(`\n\n  Done! ${inserted.toLocaleString()} edges in ${((Date.now() - t1) / 1000).toFixed(0)}s`);
client.destroy();
process.exit(0);
