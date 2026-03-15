/**
 * Analyze Command
 *
 * Indexes a repository and stores the knowledge graph in .gitnexus/
 */

import path from 'path';
import { execFileSync } from 'child_process';
import v8 from 'v8';
import { runPipelineFromRepo } from '../core/ingestion/pipeline.js';
import { initKuzu, loadGraphToKuzu, getKuzuStats, executeQuery, executeWithReusedStatement, closeKuzu, createFTSIndex, loadCachedEmbeddings } from '../core/kuzu/kuzu-adapter.js';
// Embedding imports are lazy (dynamic import) so onnxruntime-node is never
// loaded when embeddings are not requested. This avoids crashes on Node
// versions whose ABI is not yet supported by the native binary (#89).
// disposeEmbedder intentionally not called — ONNX Runtime segfaults on cleanup (see #38)
import { getStoragePaths, saveMeta, loadMeta, addToGitignore, registerRepo, getGlobalRegistryPath } from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo, getGitRoot } from '../storage/git.js';
import { generateAIContextFiles } from './ai-context.js';
import { generateSkillFiles, type GeneratedSkillInfo } from './skill-gen.js';
import fs from 'fs/promises';
import type { DbConfig, NeptuneDbConfig } from '../core/db/interfaces.js';
import { loadGraphToNeptune, getNeptuneStats } from '../core/db/neptune/neptune-ingest.js';
import { generateGraphSummary } from '../core/ingestion/graph-summary.js';
import { resolveEmbeddingConfig } from './embed-config.js';


const HEAP_MB = 8192;
const HEAP_FLAG = `--max-old-space-size=${HEAP_MB}`;

/** Re-exec the process with an 8GB heap if we're currently below that. */
function ensureHeap(): boolean {
  const nodeOpts = process.env.NODE_OPTIONS || '';
  if (nodeOpts.includes('--max-old-space-size')) return false;

  const v8Heap = v8.getHeapStatistics().heap_size_limit;
  if (v8Heap >= HEAP_MB * 1024 * 1024 * 0.9) return false;

  try {
    execFileSync(process.execPath, [HEAP_FLAG, ...process.argv.slice(1)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: `${nodeOpts} ${HEAP_FLAG}`.trim() },
    });
  } catch (e: any) {
    process.exitCode = e.status ?? 1;
  }
  return true;
}

export interface AnalyzeOptions {
  force?: boolean;
  embeddings?: boolean;
  skills?: boolean;
  verbose?: boolean;
  db?: string;               // 'kuzu' | 'neptune'
  neptuneEndpoint?: string;
  neptuneRegion?: string;
  neptunePort?: string;
  embedProvider?: string;
  embedModel?: string;
  embedDims?: string;
  embedEndpoint?: string;
  embedApiKey?: string;
  yes?: boolean;
}

const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  kuzu: 'Loading into KuzuDB',
  neptune: 'Loading into Neptune',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

/**
 * Resolve Neptune config from CLI options + env vars.
 * Throws with a clear error if required fields are missing.
 */
function resolveNeptuneConfig(options: AnalyzeOptions): NeptuneDbConfig {
  const endpoint = options.neptuneEndpoint
    ?? process.env.GITNEXUS_NEPTUNE_ENDPOINT;
  const region = options.neptuneRegion
    ?? process.env.GITNEXUS_NEPTUNE_REGION
    ?? process.env.AWS_REGION;
  const port = parseInt(options.neptunePort ?? process.env.GITNEXUS_NEPTUNE_PORT ?? '8182', 10);

  if (!endpoint) {
    throw new Error(
      'Neptune endpoint is required. Use --neptune-endpoint <host> or set GITNEXUS_NEPTUNE_ENDPOINT.'
    );
  }
  if (!region) {
    throw new Error(
      'AWS region is required for Neptune. Use --neptune-region <region> or set AWS_REGION.'
    );
  }
  return { type: 'neptune', endpoint, region, port };
}

