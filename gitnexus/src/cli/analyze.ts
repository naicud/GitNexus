/**
 * Analyze Command
 *
 * Indexes a repository and stores the knowledge graph in .gitnexus/
 */

import path from 'path';
import { execFileSync } from 'child_process';
import v8 from 'v8';
import cliProgress from 'cli-progress';
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
import type { EmbeddingProviderConfig, EmbeddingProviderType } from '../core/embeddings/providers/types.js';


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

/**
 * Resolve embedding provider config from CLI options + env vars.
 * Priority: CLI flags > env vars > defaults.
 */
function resolveEmbeddingConfig(options: AnalyzeOptions): EmbeddingProviderConfig {
  const provider = (options.embedProvider
    ?? process.env.GITNEXUS_EMBED_PROVIDER
    ?? 'local') as EmbeddingProviderType;

  const defaultModel = provider === 'local'
    ? 'Snowflake/snowflake-arctic-embed-xs'
    : provider === 'ollama' ? 'nomic-embed-text'
    : provider === 'cohere' ? 'embed-english-light-v3.0'
    : 'text-embedding-3-small';

  const model = options.embedModel
    ?? process.env.GITNEXUS_EMBED_MODEL
    ?? defaultModel;

  const dimensions = parseInt(
    options.embedDims ?? process.env.GITNEXUS_EMBED_DIMS ?? '384', 10,
  );

  const endpoint = options.embedEndpoint
    ?? process.env.GITNEXUS_EMBED_ENDPOINT
    ?? undefined;

  const apiKey = options.embedApiKey
    ?? process.env.GITNEXUS_EMBED_API_KEY
    ?? undefined;

  return { provider, model, dimensions, endpoint, apiKey };
}

