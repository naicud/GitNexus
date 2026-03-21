/**
 * HTTP API Server
 *
 * REST API for browser-based clients to query the local .gitnexus/ index.
 * Also hosts the MCP server over StreamableHTTP for remote AI tool access.
 *
 * Security: binds to 127.0.0.1 by default (use --host to override).
 * CORS is restricted to localhost and the deployed site.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { AwsClient } from 'aws4fetch';
import { loadMeta, listRegisteredRepos, updateRepoDb } from '../storage/repo-manager.js';
import { executeQuery, executeParameterizedQuery, closeLbug, withLbugDb } from '../core/lbug/lbug-adapter.js';
import { NODE_TABLES } from '../core/lbug/schema.js';
import { GraphNode, GraphRelationship } from '../core/graph/types.js';
import { searchFTSFromLbug } from '../core/search/bm25-index.js';
import { hybridSearch } from '../core/search/hybrid-search.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at server startup — crashes on unsupported Node ABI versions (#89)
import { LocalBackend } from '../mcp/local/local-backend.js';
import { mountMCPEndpoints } from './mcp-http.js';
import type { DbConfig, NeptuneDbConfig } from '../core/db/interfaces.js';
import { NeptuneAdapter } from '../core/db/neptune/neptune-adapter.js';

/** Resolve DB config for a registry entry. Falls back to LadybugDB. */
function getDbConfigFromEntry(entry: { storagePath: string; db?: DbConfig }): DbConfig {
  if ((entry as any).db) {
    // Backwards compat: old entries may have type 'kuzu' from before migration
    if ((entry as any).db.type === 'kuzu') {
      return { type: 'lbug', lbugPath: path.join(entry.storagePath, 'lbug') };
    }
    return (entry as any).db;
  }
  return { type: 'lbug', lbugPath: path.join(entry.storagePath, 'lbug') };
}


const NODE_HARD_CAP = 20000;

const buildGraph = async (limit?: number): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[]; truncated: boolean; totalAvailable: number }> => {
  const cap = limit ?? NODE_HARD_CAP;
  const nodes: GraphNode[] = [];
  let totalAvailable = 0;
  let remaining = cap;

  for (const table of NODE_TABLES) {
    if (remaining <= 0) break;
    try {
      const prevRemaining = remaining;
      let query = '';
      if (table === 'File') {
        query = `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT ${remaining}`;
      } else if (table === 'Folder') {
        query = `MATCH (n:Folder) RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT ${remaining}`;
      } else if (table === 'Community') {
        query = `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount LIMIT ${remaining}`;
      } else if (table === 'Process') {
        query = `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId LIMIT ${remaining}`;
      } else {
        query = `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine LIMIT ${remaining}`;
      }

      const rows = await executeQuery(query);
      for (const row of rows) {
        nodes.push({
          id: row.id ?? row[0],
          label: table as GraphNode['label'],
          properties: {
            name: row.name ?? row.label ?? row[1],
            filePath: row.filePath ?? row[2],
            startLine: row.startLine,
            endLine: row.endLine,
            heuristicLabel: row.heuristicLabel,
            cohesion: row.cohesion,
            symbolCount: row.symbolCount,
            processType: row.processType,
            stepCount: row.stepCount,
            communities: row.communities,
            entryPointId: row.entryPointId,
            terminalId: row.terminalId,
          } as GraphNode['properties'],
        });
      }
      remaining -= rows.length;

      // Only run count query when we hit the LIMIT (table may have more rows)
      if (rows.length >= prevRemaining) {
        try {
          const countRows = await executeQuery(`MATCH (n:${table}) RETURN count(n) AS cnt`);
          totalAvailable += countRows[0]?.cnt ?? rows.length;
        } catch {
          totalAvailable += rows.length;
        }
      } else {
        totalAvailable += rows.length;
      }
    } catch {
      // ignore empty tables
    }
  }

  // Push edge filtering to Cypher (avoid fetching all edges for large repos)
  const nodeIds = nodes.map(n => n.id);
  const relationships: GraphRelationship[] = [];
  const relRows = await executeParameterizedQuery(
    `MATCH (a)-[r:CodeRelation]->(b)
     WHERE a.id IN $ids AND b.id IN $ids
     RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`,
    { ids: nodeIds },
  );
  for (const row of relRows) {
    relationships.push({
      id: `${row.sourceId}_${row.type}_${row.targetId}`,
      type: row.type,
      sourceId: row.sourceId,
      targetId: row.targetId,
      confidence: row.confidence,
      reason: row.reason,
      step: row.step,
    });
  }

  return { nodes, relationships, truncated: nodes.length < totalAvailable, totalAvailable };
};

/**
 * Generate a structural summary by querying the DB for filePath distribution.
 * Used when no communities exist (e.g., COBOL repos). Caches result to disk.
 */
const STRUCTURAL_SKIP_LABELS = new Set(['Community', 'Process', 'Folder']);
const STRUCTURAL_NODE_LABELS = NODE_TABLES.filter(t => !STRUCTURAL_SKIP_LABELS.has(t));

const toGroupKey = (filePath: string): string => {
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length < 2) return '(root)';
  if (['src', 'lib', 'app', 'packages'].includes(parts[0].toLowerCase()) && parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
};

async function buildStructuralSummaryFromDb(
  queryFn: (cypher: string) => Promise<any[]>,
  storagePath: string,
  totalNodes: number,
  totalEdges: number,
): Promise<any> {
  const MAX_GROUPS = 200;
  const dirCounts = new Map<string, number>();

  // Step 1: Aggregate node counts by directory from each symbol table
  for (const table of STRUCTURAL_NODE_LABELS) {
    try {
      const rows = await queryFn(
        `MATCH (n:${table}) WHERE n.filePath IS NOT NULL RETURN n.filePath AS fp, count(*) AS cnt`
      );
      for (const row of rows) {
        const key = toGroupKey(String(row.fp || ''));
        dirCounts.set(key, (dirCounts.get(key) || 0) + (typeof row.cnt === 'number' ? row.cnt : 1));
      }
    } catch { /* table may not exist */ }
  }

  // Step 2: Sort and cap at MAX_GROUPS
  let sorted = Array.from(dirCounts.entries()).sort((a, b) => b[1] - a[1]);
  if (sorted.length > MAX_GROUPS) {
    const kept = sorted.slice(0, MAX_GROUPS - 1);
    const otherCount = sorted.slice(MAX_GROUPS - 1).reduce((sum, [, c]) => sum + c, 0);
    kept.push(['Other', otherCount]);
    sorted = kept;
  }

  const clusterGroups = sorted
    .filter(([, count]) => count >= 5)
    .map(([label, count]) => ({
      id: `cg_${label}`,
      label,
      symbolCount: count,
      cohesion: 0.5,
      subCommunityIds: [] as string[],
      subCommunityCount: 0,
    }));

  // Step 3: Sample cross-directory edges (with timeout to avoid blocking)
  const validGroups = new Set(clusterGroups.map(g => g.label));
  const edgeCounts = new Map<string, { count: number; types: Record<string, number> }>();
  const interGroupEdges: any[] = [];

  try {
    const sampleEdges = async () => {
      try {
        const rows = await queryFn(`
          MATCH (a)-[r:CodeRelation]->(b)
          WHERE a.filePath IS NOT NULL AND b.filePath IS NOT NULL AND a.filePath <> b.filePath
            AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
            AND r.type <> 'CONTAINS' AND r.type <> 'DEFINES'
          RETURN a.filePath AS srcFp, b.filePath AS tgtFp, r.type AS relType
          LIMIT 30000
        `);
        for (const row of rows) {
          const srcGroup = toGroupKey(String(row.srcFp || ''));
          const tgtGroup = toGroupKey(String(row.tgtFp || ''));
          if (srcGroup === tgtGroup || !validGroups.has(srcGroup) || !validGroups.has(tgtGroup)) continue;
          const relType = String(row.relType || 'UNKNOWN');
          const key = `cg_${srcGroup}|||cg_${tgtGroup}`;
          const existing = edgeCounts.get(key);
          if (existing) {
            existing.count++;
            existing.types[relType] = (existing.types[relType] || 0) + 1;
          } else {
            edgeCounts.set(key, { count: 1, types: { [relType]: 1 } });
          }
        }
      } catch { /* non-fatal */ }
    };
    await Promise.race([
      sampleEdges(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('edge-timeout')), 15000)),
    ]);
  } catch { /* edge sampling timed out or failed — summary still usable without edges */ }

  for (const [key, data] of edgeCounts) {
    const [src, tgt] = key.split('|||');
    interGroupEdges.push({ sourceGroupId: src, targetGroupId: tgt, count: data.count, types: data.types });
  }
  interGroupEdges.sort((a: any, b: any) => b.count - a.count);

  const summary = {
    version: 1,
    summaryMode: 'structural',
    generatedAt: new Date().toISOString(),
    totalNodes,
    totalEdges,
    clusterGroups,
    interGroupEdges,
  };

  // Cache to disk for instant subsequent loads
  try {
    await fs.writeFile(path.join(storagePath, 'graph-summary.json'), JSON.stringify(summary), 'utf-8');
  } catch { /* cache write failure is non-fatal */ }

  return summary;
}