export const analyzeCommand = async (
  inputPath?: string,
  options?: AnalyzeOptions
) => {
  // ── TUI Wizard (runs before heap re-exec) ─────────────────────────
  if (options && !(options as Record<string, unknown>)._tuiMerged) {
    const { shouldRunInteractive, serializeToEnv, deserializeFromEnv } = await import('./tui/shared.js');

    if (shouldRunInteractive(options as Record<string, unknown>)) {
      const { runAnalyzeWizard } = await import('./tui/analyze-wizard.js');
      const result = await runAnalyzeWizard(inputPath, options);
      if (!result) return;
      options = { ...options, ...result.options };
      inputPath = result.path ?? inputPath;
      serializeToEnv(result);
    } else if (process.env.GITNEXUS_TUI_DONE === '1') {
      // Re-exec child: merge wizard choices from env
      const fromEnv = deserializeFromEnv();
      if (fromEnv.tuiPath) inputPath = fromEnv.tuiPath;
      options = { ...options, ...fromEnv };
      (options as Record<string, unknown>)._tuiMerged = true;
    }
  }

  if (ensureHeap()) return;

  if (options?.verbose) {
    process.env.GITNEXUS_VERBOSE = '1';
  }

  console.log('\n  GitNexus Analyzer\n');

  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      console.log('  Not inside a git repository\n');
      process.exitCode = 1;
      return;
    }
    repoPath = gitRoot;
  }

  if (!isGitRepo(repoPath)) {
    console.log('  Not a git repository\n');
    process.exitCode = 1;
    return;
  }

  // Resolve DB backend
  const dbTypeRaw = options?.db ?? process.env.GITNEXUS_DB_TYPE ?? 'kuzu';
  const isNeptune = dbTypeRaw === 'neptune';
  let neptuneConfig: NeptuneDbConfig | null = null;

  if (isNeptune) {
    try {
      neptuneConfig = resolveNeptuneConfig(options ?? {});
    } catch (e: any) {
      console.log(`  ${e.message}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // Resolve embedding config (always, even if --embeddings not set, for registry persistence)
  const embedConfig = resolveEmbeddingConfig(options ?? {});

  const { storagePath, kuzuPath } = getStoragePaths(repoPath);
  const currentCommit = getCurrentCommit(repoPath);
  const existingMeta = await loadMeta(storagePath);

  if (existingMeta && !options?.force && !options?.skills && existingMeta.lastCommit === currentCommit) {
    console.log('  Already up to date\n');
    return;
  }

  // Multi-phase progress display
  const { createMultiProgress } = await import('./tui/components/multi-progress.js');
  const mp = createMultiProgress([
    { name: 'pipeline', label: 'Running pipeline', weight: 60 },
    { name: 'db', label: isNeptune ? 'Loading into Neptune' : 'Loading into KuzuDB', weight: 25 },
    { name: 'fts', label: 'Creating search indexes', weight: 5 },
    { name: 'embeddings', label: 'Generating embeddings', weight: 8 },
    { name: 'finalize', label: 'Finalizing', weight: 2 },
  ]);

  // Graceful SIGINT handling — clean up resources and exit
  let aborted = false;
  const sigintHandler = () => {
    if (aborted) process.exit(1); // Second Ctrl-C: force exit
    aborted = true;
    mp.stop();
    console.log('\n  Interrupted — cleaning up...');
    (isNeptune ? Promise.resolve() : closeKuzu()).catch(() => {}).finally(() => process.exit(130));
  };
  process.on('SIGINT', sigintHandler);

  const t0Global = Date.now();

  // ── Cache embeddings from existing index before rebuild ────────────
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: Array<{ nodeId: string; embedding: number[] }> = [];

  // Check dimension mismatch: if provider/model/dims changed, invalidate cache
  const existingRegistry = await import('../storage/repo-manager.js').then(m => m.readRegistry());
  const existingEntry = existingRegistry.find((e: any) => path.resolve(e.path) === path.resolve(repoPath));
  const prevDims = existingEntry?.embedding?.dimensions ?? 384;
  const dimsChanged = options?.embeddings && prevDims !== embedConfig.dimensions;
  const providerChanged = options?.embeddings && existingEntry?.embedding &&
    (existingEntry.embedding.provider !== embedConfig.provider || existingEntry.embedding.model !== embedConfig.model);

  if (!isNeptune && options?.embeddings && existingMeta && !options?.force && !dimsChanged && !providerChanged) {
    try {
      mp.update(0, 'Caching embeddings...');
      await initKuzu(kuzuPath, embedConfig.dimensions);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      await closeKuzu();
    } catch {
      try { await closeKuzu(); } catch {}
    }
  }

  // ── Phase 1: Full Pipeline ──────────────────────────────────────────
  mp.setPhase('pipeline');
  const pipelineResult = await runPipelineFromRepo(repoPath, (progress) => {
    const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase;
    const detail =
      progress.phase === 'parsing' && (progress.stats?.totalFiles ?? 0) > 0
        ? `${progress.stats!.filesProcessed}/${progress.stats!.totalFiles} files${
            options?.verbose && progress.detail
              ? ` — ${progress.detail.split('/').at(-1)}`
              : ''
          }`
        : undefined;
    mp.update(progress.percent, detail || phaseLabel);
  });

  // ── Phase 2: DB Loading ─────────────────────────────────────────────
  mp.setPhase('db');
  let dbTime: string;
  let dbWarnings: string[] = [];

  if (isNeptune && neptuneConfig) {
    // ── Neptune path ──────────────────────────────────────────────
    const t0Neptune = Date.now();
    let neptuneMsgCount = 0;
    const neptuneResult = await loadGraphToNeptune(
      pipelineResult.graph,
      neptuneConfig,
      (msg) => {
        neptuneMsgCount++;
        const progress = Math.min(100, Math.round((neptuneMsgCount / (neptuneMsgCount + 10)) * 100));
        mp.update(progress, msg);
      },
    );
    dbTime = ((Date.now() - t0Neptune) / 1000).toFixed(1);
    dbWarnings = neptuneResult.warnings;
  } else {
    // ── KuzuDB path (existing, unchanged) ─────────────────────────
    await closeKuzu();
    const kuzuFiles = [kuzuPath, `${kuzuPath}.wal`, `${kuzuPath}.lock`];
    for (const f of kuzuFiles) {
      try { await fs.rm(f, { recursive: true, force: true }); } catch {}
    }

    const t0Kuzu = Date.now();
    await initKuzu(kuzuPath, options?.embeddings ? embedConfig.dimensions : undefined);
    let kuzuMsgCount = 0;
    const kuzuResult = await loadGraphToKuzu(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
      kuzuMsgCount++;
      const progress = Math.min(100, Math.round((kuzuMsgCount / (kuzuMsgCount + 10)) * 100));
      mp.update(progress, msg);
    });
    dbTime = ((Date.now() - t0Kuzu) / 1000).toFixed(1);
    dbWarnings = kuzuResult.warnings;
  }

  // ── Phase 3: FTS ───────────────────────────────────────────────────
  mp.setPhase('fts');
  const t0Fts = Date.now();
  if (!isNeptune) {

    try {
      await createFTSIndex('File', 'file_fts', ['name', 'content']);
      await createFTSIndex('Function', 'function_fts', ['name', 'content']);
      await createFTSIndex('Class', 'class_fts', ['name', 'content']);
      await createFTSIndex('Method', 'method_fts', ['name', 'content']);
      await createFTSIndex('Interface', 'interface_fts', ['name', 'content']);
    } catch (e: any) {
      // Non-fatal — FTS is best-effort
    }
  }
  const ftsTime = isNeptune ? 'n/a' : ((Date.now() - t0Fts) / 1000).toFixed(1);

  // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
  if (!isNeptune && cachedEmbeddings.length > 0) {
    mp.update(50, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
    const EMBED_BATCH = 200;
    for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
      const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);
      const paramsList = batch.map(e => ({ nodeId: e.nodeId, embedding: e.embedding }));
      try {
        await executeWithReusedStatement(
          `CREATE (e:CodeEmbedding {nodeId: $nodeId, embedding: $embedding})`,
          paramsList,
        );
      } catch { /* some may fail if node was removed, that's fine */ }
    }
  }

  // ── Phase 4: Embeddings ─────────────────────────────────────────────
  mp.setPhase('embeddings');
  const stats = isNeptune && neptuneConfig
    ? await getNeptuneStats(neptuneConfig)
    : await getKuzuStats();
  let embeddingTime = '0.0';
  let embeddingSkipped = !options?.embeddings;
  let embeddingSkipReason = 'off (use --embeddings to enable)';

  if (!embeddingSkipped) {
    mp.update(0, `Loading embedding provider (${embedConfig.provider})...`);
    const t0Emb = Date.now();

    const { createEmbeddingProvider } = await import('../core/embeddings/providers/factory.js');
    const { runEmbeddingPipeline, getEmbeddableLabels } = await import('../core/embeddings/embedding-pipeline.js');

    const provider = await createEmbeddingProvider(embedConfig);
    const labels = getEmbeddableLabels(stats.nodes);

    if (isNeptune && neptuneConfig) {
      // Neptune path: run pipeline collecting embeddings in-memory, then bulk-store
      const neptuneEmbeddings: Array<{ nodeId: string; embedding: number[] }> = [];
      // Create a lightweight in-memory collector instead of KuzuDB insert
      const collectInsert = async (_cypher: string, paramsList: Array<Record<string, any>>) => {
        for (const p of paramsList) {
          neptuneEmbeddings.push({ nodeId: p.nodeId as string, embedding: p.embedding as number[] });
        }
      };

      await runEmbeddingPipeline(
        // For Neptune, we need to query Neptune to get node lists
        async (cypher: string) => {
          const { NeptunedataClient, ExecuteOpenCypherQueryCommand } = await import('@aws-sdk/client-neptunedata');
          const client = new NeptunedataClient({
            endpoint: `https://${neptuneConfig.endpoint}:${neptuneConfig.port}`,
            region: neptuneConfig.region,
          });
          try {
            const res = await client.send(new ExecuteOpenCypherQueryCommand({ openCypherQuery: cypher }));
            return (res.results as Record<string, unknown>[]) ?? [];
          } finally {
            client.destroy();
          }
        },
        collectInsert,
        (progress) => {
          const label = progress.phase === 'loading-model'
            ? `Loading ${embedConfig.provider} model...`
            : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
          mp.update(progress.percent, label);
        },
        provider,
        {},
        cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
        labels,
      );

      // Store embeddings to Neptune
      if (neptuneEmbeddings.length > 0) {
        mp.update(95, `Storing ${neptuneEmbeddings.length} embeddings to Neptune...`);
        const { loadEmbeddingsToNeptune } = await import('../core/db/neptune/neptune-ingest.js');
        await loadEmbeddingsToNeptune(neptuneConfig, neptuneEmbeddings, (msg) => mp.update(97, msg));
      }
    } else {
      // KuzuDB path
      await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (progress) => {
          const label = progress.phase === 'loading-model'
            ? `Loading ${embedConfig.provider} model...`
            : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
          mp.update(progress.percent, label);
        },
        provider,
        {},
        cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
        labels,
      );
    }
    embeddingTime = ((Date.now() - t0Emb) / 1000).toFixed(1);
  }

  // ── Phase 5: Finalize ──────────────────────────────────────────────
  mp.setPhase('finalize');
  mp.update(0, 'Saving metadata...');

  // Count embeddings in the index (cached + newly generated)
  let embeddingCount = 0;
  if (!isNeptune) {
    try {
      const embResult = await executeQuery(`MATCH (e:CodeEmbedding) RETURN count(e) AS cnt`);
      embeddingCount = embResult?.[0]?.cnt ?? 0;
    } catch { /* table may not exist if embeddings never ran */ }
  }

  const meta = {
    repoPath,
    lastCommit: currentCommit,
    indexedAt: new Date().toISOString(),
    stats: {
      files: pipelineResult.totalFileCount,
      nodes: stats.nodes,
      edges: stats.edges,
      communities: pipelineResult.communityResult?.stats.totalCommunities,
      processes: pipelineResult.processResult?.stats.totalProcesses,
      embeddings: embeddingCount,
    },
  };
  await saveMeta(storagePath, meta);
  const dbConfig: DbConfig = isNeptune && neptuneConfig
    ? neptuneConfig
    : { type: 'kuzu', kuzuPath };
  const embeddingMeta = options?.embeddings
    ? { provider: embedConfig.provider, model: embedConfig.model, dimensions: embedConfig.dimensions, endpoint: embedConfig.endpoint }
    : undefined;
  await registerRepo(repoPath, meta, dbConfig, embeddingMeta);
  await addToGitignore(repoPath);

  // Generate LOD graph summary for large-codebase visualization
  if (pipelineResult.communityResult) {
    try {
      await generateGraphSummary(pipelineResult.graph, pipelineResult.communityResult, storagePath);
    } catch {
      // Non-fatal — summary is best-effort
    }
  }

  const projectName = path.basename(repoPath);
  let aggregatedClusterCount = 0;
  if (pipelineResult.communityResult?.communities) {
    const groups = new Map<string, number>();
    for (const c of pipelineResult.communityResult.communities) {
      const label = c.heuristicLabel || c.label || 'Unknown';
      groups.set(label, (groups.get(label) || 0) + c.symbolCount);
    }
    aggregatedClusterCount = Array.from(groups.values()).filter(count => count >= 5).length;
  }

  let generatedSkills: GeneratedSkillInfo[] = [];
  if (options?.skills && pipelineResult.communityResult) {
    mp.update(50, 'Generating skill files...');
    const skillResult = await generateSkillFiles(repoPath, projectName, pipelineResult);
    generatedSkills = skillResult.skills;
  }

  const aiContext = await generateAIContextFiles(repoPath, storagePath, projectName, {
    files: pipelineResult.totalFileCount,
    nodes: stats.nodes,
    edges: stats.edges,
    communities: pipelineResult.communityResult?.stats.totalCommunities,
    clusters: aggregatedClusterCount,
    processes: pipelineResult.processResult?.stats.totalProcesses,
  }, generatedSkills);

  if (!isNeptune) {
    await closeKuzu();
  }
  // Note: we intentionally do NOT call disposeEmbedder() here.
  // ONNX Runtime's native cleanup segfaults on macOS and some Linux configs.
  // Since the process exits immediately after, Node.js reclaims everything.

  const totalTime = ((Date.now() - t0Global) / 1000).toFixed(1);

  process.removeListener('SIGINT', sigintHandler);

  // ── Summary ───────────────────────────────────────────────────────
  const embeddingsCached = cachedEmbeddings.length > 0;
  const resultLabel = embeddingsCached
    ? `Indexed successfully (${totalTime}s) [${cachedEmbeddings.length} embeddings cached]`
    : `Indexed successfully (${totalTime}s)`;

  mp.complete({
    'Result': resultLabel,
    'Nodes': stats.nodes.toLocaleString(),
    'Edges': stats.edges.toLocaleString(),
    'Clusters': String(pipelineResult.communityResult?.stats.totalCommunities || 0),
    'Flows': String(pipelineResult.processResult?.stats.totalProcesses || 0),
    'Database': `${isNeptune ? 'Neptune' : 'KuzuDB'} (${dbTime}s)`,
    'FTS': ftsTime + 's',
    'Embeddings': embeddingSkipped ? embeddingSkipReason : embeddingTime + 's',
    'Path': repoPath,
  });

  if (aiContext.files.length > 0) {
    console.log(`  Context: ${aiContext.files.join(', ')}`);
  }

  // Show a quiet summary if some edge types needed fallback insertion
  if (dbWarnings.length > 0) {
    const totalFallback = dbWarnings.reduce((sum, w) => {
      const m = w.match(/\((\d+) edges\)/);
      return sum + (m ? parseInt(m[1]) : 0);
    }, 0);
    console.log(`  Note: ${totalFallback} edges across ${dbWarnings.length} types inserted via fallback (schema will be updated in next release)`);
  }

  try {
    await fs.access(getGlobalRegistryPath());
  } catch {
    console.log('\n  Tip: Run `gitnexus setup` to configure MCP for your editor.');
  }

  console.log('');

  // KuzuDB's native module holds open handles that prevent Node from exiting.
  // ONNX Runtime also registers native atexit hooks that segfault on some
  // platforms (#38, #40). Force-exit to ensure clean termination.
  process.exit(0);
};