export const analyzeCommand = async (
  inputPath?: string,
  options?: AnalyzeOptions
) => {
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

  // Single progress bar for entire pipeline
  const bar = new cliProgress.SingleBar({
    format: '  {bar} {percentage}% | {phase}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    barGlue: '',
    autopadding: true,
    clearOnComplete: false,
    stopOnComplete: false,
  }, cliProgress.Presets.shades_grey);

  bar.start(100, 0, { phase: 'Initializing...' });

  // Graceful SIGINT handling — clean up resources and exit
  let aborted = false;
  const sigintHandler = () => {
    if (aborted) process.exit(1); // Second Ctrl-C: force exit
    aborted = true;
    bar.stop();
    console.log('\n  Interrupted — cleaning up...');
    (isNeptune ? Promise.resolve() : closeKuzu()).catch(() => {}).finally(() => process.exit(130));
  };
  process.on('SIGINT', sigintHandler);

  // Route all console output through bar.log() so the bar doesn't stamp itself
  // multiple times when other code writes to stdout/stderr mid-render.
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const barLog = (...args: any[]) => {
    // Clear the bar line, print the message, then let the next bar.update redraw
    process.stdout.write('\x1b[2K\r');
    origLog(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  console.log = barLog;
  console.warn = barLog;
  console.error = barLog;

  // Track elapsed time per phase — both updateBar and the interval use the
  // same format so they don't flicker against each other.
  let lastPhaseLabel = 'Initializing...';
  let phaseStart = Date.now();
  let lastDetail = '';

  /** Update bar with phase label + optional detail + elapsed seconds (shown after 3s). */
  const updateBar = (value: number, phaseLabel: string, detail?: string) => {
    if (phaseLabel !== lastPhaseLabel) { lastPhaseLabel = phaseLabel; phaseStart = Date.now(); lastDetail = ''; }
    if (detail !== undefined) { lastDetail = detail; }
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    const detailPart = lastDetail ? ` | ${lastDetail}` : '';
    const display = elapsed >= 3 ? `${phaseLabel}${detailPart} (${elapsed}s)` : `${phaseLabel}${detailPart}`;
    bar.update(value, { phase: display });
  };

  // Tick elapsed seconds for phases with infrequent progress callbacks
  // (e.g. CSV streaming, FTS indexing). Uses the same display format as
  // updateBar so there's no flickering.
  const elapsedTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    if (elapsed >= 3) {
      const detailPart = lastDetail ? ` | ${lastDetail}` : '';
      bar.update({ phase: `${lastPhaseLabel}${detailPart} (${elapsed}s)` });
    }
  }, 1000);

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
      updateBar(0, 'Caching embeddings...');
      await initKuzu(kuzuPath, embedConfig.dimensions);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      await closeKuzu();
    } catch {
      try { await closeKuzu(); } catch {}
    }
  }

  // ── Phase 1: Full Pipeline (0–60%) ─────────────────────────────────
  const pipelineResult = await runPipelineFromRepo(repoPath, (progress) => {
    const phaseLabel = PHASE_LABELS[progress.phase] || progress.phase;
    const scaled = Math.round(progress.percent * 0.6);
    const detail =
      progress.phase === 'parsing' && (progress.stats?.totalFiles ?? 0) > 0
        ? `${progress.stats!.filesProcessed}/${progress.stats!.totalFiles} files${
            options?.verbose && progress.detail
              ? ` — ${progress.detail.split('/').at(-1)}`
              : ''
          }`
        : undefined;
    updateBar(scaled, phaseLabel, detail);
  });

  // ── Phase 2: DB Loading (60–85%) ──────────────────────────────────
  let dbTime: string;
  let dbWarnings: string[] = [];

  const dbLabel = isNeptune ? 'Loading into Neptune...' : 'Loading into KuzuDB...';
  updateBar(60, dbLabel);

  if (isNeptune && neptuneConfig) {
    // ── Neptune path ──────────────────────────────────────────────
    const t0Neptune = Date.now();
    let neptuneMsgCount = 0;
    const neptuneResult = await loadGraphToNeptune(
      pipelineResult.graph,
      neptuneConfig,
      (msg) => {
        neptuneMsgCount++;
        const progress = Math.min(84, 60 + Math.round((neptuneMsgCount / (neptuneMsgCount + 10)) * 24));
        updateBar(progress, msg);
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
      const progress = Math.min(84, 60 + Math.round((kuzuMsgCount / (kuzuMsgCount + 10)) * 24));
      updateBar(progress, msg);
    });
    dbTime = ((Date.now() - t0Kuzu) / 1000).toFixed(1);
    dbWarnings = kuzuResult.warnings;
  }

  // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
  const t0Fts = Date.now();
  if (!isNeptune) {
    updateBar(85, 'Creating search indexes...');

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
    updateBar(88, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
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

  // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
  const stats = isNeptune && neptuneConfig
    ? await getNeptuneStats(neptuneConfig)
    : await getKuzuStats();
  let embeddingTime = '0.0';
  let embeddingSkipped = !options?.embeddings;
  let embeddingSkipReason = 'off (use --embeddings to enable)';

  if (!embeddingSkipped) {
    updateBar(90, `Loading embedding provider (${embedConfig.provider})...`);
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
          const scaled = 90 + Math.round((progress.percent / 100) * 8);
          const label = progress.phase === 'loading-model'
            ? `Loading ${embedConfig.provider} model...`
            : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
          updateBar(scaled, label);
        },
        provider,
        {},
        cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
        labels,
      );

      // Store embeddings to Neptune
      if (neptuneEmbeddings.length > 0) {
        updateBar(97, `Storing ${neptuneEmbeddings.length} embeddings to Neptune...`);
        const { loadEmbeddingsToNeptune } = await import('../core/db/neptune/neptune-ingest.js');
        await loadEmbeddingsToNeptune(neptuneConfig, neptuneEmbeddings, (msg) => updateBar(97, msg));
      }
    } else {
      // KuzuDB path
      await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (progress) => {
          const scaled = 90 + Math.round((progress.percent / 100) * 8);
          const label = progress.phase === 'loading-model'
            ? `Loading ${embedConfig.provider} model...`
            : `Embedding ${progress.nodesProcessed || 0}/${progress.totalNodes || '?'}`;
          updateBar(scaled, label);
        },
        provider,
        {},
        cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
        labels,
      );
    }
    embeddingTime = ((Date.now() - t0Emb) / 1000).toFixed(1);
  }

  // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
  updateBar(98, 'Saving metadata...');

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
    updateBar(99, 'Generating skill files...');
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

  clearInterval(elapsedTimer);
  process.removeListener('SIGINT', sigintHandler);

  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;

  bar.update(100, { phase: 'Done' });
  bar.stop();

  // ── Summary ───────────────────────────────────────────────────────
  const embeddingsCached = cachedEmbeddings.length > 0;
  console.log(`\n  Repository indexed successfully (${totalTime}s)${embeddingsCached ? ` [${cachedEmbeddings.length} embeddings cached]` : ''}\n`);
  console.log(`  ${stats.nodes.toLocaleString()} nodes | ${stats.edges.toLocaleString()} edges | ${pipelineResult.communityResult?.stats.totalCommunities || 0} clusters | ${pipelineResult.processResult?.stats.totalProcesses || 0} flows`);
  const dbLabel2 = isNeptune ? 'Neptune' : 'KuzuDB';
  console.log(`  ${dbLabel2} ${dbTime}s | FTS ${ftsTime}s | Embeddings ${embeddingSkipped ? embeddingSkipReason : embeddingTime + 's'}`);
  console.log(`  ${repoPath}`);

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
