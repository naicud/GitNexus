/**
 * Embed Command
 *
 * Generates or updates embeddings for an already-indexed repository.
 * Opens the existing DB, generates only missing embeddings, and updates
 * registry/meta. Zero parsing, zero DB rebuild.
 */

import path from 'path';
import { resolveEmbeddingConfig, type EmbedOptions } from './embed-config.js';
import { getStoragePaths, loadMeta, saveMeta, readRegistry, registerRepo } from '../storage/repo-manager.js';
import { getGitRoot, isGitRepo } from '../storage/git.js';
import { initLbug, closeLbug, executeQuery, executeWithReusedStatement, loadCachedEmbeddings, getLbugStats, ensureEmbeddingTable } from '../core/lbug/lbug-adapter.js';
import { EMBEDDING_TABLE_NAME } from '../core/lbug/schema.js';

export interface EmbedCommandOptions extends EmbedOptions {
  /** Alias: --provider maps to embedProvider */
  provider?: string;
  /** Alias: --model maps to embedModel */
  model?: string;
  /** Alias: --dims maps to embedDims */
  dims?: string;
  /** Alias: --endpoint maps to embedEndpoint */
  endpoint?: string;
  /** Alias: --api-key maps to embedApiKey */
  apiKey?: string;
  force?: boolean;
  yes?: boolean;
}

/**
 * Normalize short aliases (--provider) to canonical names (--embed-provider).
 */
function normalizeOptions(options: EmbedCommandOptions): EmbedOptions & { force?: boolean; yes?: boolean } {
  return {
    embedProvider: options.embedProvider ?? options.provider,
    embedModel: options.embedModel ?? options.model,
    embedDims: options.embedDims ?? options.dims,
    embedEndpoint: options.embedEndpoint ?? options.endpoint,
    embedApiKey: options.embedApiKey ?? options.apiKey,
    force: options.force,
    yes: options.yes,
  };
}

