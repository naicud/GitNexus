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
import { loadMeta, listRegisteredRepos, updateRepoDb } from '../storage/repo-manager.js';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { mountMCPEndpoints } from './mcp-http.js';
import type { NeptuneDbConfig } from '../core/db/interfaces.js';
import { NeptuneAdapter } from '../core/db/neptune/neptune-adapter.js';

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

  // Get full graph
  app.get('/api/graph', async (req, res) => {
    try {
      const graph = await backend.getGraphForApi(requestedRepo(req));
      if (!graph) {
        res.status(501).json({ error: 'Graph visualization is not supported for Neptune-backed repos. Use Cypher queries instead.' });
        return;
      }
      res.json(graph);
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
      const result = await backend.executeCypher(requestedRepo(req), cypher);
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
      const parsedLimit = Number(req.body.limit ?? 10);
      const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, Math.trunc(parsedLimit))) : 10;
      const results = await backend.searchForApi(requestedRepo(req), query, limit);
      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  // Test Neptune DB connection
  app.post('/api/db/test', async (req, res) => {
    try {
      const { neptuneEndpoint, neptuneRegion, neptunePort } = req.body;
      if (!neptuneEndpoint || !neptuneRegion) {
        res.status(400).json({ ok: false, error: 'neptuneEndpoint and neptuneRegion are required' });
        return;
      }
      const config: NeptuneDbConfig = {
        type: 'neptune',
        endpoint: neptuneEndpoint,
        region: neptuneRegion,
        port: neptunePort ?? 8182,
      };
      const adapter = new NeptuneAdapter(config);
      const t0 = Date.now();
      try {
        await adapter.executeQuery('MATCH (n) RETURN count(n) AS cnt LIMIT 1');
        res.json({ ok: true, latencyMs: Date.now() - t0 });
      } catch (err: any) {
        res.json({ ok: false, error: err.message || 'Connection failed' });
      } finally {
        adapter.close();
      }
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || 'Test failed' });
    }
  });

  // Update repo DB config
  app.patch('/api/repo/db', async (req, res) => {
    try {
      const { repo, db } = req.body;
      if (!repo) {
        res.status(400).json({ ok: false, error: 'Missing "repo" in request body' });
        return;
      }
      await updateRepoDb(repo, db);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || 'Failed to update DB config' });
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
    await backend.disconnect(); // closes LadybugDB + Neptune adapters
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};
