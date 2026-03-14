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
import { loadMeta, listRegisteredRepos } from '../storage/repo-manager.js';
import { executeQuery, closeKuzu, withKuzuDb } from '../core/kuzu/kuzu-adapter.js';
import { NODE_TABLES } from '../core/kuzu/schema.js';
import { GraphNode, GraphRelationship } from '../core/graph/types.js';
import { searchFTSFromKuzu } from '../core/search/bm25-index.js';
import { hybridSearch } from '../core/search/hybrid-search.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at server startup — crashes on unsupported Node ABI versions (#89)
import { LocalBackend } from '../mcp/local/local-backend.js';
import { mountMCPEndpoints } from './mcp-http.js';

const buildGraph = async (): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const nodes: GraphNode[] = [];
  for (const table of NODE_TABLES) {
    try {
      let query = '';
      if (table === 'File') {
        query = `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`;
      } else if (table === 'Folder') {
        query = `MATCH (n:Folder) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Community') {
        query = `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
      } else if (table === 'Process') {
        query = `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
      } else {
        query = `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`;
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
            content: row.content,
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
    } catch {
      // ignore empty tables
    }
  }

  const relationships: GraphRelationship[] = [];
  const relRows = await executeQuery(
    `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`
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

  return { nodes, relationships };
};

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
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const kuzuPath = path.join(entry.storagePath, 'kuzu');
      const graph = await withKuzuDb(kuzuPath, async () => buildGraph());
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

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const kuzuPath = path.join(entry.storagePath, 'kuzu');
      const result = await withKuzuDb(kuzuPath, () => executeQuery(cypher));
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
      const kuzuPath = path.join(entry.storagePath, 'kuzu');
      const parsedLimit = Number(req.body.limit ?? 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(100, Math.trunc(parsedLimit)))
        : 10;

      const results = await withKuzuDb(kuzuPath, async () => {
        const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
        if (isEmbedderReady()) {
          const { semanticSearch } = await import('../core/embeddings/embedding-pipeline.js');
          return hybridSearch(query, limit, executeQuery, semanticSearch);
        }
        // FTS-only fallback when embeddings aren't loaded
        return searchFTSFromKuzu(query, limit);
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

  // Graceful shutdown — close Express + KuzuDB cleanly
  const shutdown = async () => {
    server.close();
    await cleanupMcp();
    await closeKuzu();
    await backend.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};