export const embedCommand = async (
  inputPath?: string,
  options?: EmbedCommandOptions,
) => {
  const opts = normalizeOptions(options ?? {});

  // ── TUI Wizard ─────────────────────────────────────────────────────
  const { shouldRunInteractiveGeneric, hasExplicitFlags } = await import('./tui/shared.js');
  if (!opts.yes && !hasExplicitFlags(opts as Record<string, unknown>) && shouldRunInteractiveGeneric(opts as Record<string, unknown>)) {
    const { runEmbedWizard } = await import('./tui/wizards/embed-wizard.js');
    const result = await runEmbedWizard(inputPath);
    if (!result) return;
    Object.assign(opts, result.options);
    inputPath = result.path ?? inputPath;
  }

  console.log('\n  GitNexus Embeddings\n');

  // ── Resolve repo path ──────────────────────────────────────────────
  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      console.log('  Not inside a git repository.\n');
      process.exitCode = 1;
      return;
    }
    repoPath = gitRoot;
  }

  if (!isGitRepo(repoPath)) {
    console.log('  Not a git repository.\n');
    process.exitCode = 1;
    return;
  }

  // ── Validate index exists ──────────────────────────────────────────
  const { storagePath, lbugPath } = getStoragePaths(repoPath);
  const meta = await loadMeta(storagePath);
  if (!meta) {
    console.log('  No GitNexus index found. Run `gitnexus analyze` first.\n');
    process.exitCode = 1;
    return;
  }

  // ── Read registry entry ────────────────────────────────────────────
  const registry = await readRegistry();
  const registryEntry = registry.find(e => path.resolve(e.path) === path.resolve(repoPath));

  // ── Resolve embedding config ───────────────────────────────────────
  const embedConfig = resolveEmbeddingConfig(opts);

  // Detect dimension/provider mismatch with previous run
  const prevEmbed = registryEntry?.embedding;
  const dimsChanged = prevEmbed && prevEmbed.dimensions !== embedConfig.dimensions;

  // ── Multi-phase progress display ───────────────────────────────────
  const { createMultiProgress } = await import('./tui/components/multi-progress.js');
  const mp = createMultiProgress([
    { name: 'init', label: 'Initializing', weight: 5 },
    { name: 'embeddings', label: 'Generating embeddings', weight: 90 },
    { name: 'finalize', label: 'Finalizing', weight: 5 },
  ]);

  // Graceful SIGINT handling
  let aborted = false;
  const sigintHandler = () => {
    if (aborted) process.exit(1);
    aborted = true;
    mp.stop();
    console.log('\n  Interrupted — cleaning up...');
    closeLbug().catch(() => {}).finally(() => process.exit(130));
  };
  process.on('SIGINT', sigintHandler);

  const t0 = Date.now();

  // ── Phase 1: Initialize DB ─────────────────────────────────────────
  mp.setPhase('init');

  let skipNodeIds = new Set<string>();

  if (dimsChanged || !prevEmbed) {
    // Recreate if dims changed OR no previous embedding entry (ensures table schema matches
    // the requested dims — a stale table from an aborted run may have wrong dims/vector index).
    if (dimsChanged) {
      mp.update(20, `Dimension change detected (${prevEmbed!.dimensions} -> ${embedConfig.dimensions}), recreating table...`);
    } else {
      mp.update(20, `Recreating embedding table (${embedConfig.dimensions} dims)...`);
    }
    await initLbug(lbugPath);
    try {
      await executeQuery(`DROP TABLE ${EMBEDDING_TABLE_NAME}`);
    } catch { /* table may not exist */ }
    await closeLbug();
    // Re-init, then create table with correct dims
    await initLbug(lbugPath);
    await ensureEmbeddingTable(embedConfig.dimensions);
  } else {
    await initLbug(lbugPath);
    // Create table if it doesn't exist yet (e.g. first embed run after a no-embeddings analyze)
    await ensureEmbeddingTable(embedConfig.dimensions);
  }

  if (opts.force) {
    mp.update(40, 'Force mode: clearing existing embeddings...');
    try {
      await executeQuery(`MATCH (e:${EMBEDDING_TABLE_NAME}) DELETE e`);
    } catch { /* table may not exist */ }
  } else if (!dimsChanged) {
    // Load existing embeddings to skip
    mp.update(40, 'Checking existing embeddings...');
    try {
      const cached = await loadCachedEmbeddings();
      skipNodeIds = cached.embeddingNodeIds;
      if (skipNodeIds.size > 0) {
        mp.update(60, `Found ${skipNodeIds.size.toLocaleString()} existing embeddings to skip`);
      }
    } catch { /* no existing embeddings */ }
  }

  // ── Phase 2: Run Embedding Pipeline ────────────────────────────────
  mp.setPhase('embeddings');
  mp.update(0, `Loading embedding provider (${embedConfig.provider})...`);

  const { createEmbeddingProvider } = await import('../core/embeddings/providers/factory.js');
  const { runEmbeddingPipeline, getEmbeddableLabels } = await import('../core/embeddings/embedding-pipeline.js');

  const provider = await createEmbeddingProvider(embedConfig);

  const stats = await getLbugStats();

  const labels = getEmbeddableLabels(stats.nodes);

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
    skipNodeIds.size > 0 ? skipNodeIds : undefined,
    labels,
  );

  const embeddingTime = ((Date.now() - t0) / 1000).toFixed(1);

  // ── Phase 3: Finalize ──────────────────────────────────────────────
  mp.setPhase('finalize');
  mp.update(0, 'Saving metadata...');

  // Count embeddings
  let embeddingCount = 0;
  try {
    const embResult = await executeQuery(`MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`);
    embeddingCount = embResult?.[0]?.cnt ?? 0;
  } catch { /* table may not exist */ }

  // Update meta.json
  meta.stats = { ...meta.stats, embeddings: embeddingCount };
  await saveMeta(storagePath, meta);

  // Update registry
  const embeddingMeta = {
    provider: embedConfig.provider,
    model: embedConfig.model,
    dimensions: embedConfig.dimensions,
    endpoint: embedConfig.endpoint,
  };
  await registerRepo(repoPath, meta, undefined, embeddingMeta);

  await closeLbug();

  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);

  process.removeListener('SIGINT', sigintHandler);

  // ── Summary ────────────────────────────────────────────────────────
  mp.complete({
    'Result': `Embeddings complete (${totalTime}s)`,
    'Provider': `${embedConfig.provider}/${embedConfig.model}`,
    'Dimensions': String(embedConfig.dimensions),
    'Embeddings': embeddingCount.toLocaleString(),
    'Skipped': skipNodeIds.size.toLocaleString(),
    'Time': embeddingTime + 's',
    'Path': repoPath,
  });

  console.log('');

  // Force exit to avoid LadybugDB/ONNX native handle hangs
  process.exit(0);
};