const statusFromError = (err: any): number => {
  const msg = String(err?.message ?? '');
  if (msg.includes('No indexed repositories') || msg.includes('not found')) return 404;
  if (msg.includes('Multiple repositories')) return 400;
  return 500;
};

const requestedRepo = (req: express.Request): string | undefined => {
  const fromQuery = typeof req.query.repo === 'string' ? req.query.repo : undefined;
  if (fromQuery) return fromQuery;

  if (req.body && typeof req.body === 'object' && typeof req.body.repo === 'string') {
    return req.body.repo;
  }

  return undefined;
};

export const createServer = async (port: number, host: string = '127.0.0.1') => {
  const app = express();

  // CORS: only allow localhost origins and the deployed site.
  // Non-browser requests (curl, server-to-server) have no origin and are allowed.
  app.use(cors({
    origin: (origin, callback) => {
      if (
        !origin
        || origin.startsWith('http://localhost:')
        || origin.startsWith('http://127.0.0.1:')
        || origin === 'https://gitnexus.vercel.app'
      ) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  }));
  app.use(express.json({ limit: '10mb' }));

  // Initialize MCP backend (multi-repo, shared across all MCP sessions)
  const backend = new LocalBackend();
  await backend.init();
  const cleanupMcp = mountMCPEndpoints(app, backend);

  // Helper: resolve a repo by name from the global registry, or default to first
  const resolveRepo = async (repoName?: string) => {
    const repos = await listRegisteredRepos();
    if (repos.length === 0) return null;
    if (repoName) return repos.find(r => r.name === repoName) || null;
    return repos[0]; // default to first
  };

  // ── /api/db/test — Test Neptune connectivity ───────────────────────
  app.post('/api/db/test', async (req, res) => {
    const { neptuneEndpoint, neptuneRegion, neptunePort } = req.body ?? {};

    if (!neptuneEndpoint || !neptuneRegion) {
      return res.status(400).json({ ok: false, error: 'neptuneEndpoint and neptuneRegion are required' });
    }

    const config: NeptuneDbConfig = {
      type: 'neptune',
      endpoint: neptuneEndpoint,
      region: neptuneRegion,
      port: typeof neptunePort === 'number' ? neptunePort : parseInt(neptunePort ?? '8182', 10),
    };

    try {
      const result = await NeptuneAdapter.test(config);
      return res.json({ ok: true, latencyMs: result.latencyMs });
    } catch (err: any) {
      return res.json({ ok: false, error: err.message ?? 'Connection failed' });
    }
  });

  // ── PATCH /api/repo/db — Update DB backend for a repo ────────────────
  app.patch('/api/repo/db', async (req, res) => {
    try {
      const { repo, db } = req.body ?? {};

      if (!repo || typeof repo !== 'string') {
        return res.status(400).json({ error: '"repo" is required and must be a string' });
      }

      if (!db || typeof db !== 'object' || (db.type !== 'lbug' && db.type !== 'neptune')) {
        return res.status(400).json({ error: '"db.type" must be "lbug" or "neptune"' });
      }

      if (db.type === 'neptune') {
        if (!db.endpoint || typeof db.endpoint !== 'string') {
          return res.status(400).json({ error: '"db.endpoint" is required for Neptune' });
        }
        if (!db.region || typeof db.region !== 'string') {
          return res.status(400).json({ error: '"db.region" is required for Neptune' });
        }
      }

      await updateRepoDb(repo, db);
      return res.json({ ok: true });
    } catch (err: any) {
      const status = err.message?.includes('not found') ? 404 : 500;
      return res.status(status).json({ error: err.message || 'Failed to update DB config' });
    }
  });

  // List all registered repos
  app.get('/api/repos', async (_req, res) => {
    try {
      const repos = await listRegisteredRepos();
      res.json(repos.map(r => ({
        name: r.name, path: r.path, indexedAt: r.indexedAt,
        lastCommit: r.lastCommit, stats: r.stats,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list repos' });
    }
  });

  // Get repo info
  app.get('/api/repo', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found. Run: gitnexus analyze' });
        return;
      }
      const meta = await loadMeta(entry.storagePath);
      res.json({
        name: entry.name,
        repoPath: entry.path,
        indexedAt: meta?.indexedAt ?? entry.indexedAt,
        stats: meta?.stats ?? entry.stats ?? {},
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get repo info' });
    }
  });

  // ── LOD: Graph info (auto-detection) ────────────────────────────────
  app.get('/api/graph/info', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const meta = await loadMeta(entry.storagePath);
      const totalNodes = meta?.stats?.nodes ?? 0;
      const totalEdges = meta?.stats?.edges ?? 0;

      let hasSummary = false;
      try {
        const summaryData = await fs.readFile(path.join(entry.storagePath, 'graph-summary.json'), 'utf-8');
        hasSummary = true;
        const parsed = JSON.parse(summaryData);
        hasSummary = Array.isArray(parsed.clusterGroups) && parsed.clusterGroups.length > 0;
      } catch { /* no summary file or invalid */ }

      const mode = (totalNodes > 50000) ? 'hierarchy' : (totalNodes > NODE_HARD_CAP) ? 'summary' : 'full';
      res.json({ totalNodes, totalEdges, hasSummary, mode, hierarchyAvailable: totalNodes > 100000 });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get graph info' });
    }
  });

  // ── LOD: Graph summary (cluster overview) ─────────────────────────
  app.get('/api/graph/summary', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      // Try cached summary first (instant read from disk)
      const summaryPath = path.join(entry.storagePath, 'graph-summary.json');
      try {
        const data = await fs.readFile(summaryPath, 'utf-8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed.clusterGroups) && parsed.clusterGroups.length > 0) {
          res.setHeader('Content-Type', 'application/json');
          res.send(data);
          return;
        }
      } catch { /* no valid cached summary */ }

      // No valid cached summary — generate on-the-fly
      const meta = await loadMeta(entry.storagePath);
      const totalNodes = meta?.stats?.nodes ?? 0;
      const totalEdges = meta?.stats?.edges ?? 0;
      const dbConfig = getDbConfigFromEntry(entry);

      if (dbConfig.type === 'neptune') {
        const adapter = new NeptuneAdapter(dbConfig);
        try {
          const summary = await buildStructuralSummaryFromDb(
            (q) => adapter.executeQuery(q),
            entry.storagePath, totalNodes, totalEdges,
          );
          await adapter.close();
          return res.json(summary);
        } catch (err: any) {
          await adapter.close();
          return res.status(500).json({ error: err.message || 'Failed to generate summary' });
        }
      }

      // LadybugDB path
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const summary = await withLbugDb(lbugPath, async () => {
        // Try community-based first
        const commRows = await executeQuery(
          `MATCH (c:Community) RETURN c.id AS id, c.heuristicLabel AS heuristicLabel, c.symbolCount AS symbolCount, c.cohesion AS cohesion`
        );

        // No communities — generate structural summary (e.g., COBOL repos)
        if (commRows.length === 0) {
          return buildStructuralSummaryFromDb(executeQuery, entry.storagePath, totalNodes, totalEdges);
        }

        // Community-based aggregation
        const groupMap = new Map<string, { ids: string[]; totalSymbols: number; weightedCohesion: number }>();
        for (const c of commRows) {
          const label = c.heuristicLabel || 'Unknown';
          const symbols = c.symbolCount || 0;
          const cohesion = c.cohesion || 0;
          const existing = groupMap.get(label);
          if (!existing) {
            groupMap.set(label, { ids: [c.id], totalSymbols: symbols, weightedCohesion: cohesion * symbols });
          } else {
            existing.ids.push(c.id);
            existing.totalSymbols += symbols;
            existing.weightedCohesion += cohesion * symbols;
          }
        }

        const clusterGroups = Array.from(groupMap.entries())
          .map(([label, g]) => ({
            id: `cg_${label}`,
            label,
            symbolCount: g.totalSymbols,
            cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
            subCommunityIds: g.ids,
            subCommunityCount: g.ids.length,
          }))
          .filter(c => c.symbolCount >= 5)
          .sort((a, b) => b.symbolCount - a.symbolCount);

        let interGroupEdges: any[] = [];
        try {
          const edgeRows = await executeQuery(`
            MATCH (a)-[r:CodeRelation]->(b),
                  (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(ca:Community),
                  (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(cb:Community)
            WHERE ca.id <> cb.id AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
            RETURN ca.heuristicLabel AS srcLabel, cb.heuristicLabel AS tgtLabel, r.type AS relType, count(*) AS cnt
          `);

          const edgeMap = new Map<string, { count: number; types: Record<string, number> }>();
          for (const row of edgeRows) {
            const key = `cg_${row.srcLabel}|||cg_${row.tgtLabel}`;
            const existing = edgeMap.get(key);
            if (existing) {
              existing.count += (row.cnt || 1);
              existing.types[row.relType] = (existing.types[row.relType] || 0) + (row.cnt || 1);
            } else {
              edgeMap.set(key, { count: row.cnt || 1, types: { [row.relType]: row.cnt || 1 } });
            }
          }

          interGroupEdges = Array.from(edgeMap.entries()).map(([key, data]) => {
            const [src, tgt] = key.split('|||');
            return { sourceGroupId: src, targetGroupId: tgt, count: data.count, types: data.types };
          }).sort((a, b) => b.count - a.count);
        } catch {
          // Inter-group edge query may fail on some schemas — non-fatal
        }

        return {
          version: 1,
          generatedAt: new Date().toISOString(),
          totalNodes,
          totalEdges,
          clusterGroups,
          interGroupEdges,
        };
      });

      res.json(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get graph summary' });
    }
  });

  // ── LOD: Expand cluster group ─────────────────────────────────────
  app.get('/api/graph/expand', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      const groupLabel = String(req.query.group ?? '').trim();
      if (!groupLabel) {
        res.status(400).json({ error: 'Missing "group" query parameter' });
        return;
      }

      const limit = Math.max(1, Math.min(3000, parseInt(String(req.query.limit ?? '1000'), 10) || 1000));

      // Determine expansion mode from cached summary
      let summaryMode = 'community';
      try {
        const summaryData = JSON.parse(await fs.readFile(path.join(entry.storagePath, 'graph-summary.json'), 'utf-8'));
        summaryMode = summaryData.summaryMode || 'community';
      } catch { /* default to community */ }

      const dbConfig = getDbConfigFromEntry(entry);

      // ── Structural expansion (directory-based) ──────────────────────
      if (summaryMode === 'structural') {
        const prefix = groupLabel === '(root)' ? null : `${groupLabel}/`;

        const structuralExpand = async (queryFn: (q: string) => Promise<any[]>, paramQueryFn: (q: string, p: Record<string, any>) => Promise<any[]>) => {
          const nodes: GraphNode[] = [];
          let remaining = limit;

          for (const table of STRUCTURAL_NODE_LABELS) {
            if (remaining <= 0) break;
            try {
              let rows: any[];
              if (prefix) {
                rows = await paramQueryFn(`
                  MATCH (n:${table}) WHERE n.filePath STARTS WITH $prefix
                  RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
                         n.startLine AS startLine, n.endLine AS endLine
                  LIMIT ${remaining}
                `, { prefix });
              } else {
                rows = await queryFn(`
                  MATCH (n:${table}) WHERE (n.filePath IS NULL OR NOT contains(n.filePath, '/'))
                  RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
                         n.startLine AS startLine, n.endLine AS endLine
                  LIMIT ${remaining}
                `);
              }
              for (const row of rows) {
                nodes.push({
                  id: row.id,
                  label: table as GraphNode['label'],
                  properties: { name: row.name || '', filePath: row.filePath || '', startLine: row.startLine, endLine: row.endLine },
                });
              }
              remaining -= rows.length;
            } catch { /* table may not exist */ }
          }

          // Get edges between returned nodes
          const nodeIds = nodes.map(n => n.id);
          const relationships: GraphRelationship[] = [];
          if (nodeIds.length > 0) {
            try {
              const relRows = await paramQueryFn(
                `MATCH (a)-[r:CodeRelation]->(b)
                 WHERE a.id IN $ids AND b.id IN $ids
                   AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
                 RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence`,
                { ids: nodeIds },
              );
              for (const row of relRows) {
                relationships.push({
                  id: `${row.sourceId}_${row.type}_${row.targetId}`,
                  type: row.type,
                  sourceId: row.sourceId,
                  targetId: row.targetId,
                  confidence: row.confidence ?? 1,
                  reason: '',
                });
              }
            } catch { /* non-fatal */ }
          }

          return {
            groupLabel,
            nodes,
            relationships,
            crossEdges: [] as any[],
            truncated: remaining <= 0,
            totalAvailable: remaining <= 0 ? nodes.length + 1 : nodes.length,
          };
        };

        if (dbConfig.type === 'neptune') {
          const adapter = new NeptuneAdapter(dbConfig);
          try {
            const result = await structuralExpand(
              (q) => adapter.executeQuery(q),
              (q, p) => adapter.executeParameterized(q, p),
            );
            await adapter.close();
            return res.json(result);
          } catch (err: any) {
            await adapter.close();
            return res.status(500).json({ error: err.message || 'Failed to expand group' });
          }
        }

        // LadybugDB structural expand
        const lbugPath = path.join(entry.storagePath, 'lbug');
        const result = await withLbugDb(lbugPath, () =>
          structuralExpand(executeQuery, executeParameterizedQuery)
        );
        return res.json(result);
      }

      // ── Community-based expansion ───────────────────────────────────
      if (dbConfig.type === 'neptune') {
        res.status(501).json({ error: 'Community-based group expansion not yet supported for Neptune' });
        return;
      }


      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, async () => {
        const nodeRows = await executeParameterizedQuery(`
          MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
          WHERE c.heuristicLabel = $groupLabel
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
                 n.startLine AS startLine, n.endLine AS endLine,
                 labels(n)[0] AS nodeLabel
          LIMIT ${limit}
        `, { groupLabel });

        const nodes: GraphNode[] = nodeRows.map(row => ({
          id: row.id,
          label: (row.nodeLabel || 'CodeElement') as GraphNode['label'],
          properties: {
            name: row.name || '',
            filePath: row.filePath || '',
            startLine: row.startLine,
            endLine: row.endLine,
          },
        }));

        const nodeIdSet = new Set(nodes.map(n => n.id));

        const relRows = await executeParameterizedQuery(`
          MATCH (a)-[r:CodeRelation]->(b),
                (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(ca:Community),
                (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(cb:Community)
          WHERE ca.heuristicLabel = $groupLabel
            AND cb.heuristicLabel = $groupLabel
            AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
          RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence
        `, { groupLabel });

        const relationships: GraphRelationship[] = relRows
          .filter(row => nodeIdSet.has(row.sourceId) && nodeIdSet.has(row.targetId))
          .map(row => ({
            id: `${row.sourceId}_${row.type}_${row.targetId}`,
            type: row.type,
            sourceId: row.sourceId,
            targetId: row.targetId,
            confidence: row.confidence ?? 1,
            reason: '',
          }));

        const crossRows = await executeParameterizedQuery(`
          MATCH (a)-[r:CodeRelation]->(b),
                (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(ca:Community),
                (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(cb:Community)
          WHERE ca.heuristicLabel = $groupLabel
            AND cb.heuristicLabel <> $groupLabel
            AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
          RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, cb.heuristicLabel AS targetGroup
          LIMIT 500
        `, { groupLabel });

        const crossEdges = crossRows
          .filter(row => nodeIdSet.has(row.sourceId))
          .map(row => ({
            sourceId: row.sourceId,
            targetId: row.targetId,
            type: row.type,
            targetGroup: row.targetGroup,
          }));

        let totalAvailable = nodes.length;
        try {
          const countRows = await executeParameterizedQuery(`
            MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
            WHERE c.heuristicLabel = $groupLabel
            RETURN count(n) AS cnt
          `, { groupLabel });
          totalAvailable = countRows[0]?.cnt ?? nodes.length;
        } catch { /* use nodes.length as fallback */ }

        return {
          groupLabel,
          nodes,
          relationships,
          crossEdges,
          truncated: nodes.length < totalAvailable,
          totalAvailable,
        };
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to expand group' });
    }
  });

  // ── LOD: Explore neighbors of a node ──────────────────────────────
  app.get('/api/graph/neighbors', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      const nodeId = String(req.query.node ?? '').trim();
      if (!nodeId) {
        res.status(400).json({ error: 'Missing "node" query parameter' });
        return;
      }

      const depth = Math.max(1, Math.min(3, parseInt(String(req.query.depth ?? '1'), 10) || 1));
      const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '200'), 10) || 200));

      // Optional type-filtered expansion params
      const types = req.query.types ? String(req.query.types).split(',').filter(Boolean) : null;
      const direction = String(req.query.direction ?? 'both');

      const dbConfig = getDbConfigFromEntry(entry);

      if (dbConfig.type === 'neptune') {
        const adapter = new NeptuneAdapter(dbConfig);
        try {
          const centerRows = await adapter.executeParameterized(
            `MATCH (n) WHERE n.id = $nodeId
             RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
                    n.startLine AS startLine, n.endLine AS endLine,
                    labels(n)[0] AS nodeLabel`,
            { nodeId },
          );
          if (centerRows.length === 0) {
            await adapter.close();
            return res.status(404).json({ error: 'Node not found' });
          }
          const cr = centerRows[0] as any;
          const centerNode: GraphNode = {
            id: cr.id as string, label: (cr.nodeLabel || 'CodeElement') as GraphNode['label'],
            properties: { name: (cr.name || '') as string, filePath: (cr.filePath || '') as string, startLine: cr.startLine as number, endLine: cr.endLine as number },
          };
          // Build direction pattern and type filter for Neptune
          const neptuneDirPattern = direction === 'inbound' ? '<-[r:CodeRelation]-' : direction === 'outbound' ? '-[r:CodeRelation]->' : '-[r:CodeRelation]-';
          const neptuneTypeFilter = types ? ' AND r.type IN $types' : '';
          const neptuneNeighborParams: Record<string, any> = types ? { nodeId, types } : { nodeId };

          const neighborRows = await adapter.executeParameterized(
            depth === 1
              ? `MATCH (start)${neptuneDirPattern}(n)
                 WHERE start.id = $nodeId AND n.id <> $nodeId${neptuneTypeFilter}
                 RETURN DISTINCT n.id AS id, n.name AS name, n.filePath AS filePath,
                        n.startLine AS startLine, n.endLine AS endLine,
                        labels(n)[0] AS nodeLabel
                 LIMIT ${limit}`
              : `MATCH (start)-[r:CodeRelation*1..${depth}]-(n)
                 WHERE start.id = $nodeId AND n.id <> $nodeId
                 RETURN DISTINCT n.id AS id, n.name AS name, n.filePath AS filePath,
                        n.startLine AS startLine, n.endLine AS endLine,
                        labels(n)[0] AS nodeLabel
                 LIMIT ${limit}`,
            neptuneNeighborParams,
          );
          const nodes: GraphNode[] = neighborRows.map((row: any) => ({
            id: row.id, label: (row.nodeLabel || 'CodeElement') as GraphNode['label'],
            properties: { name: row.name || '', filePath: row.filePath || '', startLine: row.startLine, endLine: row.endLine },
          }));
          const allNodeIds = [nodeId, ...nodes.map(n => n.id)];
          const relRows = await adapter.executeParameterized(
            `MATCH (a)-[r:CodeRelation]->(b)
             WHERE a.id IN $ids AND b.id IN $ids
               AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
             RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence`,
            { ids: allNodeIds },
          );
          const relationships: GraphRelationship[] = relRows.map((row: any) => ({
            id: `${row.sourceId}_${row.type}_${row.targetId}`,
            type: row.type, sourceId: row.sourceId, targetId: row.targetId,
            confidence: row.confidence ?? 1, reason: '',
          }));
          await adapter.close();
          return res.json({ centerNode, nodes, relationships, truncated: nodes.length >= limit, totalAvailable: nodes.length });
        } catch (err: any) {
          await adapter.close();
          return res.status(500).json({ error: err.message || 'Failed to fetch neighbors' });
        }
      }


      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, async () => {
        // Get the center node (parameterized to prevent injection)
        const centerRows = await executeParameterizedQuery(
          `MATCH (n) WHERE n.id = $nodeId
           RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
                  n.startLine AS startLine, n.endLine AS endLine,
                  labels(n)[0] AS nodeLabel`,
          { nodeId },
        );

        if (centerRows.length === 0) {
          return { error: 'Node not found' };
        }

        const centerRow = centerRows[0];
        const centerNode: GraphNode = {
          id: centerRow.id,
          label: (centerRow.nodeLabel || 'CodeElement') as GraphNode['label'],
          properties: {
            name: centerRow.name || '',
            filePath: centerRow.filePath || '',
            startLine: centerRow.startLine,
            endLine: centerRow.endLine,
          },
        };

        // Get neighbors via variable-length paths (parameterized)
        // depth is already validated as integer 1-3
        // Build direction pattern and type filter for LadybugDB
        const dirPattern = direction === 'inbound' ? '<-[r:CodeRelation]-' : direction === 'outbound' ? '-[r:CodeRelation]->' : '-[r:CodeRelation]-';
        const typeFilter = types ? ' AND r.type IN $types' : '';
        const neighborParams: Record<string, any> = types ? { nodeId, types } : { nodeId };

        const neighborRows = await executeParameterizedQuery(
          depth === 1
            ? `MATCH (start)${dirPattern}(n)
               WHERE start.id = $nodeId AND n.id <> $nodeId${typeFilter}
               RETURN DISTINCT n.id AS id, n.name AS name, n.filePath AS filePath,
                      n.startLine AS startLine, n.endLine AS endLine,
                      labels(n)[0] AS nodeLabel
               LIMIT ${limit}`
            : `MATCH (start)-[r:CodeRelation*1..${depth}]-(n)
               WHERE start.id = $nodeId AND n.id <> $nodeId
               RETURN DISTINCT n.id AS id, n.name AS name, n.filePath AS filePath,
                      n.startLine AS startLine, n.endLine AS endLine,
                      labels(n)[0] AS nodeLabel
               LIMIT ${limit}`,
          neighborParams,
        );

        const nodes: GraphNode[] = neighborRows.map(row => ({
          id: row.id,
          label: (row.nodeLabel || 'CodeElement') as GraphNode['label'],
          properties: {
            name: row.name || '',
            filePath: row.filePath || '',
            startLine: row.startLine,
            endLine: row.endLine,
          },
        }));

        // Get edges between returned nodes only (push filter to Cypher, not JS)
        const allNodeIds = [nodeId, ...nodes.map(n => n.id)];
        const relRows = await executeParameterizedQuery(
          `MATCH (a)-[r:CodeRelation]->(b)
           WHERE a.id IN $ids AND b.id IN $ids
             AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
           RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence`,
          { ids: allNodeIds },
        );

        const relationships: GraphRelationship[] = relRows.map(row => ({
          id: `${row.sourceId}_${row.type}_${row.targetId}`,
          type: row.type,
          sourceId: row.sourceId,
          targetId: row.targetId,
          confidence: row.confidence ?? 1,
          reason: '',
        }));

        // Skip expensive count query if we got fewer than the limit
        let totalAvailable = nodes.length;
        if (nodes.length >= limit) {
          try {
            const countRows = await executeParameterizedQuery(
              depth === 1
                ? `MATCH (start)-[r:CodeRelation]-(n)
                   WHERE start.id = $nodeId AND n.id <> $nodeId
                   RETURN count(DISTINCT n) AS cnt`
                : `MATCH (start)-[r:CodeRelation*1..${depth}]-(n)
                   WHERE start.id = $nodeId AND n.id <> $nodeId
                   RETURN count(DISTINCT n) AS cnt`,
              { nodeId },
            );
            totalAvailable = countRows[0]?.cnt ?? nodes.length;
          } catch { /* use nodes.length as fallback */ }
        }

        return {
          centerNode,
          nodes,
          relationships,
          truncated: nodes.length < totalAvailable,
          totalAvailable,
        };
      });

      if ((result as any).error) {
        res.status(404).json(result);
        return;
      }

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch neighbors' });
    }
  });

  // ── LOD: Hierarchy drill-down ────────────────────────────────────────
  app.get('/api/graph/hierarchy', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      const parentId = req.query.parentId ? String(req.query.parentId).trim() : null;
      const namePrefix = req.query.namePrefix ? String(req.query.namePrefix).trim() : null;
      const limit = Math.max(1, Math.min(2000, parseInt(String(req.query.limit ?? '500'), 10) || 500));
      const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

      const dbConfig = getDbConfigFromEntry(entry);

      if (dbConfig.type === 'neptune') {
        const adapter = new NeptuneAdapter(dbConfig);
        try {
          if (!parentId) {
            // L0: Return Folder nodes
            const rows = await adapter.executeQuery(
              `MATCH (f:Folder)
               OPTIONAL MATCH (f)-[r:CodeRelation]->(child) WHERE r.type IN ['CONTAINS', 'DEFINES']
               WITH f, count(child) AS cc
               RETURN f.id AS id, f.name AS name, f.filePath AS filePath, cc AS childCount
               ORDER BY f.name`
            );
            const children = rows.map((row: any) => ({
              id: row.id as string,
              name: row.name as string,
              type: 'Folder',
              filePath: (row.filePath || '') as string,
              childCount: typeof row.childCount === 'number' ? row.childCount : Number(row.childCount || 0),
              descendantCount: 0,
              hasChildren: (typeof row.childCount === 'number' ? row.childCount : Number(row.childCount || 0)) > 0,
            }));
            await adapter.close();
            return res.json({
              parentId: null,
              parentType: null,
              children,
              totalChildren: children.length,
              truncated: false,
            });
          }

          // Specific parent: first get total count
          const countRows = await adapter.executeParameterized(
            `MATCH (parent)-[r:CodeRelation]->(child)
             WHERE parent.id = $parentId AND r.type IN ['CONTAINS', 'DEFINES']
             RETURN count(child) AS total`,
            { parentId },
          );
          const totalChildren = Number(countRows[0]?.total ?? 0);

          // If too many children and no prefix filter, return virtual groups
          if (totalChildren > 500 && !namePrefix) {
            const groupRows = await adapter.executeParameterized(
              `MATCH (parent)-[r:CodeRelation]->(child)
               WHERE parent.id = $parentId AND r.type IN ['CONTAINS', 'DEFINES']
               RETURN left(child.name, 2) AS prefix, count(*) AS cnt,
                      collect(child.name)[0..3] AS sampleNames
               ORDER BY prefix`,
              { parentId },
            );
            const virtualGroups = groupRows.map((row: any) => ({
              prefix: row.prefix as string,
              count: typeof row.cnt === 'number' ? row.cnt : Number(row.cnt || 0),
              sampleNames: Array.isArray(row.sampleNames) ? row.sampleNames : [],
            }));

            // Also get parent type
            const parentRows = await adapter.executeParameterized(
              `MATCH (p) WHERE p.id = $parentId RETURN labels(p)[0] AS type`,
              { parentId },
            );
            const parentType = parentRows[0]?.type ?? null;
            await adapter.close();
            return res.json({
              parentId,
              parentType,
              children: [],
              totalChildren,
              truncated: true,
              virtualGroups,
            });
          }

          // Return children with child counts
          const prefixFilter = namePrefix ? ' AND child.name STARTS WITH $namePrefix' : '';
          const params: Record<string, any> = { parentId };
          if (namePrefix) params.namePrefix = namePrefix;

          const childRows = await adapter.executeParameterized(
            `MATCH (parent)-[r:CodeRelation]->(child)
             WHERE parent.id = $parentId AND r.type IN ['CONTAINS', 'DEFINES']${prefixFilter}
             WITH child, labels(child)[0] AS type
             OPTIONAL MATCH (child)-[r2:CodeRelation]->(gc) WHERE r2.type IN ['CONTAINS', 'DEFINES']
             WITH child, type, count(gc) AS childCount
             RETURN child.id AS id, child.name AS name, type, child.filePath AS filePath, childCount
             ORDER BY child.name
             SKIP ${offset} LIMIT ${limit}`,
            params,
          );

          const children = childRows.map((row: any) => ({
            id: row.id as string,
            name: row.name as string,
            type: (row.type || 'CodeElement') as string,
            filePath: (row.filePath || '') as string,
            childCount: typeof row.childCount === 'number' ? row.childCount : Number(row.childCount || 0),
            descendantCount: 0,
            hasChildren: (typeof row.childCount === 'number' ? row.childCount : Number(row.childCount || 0)) > 0,
          }));

          // Get parent type
          const parentRows = await adapter.executeParameterized(
            `MATCH (p) WHERE p.id = $parentId RETURN labels(p)[0] AS type`,
            { parentId },
          );
          const parentType = parentRows[0]?.type ?? null;

          // Recount with prefix filter if applicable
          let filteredTotal = totalChildren;
          if (namePrefix) {
            const filteredCountRows = await adapter.executeParameterized(
              `MATCH (parent)-[r:CodeRelation]->(child)
               WHERE parent.id = $parentId AND r.type IN ['CONTAINS', 'DEFINES'] AND child.name STARTS WITH $namePrefix
               RETURN count(child) AS total`,
              { parentId, namePrefix },
            );
            filteredTotal = Number(filteredCountRows[0]?.total ?? 0);
          }

          await adapter.close();
          return res.json({
            parentId,
            parentType,
            children,
            totalChildren: filteredTotal,
            truncated: (offset + children.length) < filteredTotal,
          });
        } catch (err: any) {
          await adapter.close();
          return res.status(500).json({ error: err.message || 'Failed to fetch hierarchy' });
        }
      }


      // LadybugDB path
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, async () => {
        if (!parentId) {
          // L0: Return Folder nodes
          const rows = await executeQuery(
            `MATCH (f:Folder)
             OPTIONAL MATCH (f)-[r:CodeRelation]->(child) WHERE r.type IN ['CONTAINS', 'DEFINES']
             WITH f, count(child) AS cc
             RETURN f.id AS id, f.name AS name, f.filePath AS filePath, cc AS childCount
             ORDER BY f.name`
          );
          const children = rows.map((row: any) => ({
            id: row.id as string,
            name: row.name as string,
            type: 'Folder',
            filePath: (row.filePath || '') as string,
            childCount: typeof row.childCount === 'number' ? row.childCount : Number(row.childCount || 0),
            descendantCount: 0,
            hasChildren: (typeof row.childCount === 'number' ? row.childCount : Number(row.childCount || 0)) > 0,
          }));
          return {
            parentId: null,
            parentType: null,
            children,
            totalChildren: children.length,
            truncated: false,
          };
        }

        // Specific parent: first get total count
        const countRows = await executeParameterizedQuery(
          `MATCH (parent)-[r:CodeRelation]->(child)
           WHERE parent.id = $parentId AND r.type IN ['CONTAINS', 'DEFINES']
           RETURN count(child) AS total`,
          { parentId },
        );
        const totalChildren = countRows[0]?.total ?? 0;

        // If too many children and no prefix filter, return virtual groups
        if (totalChildren > 500 && !namePrefix) {
          const groupRows = await executeParameterizedQuery(
            `MATCH (parent)-[r:CodeRelation]->(child)
             WHERE parent.id = $parentId AND r.type IN ['CONTAINS', 'DEFINES']
             RETURN left(child.name, 2) AS prefix, count(*) AS cnt,
                    collect(child.name)[0..3] AS sampleNames
             ORDER BY prefix`,
            { parentId },
          );
          const virtualGroups = groupRows.map((row: any) => ({
            prefix: row.prefix as string,
            count: typeof row.cnt === 'number' ? row.cnt : Number(row.cnt || 0),
            sampleNames: Array.isArray(row.sampleNames) ? row.sampleNames : [],
          }));

          // Get parent type
          const parentRows = await executeParameterizedQuery(
            `MATCH (p) WHERE p.id = $parentId RETURN labels(p)[0] AS type`,
            { parentId },
          );
          const parentType = parentRows[0]?.type ?? null;
          return {
            parentId,
            parentType,
            children: [],
            totalChildren,
            truncated: true,
            virtualGroups,
          };
        }

        // Return children with child counts
        const prefixFilter = namePrefix
          ? ` AND child.name STARTS WITH $namePrefix`
          : '';
        const params: Record<string, any> = { parentId };
        if (namePrefix) params.namePrefix = namePrefix;

        const childRows = await executeParameterizedQuery(
          `MATCH (parent)-[r:CodeRelation]->(child)
           WHERE parent.id = $parentId AND r.type IN ['CONTAINS', 'DEFINES']${prefixFilter}
           WITH child, labels(child)[0] AS type
           OPTIONAL MATCH (child)-[r2:CodeRelation]->(gc) WHERE r2.type IN ['CONTAINS', 'DEFINES']
           WITH child, type, count(gc) AS childCount
           RETURN child.id AS id, child.name AS name, type, child.filePath AS filePath, childCount
           ORDER BY child.name
           SKIP ${offset} LIMIT ${limit}`,
          params,
        );

        const children = childRows.map((row: any) => ({
          id: row.id as string,
          name: row.name as string,
          type: (row.type || 'CodeElement') as string,
          filePath: (row.filePath || '') as string,
          childCount: typeof row.childCount === 'number' ? row.childCount : Number(row.childCount || 0),
          descendantCount: 0,
          hasChildren: (typeof row.childCount === 'number' ? row.childCount : Number(row.childCount || 0)) > 0,
        }));

        // Get parent type
        const parentRows = await executeParameterizedQuery(
          `MATCH (p) WHERE p.id = $parentId RETURN labels(p)[0] AS type`,
          { parentId },
        );
        const parentType = parentRows[0]?.type ?? null;

        // Recount with prefix filter if applicable
        let filteredTotal = totalChildren;
        if (namePrefix) {
          const filteredCountRows = await executeParameterizedQuery(
            `MATCH (parent)-[r:CodeRelation]->(child)
             WHERE parent.id = $parentId AND r.type IN ['CONTAINS', 'DEFINES'] AND child.name STARTS WITH $namePrefix
             RETURN count(child) AS total`,
            { parentId, namePrefix },
          );
          filteredTotal = filteredCountRows[0]?.total ?? 0;
        }

        return {
          parentId,
          parentType,
          children,
          totalChildren: filteredTotal,
          truncated: (offset + children.length) < filteredTotal,
        };
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch hierarchy' });
    }
  });

  // ── LOD: Hierarchy ancestor path ─────────────────────────────────────
  app.get('/api/graph/hierarchy/ancestors', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      const nodeId = String(req.query.nodeId ?? '').trim();
      if (!nodeId) {
        res.status(400).json({ error: 'Missing "nodeId" query parameter' });
        return;
      }

      const dbConfig = getDbConfigFromEntry(entry);

      if (dbConfig.type === 'neptune') {
        const adapter = new NeptuneAdapter(dbConfig);
        try {
          // Get the target node
          const targetRows = await adapter.executeParameterized(
            `MATCH (target) WHERE target.id = $nodeId
             OPTIONAL MATCH (target)-[r:CodeRelation]->(gc) WHERE r.type IN ['CONTAINS', 'DEFINES']
             WITH target, count(gc) AS childCount
             RETURN target.id AS id, target.name AS name, labels(target)[0] AS type,
                    target.filePath AS filePath, childCount`,
            { nodeId },
          );
          if (targetRows.length === 0) {
            await adapter.close();
            return res.status(404).json({ error: 'Node not found' });
          }
          const tr = targetRows[0] as any;
          const node = {
            id: tr.id as string,
            name: tr.name as string,
            type: (tr.type || 'CodeElement') as string,
            filePath: (tr.filePath || '') as string,
            childCount: typeof tr.childCount === 'number' ? tr.childCount : Number(tr.childCount || 0),
            descendantCount: 0,
            hasChildren: (typeof tr.childCount === 'number' ? tr.childCount : Number(tr.childCount || 0)) > 0,
          };

          // Walk up parent chain (max 10 levels)
          const ancestors: typeof node[] = [];
          let currentId = nodeId;
          for (let i = 0; i < 10; i++) {
            const parentRows = await adapter.executeParameterized(
              `MATCH (parent)-[r:CodeRelation]->(child)
               WHERE child.id = $childId AND r.type IN ['CONTAINS', 'DEFINES']
               OPTIONAL MATCH (parent)-[r2:CodeRelation]->(gc) WHERE r2.type IN ['CONTAINS', 'DEFINES']
               WITH parent, count(gc) AS childCount
               RETURN parent.id AS id, parent.name AS name, labels(parent)[0] AS type,
                      parent.filePath AS filePath, childCount
               LIMIT 1`,
              { childId: currentId },
            );
            if (parentRows.length === 0) break;
            const pr = parentRows[0] as any;
            ancestors.unshift({
              id: pr.id as string,
              name: pr.name as string,
              type: (pr.type || 'CodeElement') as string,
              filePath: (pr.filePath || '') as string,
              childCount: typeof pr.childCount === 'number' ? pr.childCount : Number(pr.childCount || 0),
              descendantCount: 0,
              hasChildren: (typeof pr.childCount === 'number' ? pr.childCount : Number(pr.childCount || 0)) > 0,
            });
            currentId = pr.id;
          }

          await adapter.close();
          return res.json({ node, ancestors });
        } catch (err: any) {
          await adapter.close();
          return res.status(500).json({ error: err.message || 'Failed to fetch ancestors' });
        }
      }


      // LadybugDB path
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, async () => {
        // Get the target node
        const targetRows = await executeParameterizedQuery(
          `MATCH (target) WHERE target.id = $nodeId
           OPTIONAL MATCH (target)-[r:CodeRelation]->(gc) WHERE r.type IN ['CONTAINS', 'DEFINES']
           WITH target, count(gc) AS childCount
           RETURN target.id AS id, target.name AS name, labels(target)[0] AS type,
                  target.filePath AS filePath, childCount`,
          { nodeId },
        );
        if (targetRows.length === 0) {
          return { error: 'Node not found' };
        }
        const tr = targetRows[0] as any;
        const node = {
          id: tr.id as string,
          name: tr.name as string,
          type: (tr.type || 'CodeElement') as string,
          filePath: (tr.filePath || '') as string,
          childCount: typeof tr.childCount === 'number' ? tr.childCount : Number(tr.childCount || 0),
          descendantCount: 0,
          hasChildren: (typeof tr.childCount === 'number' ? tr.childCount : Number(tr.childCount || 0)) > 0,
        };

        // Walk up parent chain (max 10 levels)
        const ancestors: typeof node[] = [];
        let currentId = nodeId;
        for (let i = 0; i < 10; i++) {
          const parentRows = await executeParameterizedQuery(
            `MATCH (parent)-[r:CodeRelation]->(child)
             WHERE child.id = $currentId AND r.type IN ['CONTAINS', 'DEFINES']
             OPTIONAL MATCH (parent)-[r2:CodeRelation]->(gc) WHERE r2.type IN ['CONTAINS', 'DEFINES']
             WITH parent, count(gc) AS childCount
             RETURN parent.id AS id, parent.name AS name, labels(parent)[0] AS type,
                    parent.filePath AS filePath, childCount
             LIMIT 1`,
            { currentId },
          );
          if (parentRows.length === 0) break;
          const pr = parentRows[0] as any;
          ancestors.unshift({
            id: pr.id as string,
            name: pr.name as string,
            type: (pr.type || 'CodeElement') as string,
            filePath: (pr.filePath || '') as string,
            childCount: typeof pr.childCount === 'number' ? pr.childCount : Number(pr.childCount || 0),
            descendantCount: 0,
            hasChildren: (typeof pr.childCount === 'number' ? pr.childCount : Number(pr.childCount || 0)) > 0,
          });
          currentId = pr.id;
        }

        return { node, ancestors };
      });

      if ((result as any).error) {
        res.status(404).json(result);
        return;
      }

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch ancestors' });
    }
  });

  // ── LOD: Neighbor counts by relationship type ──────────────────────
  app.get('/api/graph/neighbor-counts', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      const nodeId = String(req.query.node ?? '').trim();
      if (!nodeId) {
        res.status(400).json({ error: 'Missing "node" query parameter' });
        return;
      }

      const dbConfig = getDbConfigFromEntry(entry);

      if (dbConfig.type === 'neptune') {
        res.status(501).json({ error: 'Neighbor counts not supported on Neptune' });
        return;
      }

      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, async () => {
        // Inbound counts: other nodes → this node, grouped by relationship type

        const inboundRows = await executeParameterizedQuery(
          `MATCH (other)-[r:CodeRelation]->(n)
           WHERE n.id = $nodeId AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
           RETURN r.type AS relType, count(*) AS cnt`,
          { nodeId },
        );
        const inbound: Record<string, number> = {};
        for (const row of inboundRows) {
          inbound[row.relType] = row.cnt;
        }

        // Outbound counts: this node → other nodes, grouped by relationship type

        const outboundRows = await executeParameterizedQuery(
          `MATCH (n)-[r:CodeRelation]->(other)
           WHERE n.id = $nodeId AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
           RETURN r.type AS relType, count(*) AS cnt`,
          { nodeId },
        );
        const outbound: Record<string, number> = {};
        for (const row of outboundRows) {
          outbound[row.relType] = row.cnt;
        }

        const total = Object.values(inbound).reduce((s, c) => s + c, 0) + Object.values(outbound).reduce((s, c) => s + c, 0);
        return { inbound, outbound, total };
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch neighbor counts' });
    }
  });

  // Graph schema — node types + relationship patterns with counts
  app.get('/api/graph/schema', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      const dbConfig = getDbConfigFromEntry(entry);

      if (dbConfig.type === 'neptune') {
        res.status(501).json({ error: 'Schema graph not supported on Neptune' });
        return;
      }


      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, async () => {
        // Node type counts
        const nodeRows = await executeQuery(
          `MATCH (n) RETURN labels(n)[0] AS nodeType, count(*) AS cnt`,
        );
        const nodeTypes = nodeRows.map((row: any) => ({
          type: row.nodeType,
          count: typeof row.cnt === 'number' ? row.cnt : Number(row.cnt),
        }));

        // Relationship type patterns (excluding internal edges)
        const edgeRows = await executeQuery(
          `MATCH (a)-[r:CodeRelation]->(b)
           WHERE r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
           RETURN labels(a)[0] AS sourceType, labels(b)[0] AS targetType, r.type AS relType, count(*) AS cnt`,
        );
        const edgeTypes = edgeRows.map((row: any) => ({
          sourceType: row.sourceType,
          targetType: row.targetType,
          type: row.relType,
          count: typeof row.cnt === 'number' ? row.cnt : Number(row.cnt),
        }));

        return { nodeTypes, edgeTypes };
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch graph schema' });
    }
  });

  // Get full graph
  app.get('/api/graph', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }


      const dbConfig = getDbConfigFromEntry(entry);

      // Neptune path (with same NODE_HARD_CAP as LadybugDB)
      if (dbConfig.type === 'neptune') {
        const adapter = new NeptuneAdapter(dbConfig);
        try {
          const nodes: GraphNode[] = [];
          let remaining = NODE_HARD_CAP;
          for (const table of NODE_TABLES) {
            if (remaining <= 0) break;
            try {
              let query = '';
              if (table === 'File') {
                query = `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT ${remaining}`;
              } else if (table === 'Folder') {
                query = `MATCH (n:Folder) RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT ${remaining}`;
              } else if (table === 'Community') {
                query = `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount LIMIT ${remaining}`;
              } else if (table === 'Process') {
                query = `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId LIMIT ${remaining}`;
              } else {
                query = `MATCH (n:\`${table}\`) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine LIMIT ${remaining}`;
              }
              const rows = await adapter.executeQuery(query);
              for (const row of rows) {
                nodes.push({
                  id: (row.id ?? row[0]) as string,
                  label: table as GraphNode['label'],
                  properties: {
                    name: row.name ?? row.label ?? row[1],
                    filePath: row.filePath ?? row[2],
                    startLine: row.startLine,
                    endLine: row.endLine,
                    heuristicLabel: row.heuristicLabel,
                    cohesion: row.cohesion,
                    symbolCount: row.symbolCount,
                    processType: row.processType,
                    stepCount: row.stepCount,
                    communities: row.communities,
                    entryPointId: row.entryPointId,
                    terminalId: row.terminalId,
                  } as GraphNode['properties'],
                });
              }
              remaining -= rows.length;
            } catch { /* ignore empty labels */ }
          }
          const nodeIds = nodes.map(n => n.id);
          const relRows = await adapter.executeParameterized(
            `MATCH (a)-[r:CodeRelation]->(b)
             WHERE a.id IN $ids AND b.id IN $ids
             RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`,
            { ids: nodeIds },
          );
          const relationships: GraphRelationship[] = relRows.map(row => ({
            id: `${row.sourceId}_${row.type}_${row.targetId}`,
            type: row.type as GraphRelationship['type'],
            sourceId: row.sourceId as string,
            targetId: row.targetId as string,
            confidence: row.confidence as number,
            reason: row.reason as string,
            step: row.step as number,
          }));
          await adapter.close();
          return res.json({ nodes, relationships, truncated: true, totalAvailable: NODE_HARD_CAP });
        } catch (err: any) {
          await adapter.close();
          return res.status(500).json({ error: err.message || 'Failed to build graph' });
        }
      }


      // LadybugDB path (default)
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, async () => buildGraph());
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to build graph' });
    }
  });

  // Execute Cypher query
  app.post('/api/query', async (req, res) => {
    try {
      const cypher = req.body.cypher as string;
      if (!cypher) {
        res.status(400).json({ error: 'Missing "cypher" in request body' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }


      const dbConfig = getDbConfigFromEntry(entry);

      // Neptune path
      if (dbConfig.type === 'neptune') {
        const adapter = new NeptuneAdapter(dbConfig);
        try {
          const result = await adapter.executeQuery(cypher);
          await adapter.close();
          return res.json({ result });
        } catch (err: any) {
          await adapter.close();
          return res.status(500).json({ error: err.message || 'Query failed' });
        }
      }

      // LadybugDB path (default)
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, () => executeQuery(cypher));
      res.json({ result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Query failed' });
    }
  });

  // Search
  app.post('/api/search', async (req, res) => {
    try {
      const query = (req.body.query ?? '').trim();
      if (!query) {
        res.status(400).json({ error: 'Missing "query" in request body' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }


      const parsedLimit = Number(req.body.limit ?? 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(100, Math.trunc(parsedLimit)))
        : 10;


      const dbConfig = getDbConfigFromEntry(entry);

      // Neptune path — text-predicate fallback (no FTS indexes)
      if (dbConfig.type === 'neptune') {
        const adapter = new NeptuneAdapter(dbConfig);
        try {
          const rows = await adapter.executeParameterized(`
            MATCH (n)
            WHERE n.name CONTAINS $q OR n.filePath CONTAINS $q
            RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
                   n.filePath AS filePath, n.startLine AS startLine
            LIMIT toInteger($limit)
          `, { q: query, limit });
          await adapter.close();
          return res.json({ results: rows });
        } catch (err: any) {
          await adapter.close();
          return res.status(500).json({ error: err.message || 'Search failed' });
        }
      }

      // LadybugDB path (default)
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const results = await withLbugDb(lbugPath, async () => {
        const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
        if (isEmbedderReady()) {
          const { semanticSearch } = await import('../core/embeddings/embedding-pipeline.js');
          const { embedQuery, getEmbeddingDims } = await import('../mcp/core/embedder.js');
          const embeddingConfig = (entry as any).embedding;
          // Bridge: hybrid search expects (executeQuery, query, k) -> wrap new provider-aware signature
          const wrappedSemantic = async (eq: typeof executeQuery, q: string, k?: number) => {
            const queryVec = await embedQuery(q, embeddingConfig);
            const dims = getEmbeddingDims(embeddingConfig);
            return semanticSearch(eq, queryVec, dims, k);
          };
          return hybridSearch(query, limit, executeQuery, wrappedSemantic);
        }
        // FTS-only fallback when embeddings aren't loaded
        return searchFTSFromLbug(query, limit);
      });
      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  // Read file — with path traversal guard
  app.get('/api/file', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'Missing path' });
        return;
      }

      // Prevent path traversal — resolve and verify the path stays within the repo root
      const repoRoot = path.resolve(entry.path);
      const fullPath = path.resolve(repoRoot, filePath);
      if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot) {
        res.status(403).json({ error: 'Path traversal denied' });
        return;
      }

      const content = await fs.readFile(fullPath, 'utf-8');
      res.json({ content });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to read file' });
      }
    }
  });

  // List all processes
  app.get('/api/processes', async (req, res) => {
    try {
      const result = await backend.queryProcesses(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query processes' });
    }
  });

  // Process detail
  app.get('/api/process', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await backend.queryProcessDetail(name, requestedRepo(req));
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query process detail' });
    }
  });

  // List all clusters
  app.get('/api/clusters', async (req, res) => {
    try {
      const result = await backend.queryClusters(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query clusters' });
    }
  });

  // Cluster detail
  app.get('/api/cluster', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await backend.queryClusterDetail(name, requestedRepo(req));
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query cluster detail' });
    }
  });

  // ── AWS Bedrock proxy endpoints ────────────────────────────────────────
  // Routes Bedrock API calls through the local server to bypass browser CORS/COEP.
  // Credentials are sent per-request (never stored server-side).

  /** Health check — minimal Converse call to validate credentials + model access */
  app.post('/api/bedrock/test', async (req, res) => {
    try {
      const { region, accessKeyId, secretAccessKey, sessionToken, model } = req.body;
      if (!region || !accessKeyId || !secretAccessKey || !model) {
        res.status(400).json({ ok: false, error: 'Missing required fields: region, accessKeyId, secretAccessKey, model' });
        return;
      }

      const aws = new AwsClient({
        accessKeyId,
        secretAccessKey,
        sessionToken: sessionToken || undefined,
        region,
        service: 'bedrock',
      });

      const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
      const resp = await aws.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
          inferenceConfig: { maxTokens: 1, temperature: 0 },
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        res.json({ ok: false, error: `${resp.status}: ${errBody}` });
        return;
      }

      res.json({ ok: true, model, region });
    } catch (err: any) {
      res.json({ ok: false, error: err.message || 'Unknown error' });
    }
  });

  /** Non-streaming Converse proxy */
  app.post('/api/bedrock/converse', async (req, res) => {
    try {
      const { region, credentials, model, body } = req.body;
      if (!region || !credentials?.accessKeyId || !credentials?.secretAccessKey || !model || !body) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }

      const aws = new AwsClient({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken || undefined,
        region,
        service: 'bedrock',
      });

      const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
      const awsResp = await aws.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!awsResp.ok) {
        const errBody = await awsResp.text();
        res.status(awsResp.status).json({ error: errBody });
        return;
      }

      const data = await awsResp.json();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Bedrock converse failed' });
    }
  });

  /** Streaming Converse proxy — parses AWS Event Stream binary and forwards as NDJSON */
  app.post('/api/bedrock/converse-stream', async (req, res) => {
    let aborted = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    // Detect client disconnect — abort the AWS stream immediately
    res.on('close', () => {
      if (!res.writableEnded) {
        aborted = true;
        try { reader?.cancel(); } catch { /* already closed */ }
      }
    });

    try {
      const { region, credentials, model, body } = req.body;
      if (!region || !credentials?.accessKeyId || !credentials?.secretAccessKey || !model || !body) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }

      const aws = new AwsClient({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken || undefined,
        region,
        service: 'bedrock',
      });

      const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse-stream`;

      // Timeout for the initial AWS response (model may take time to start generating)
      const fetchTimeout = 120_000; // 2 minutes
      const awsRespPromise = aws.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Bedrock request timed out')), fetchTimeout)
      );
      const awsResp = await Promise.race([awsRespPromise, timeoutPromise]) as Response;

      if (aborted) return;

      if (!awsResp.ok) {
        const errBody = await awsResp.text();
        if (!res.headersSent) res.status(awsResp.status).json({ error: errBody });
        return;
      }

      if (!awsResp.body) {
        if (!res.headersSent) res.status(502).json({ error: 'No response body from Bedrock' });
        return;
      }

      // Stream as NDJSON — parse AWS Event Stream binary server-side,
      // extract event type from binary headers and wrap the payload.
      // Output format matches what boto3/SDKs return: {"eventType": {payload}}
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
      res.flushHeaders();

      reader = (awsResp.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = new Uint8Array(0);

      // Timeout for individual chunk reads — if Bedrock goes silent for too long, abort
      const CHUNK_TIMEOUT = 120_000; // 2 minutes between chunks

      try {
        while (!aborted) {
          // Race reader.read() against a timeout
          const chunkTimeoutPromise = new Promise<{ done: true; value: undefined }>((_, reject) =>
            setTimeout(() => reject(new Error('Bedrock stream chunk timed out')), CHUNK_TIMEOUT)
          );
          const { done, value } = await Promise.race([reader.read(), chunkTimeoutPromise]);
          if (done || aborted) break;

          const merged = new Uint8Array(buf.length + value!.length);
          merged.set(buf);
          merged.set(value!, buf.length);
          buf = merged;

          // Parse complete AWS Event Stream frames
          // Binary framing: [4B totalLen][4B headersLen][4B preludeCRC][headers][payload][4B msgCRC]
          while (buf.length >= 12) {
            const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            const totalLen = view.getUint32(0);
            if (totalLen < 16 || totalLen > 16 * 1024 * 1024) {
              // Invalid frame — corrupted stream, skip remaining buffer
              buf = new Uint8Array(0);
              break;
            }
            if (buf.length < totalLen) break;

            const headersLen = view.getUint32(4);
            const headersStart = 12;
            const payloadStart = 12 + headersLen;
            const payloadLen = totalLen - headersLen - 16;

            // Parse binary headers to extract :event-type, :message-type, :exception-type
            let eventType = '';
            let messageType = '';
            let exceptionType = '';
            let offset = headersStart;
            const headersEnd = headersStart + headersLen;
            while (offset < headersEnd) {
              const nameLen = buf[offset]; offset += 1;
              const name = decoder.decode(buf.slice(offset, offset + nameLen)); offset += nameLen;
              const valueType = buf[offset]; offset += 1;
              if (valueType === 7) { // string
                const valLen = (buf[offset] << 8) | buf[offset + 1]; offset += 2;
                const val = decoder.decode(buf.slice(offset, offset + valLen)); offset += valLen;
                if (name === ':event-type') eventType = val;
                else if (name === ':message-type') messageType = val;
                else if (name === ':exception-type') exceptionType = val;
              } else if (valueType === 6) { // bytes
                const valLen = (buf[offset] << 8) | buf[offset + 1]; offset += 2;
                offset += valLen;
              } else if (valueType === 0 || valueType === 1) { // bool
                // no value bytes
              } else if (valueType === 2) { offset += 1;  // byte
              } else if (valueType === 3) { offset += 2;  // short
              } else if (valueType === 4) { offset += 4;  // int
              } else if (valueType === 5 || valueType === 8) { offset += 8; // long / timestamp
              } else {
                break; // unknown type, stop parsing headers
              }
            }

            if (payloadLen > 0 && !aborted) {
              const payload = buf.slice(payloadStart, payloadStart + payloadLen);
              try {
                const data = JSON.parse(decoder.decode(payload));

                // Handle exception frames — forward as NDJSON error and stop
                if (messageType === 'exception' || exceptionType) {
                  const errMsg = data.message || data.Message || exceptionType || 'Bedrock stream exception';
                  res.write(JSON.stringify({ __error: { type: exceptionType || eventType, message: errMsg } }) + '\n');
                  aborted = true;
                  break;
                }

                // Wrap payload with event type to match SDK format:
                // {"contentBlockDelta": {"delta": {"text": "..."}, "contentBlockIndex": 0}}
                const wrapped = eventType ? { [eventType]: data } : data;
                res.write(JSON.stringify(wrapped) + '\n');
              } catch { /* skip malformed frame */ }
            }

            buf = buf.slice(totalLen);
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }

      if (!res.writableEnded) res.end();
    } catch (err: any) {
      if (aborted) return; // client already gone
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Bedrock stream failed' });
      } else {
        // Stream already started — send error as NDJSON so client can see it
        try {
          res.write(JSON.stringify({ __error: { type: 'proxy_error', message: err.message || 'Bedrock stream failed' } }) + '\n');
        } catch { /* write failed, client gone */ }
        if (!res.writableEnded) res.end();
      }
    }
  });

  // Global error handler — catch anything the route handlers miss
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(port, host, () => {
    console.log(`GitNexus server running on http://${host}:${port}`);
  });

  // Graceful shutdown — close Express + LadybugDB cleanly
  const shutdown = async () => {
    server.close();
    await cleanupMcp();
    await closeLbug();
    await backend.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};
