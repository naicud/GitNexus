/**
 * Analyze Wizard — Interactive TUI for `gitnexus analyze`
 *
 * Guides users through configuration with smart defaults
 * and progressive disclosure. Only shown when no flags are passed.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import path from 'path';
import { getGitRoot } from '../../storage/git.js';
import { getStoragePaths, loadMeta, readRegistry } from '../../storage/repo-manager.js';
import { getCurrentCommit } from '../../storage/git.js';
import type { AnalyzeOptions } from '../analyze.js';

export interface AnalyzeWizardResult {
  options: AnalyzeOptions;
  path?: string;
}

export async function runAnalyzeWizard(
  inputPath: string | undefined,
  _currentOptions: AnalyzeOptions,
): Promise<AnalyzeWizardResult | null> {
  // Resolve the repo path for display
  let repoPath: string;
  if (inputPath) {
    repoPath = path.resolve(inputPath);
  } else {
    const gitRoot = getGitRoot(process.cwd());
    if (!gitRoot) {
      p.log.error('Not inside a git repository.');
      return null;
    }
    repoPath = gitRoot;
  }

  const projectName = path.basename(repoPath);

  p.intro(`${pc.bgCyan(pc.black(' GitNexus Analyzer '))}`);

  // ── Step 1: Confirm path ──────────────────────────────────────────
  const confirmPath = await p.confirm({
    message: `Analyze ${pc.bold(projectName)} at ${pc.dim(repoPath)}?`,
    initialValue: true,
  });
  if (p.isCancel(confirmPath) || !confirmPath) {
    p.cancel('Cancelled.');
    return null;
  }

  // ── Step 2: Database backend ──────────────────────────────────────
  const dbChoice = await p.select({
    message: 'Database backend',
    options: [
      { value: 'kuzu', label: 'KuzuDB', hint: 'local, zero-config (recommended)' },
      { value: 'neptune', label: 'AWS Neptune', hint: 'cloud graph database' },
    ],
    initialValue: 'kuzu',
  });
  if (p.isCancel(dbChoice)) { p.cancel('Cancelled.'); return null; }

  // ── Step 2b: Neptune config (conditional) ─────────────────────────
  let neptuneEndpoint: string | undefined;
  let neptuneRegion: string | undefined;
  let neptunePort: string | undefined;

  if (dbChoice === 'neptune') {
    // Try to pre-fill from existing registry entry or env
    const registry = await readRegistry();
    const existing = registry.find(e => path.resolve(e.path) === path.resolve(repoPath));
    const prevEndpoint = (existing?.db as any)?.endpoint || process.env.GITNEXUS_NEPTUNE_ENDPOINT || '';
    const prevRegion = (existing?.db as any)?.region || process.env.GITNEXUS_NEPTUNE_REGION || process.env.AWS_REGION || '';
    const prevPort = String((existing?.db as any)?.port || process.env.GITNEXUS_NEPTUNE_PORT || '8182');

    const endpoint = await p.text({
      message: 'Neptune cluster endpoint',
      placeholder: 'cluster.us-east-1.neptune.amazonaws.com',
      initialValue: prevEndpoint,
      validate: (v) => v.length === 0 ? 'Endpoint is required' : undefined,
    });
    if (p.isCancel(endpoint)) { p.cancel('Cancelled.'); return null; }
    neptuneEndpoint = endpoint;

    const region = await p.text({
      message: 'AWS region',
      placeholder: 'us-east-1',
      initialValue: prevRegion,
      validate: (v) => v.length === 0 ? 'Region is required' : undefined,
    });
    if (p.isCancel(region)) { p.cancel('Cancelled.'); return null; }
    neptuneRegion = region;

    const port = await p.text({
      message: 'Neptune HTTP port',
      initialValue: prevPort,
    });
    if (p.isCancel(port)) { p.cancel('Cancelled.'); return null; }
    neptunePort = port || '8182';
  }

  // ── Step 3: Embeddings ────────────────────────────────────────────
  const enableEmbeddings = await p.confirm({
    message: 'Enable semantic search (embeddings)?',
    initialValue: false,
  });
  if (p.isCancel(enableEmbeddings)) { p.cancel('Cancelled.'); return null; }

  // ── Step 3b: Embedding provider config (conditional) ──────────────
  let embedProvider: string | undefined;
  let embedModel: string | undefined;
  let embedDims: string | undefined;
  let embedEndpoint: string | undefined;
  let embedApiKey: string | undefined;

  if (enableEmbeddings) {
    const providerChoice = await p.select({
      message: 'Embedding provider',
      options: [
        { value: 'local', label: 'Local', hint: 'runs on your machine, no API key needed' },
        { value: 'ollama', label: 'Ollama', hint: 'local Ollama server' },
        { value: 'openai', label: 'OpenAI', hint: 'requires API key' },
        { value: 'cohere', label: 'Cohere', hint: 'requires API key' },
      ],
      initialValue: 'local',
    });
    if (p.isCancel(providerChoice)) { p.cancel('Cancelled.'); return null; }
    embedProvider = providerChoice;

    const defaultModels: Record<string, string> = {
      local: 'Snowflake/snowflake-arctic-embed-xs',
      ollama: 'nomic-embed-text',
      openai: 'text-embedding-3-small',
      cohere: 'embed-english-light-v3.0',
    };

    const model = await p.text({
      message: 'Embedding model',
      initialValue: defaultModels[embedProvider] || defaultModels.local,
    });
    if (p.isCancel(model)) { p.cancel('Cancelled.'); return null; }
    embedModel = model;

    const dims = await p.text({
      message: 'Vector dimensions',
      initialValue: '384',
    });
    if (p.isCancel(dims)) { p.cancel('Cancelled.'); return null; }
    embedDims = dims || '384';

    if (embedProvider === 'ollama') {
      const endpoint = await p.text({
        message: 'Ollama endpoint',
        initialValue: process.env.GITNEXUS_EMBED_ENDPOINT || 'http://localhost:11434',
      });
      if (p.isCancel(endpoint)) { p.cancel('Cancelled.'); return null; }
      embedEndpoint = endpoint;
    }

    if (embedProvider === 'openai' || embedProvider === 'cohere') {
      const existingKey = process.env.GITNEXUS_EMBED_API_KEY
        || (embedProvider === 'openai' ? process.env.OPENAI_API_KEY : undefined)
        || (embedProvider === 'cohere' ? process.env.COHERE_API_KEY : undefined);

      if (existingKey) {
        const masked = existingKey.slice(0, 6) + '...' + existingKey.slice(-4);
        const useExisting = await p.confirm({
          message: `Use existing API key (${masked})?`,
          initialValue: true,
        });
        if (p.isCancel(useExisting)) { p.cancel('Cancelled.'); return null; }
        if (!useExisting) {
          const key = await p.password({ message: 'API key' });
          if (p.isCancel(key)) { p.cancel('Cancelled.'); return null; }
          embedApiKey = key;
        } else {
          embedApiKey = existingKey;
        }
      } else {
        const key = await p.password({ message: 'API key' });
        if (p.isCancel(key)) { p.cancel('Cancelled.'); return null; }
        embedApiKey = key;
      }
    }
  }

  // ── Step 4: Force re-index? (only if up-to-date) ─────────────────
  let force = false;
  const { storagePath } = getStoragePaths(repoPath);
  const existingMeta = await loadMeta(storagePath);
  const currentCommit = getCurrentCommit(repoPath);

  if (existingMeta && existingMeta.lastCommit === currentCommit) {
    const forceChoice = await p.confirm({
      message: 'Index is up to date at this commit. Force re-index?',
      initialValue: false,
    });
    if (p.isCancel(forceChoice)) { p.cancel('Cancelled.'); return null; }
    force = forceChoice;
    if (!force) {
      p.log.info('Nothing to do — index is already current.');
      p.outro('Done');
      return null;
    }
  }

  // ── Step 5: Verbose logging ───────────────────────────────────────
  const verbose = await p.confirm({
    message: 'Show detailed logs?',
    initialValue: false,
  });
  if (p.isCancel(verbose)) { p.cancel('Cancelled.'); return null; }

  // ── Summary ───────────────────────────────────────────────────────
  const lines: string[] = [
    `Repository:  ${pc.bold(projectName)}`,
    `Path:        ${repoPath}`,
    `Database:    ${dbChoice === 'neptune' ? `Neptune (${neptuneEndpoint})` : 'KuzuDB (local)'}`,
    `Embeddings:  ${enableEmbeddings ? `${embedProvider} / ${embedModel}` : 'off'}`,
    `Force:       ${force ? 'yes' : 'no'}`,
    `Verbose:     ${verbose ? 'yes' : 'no'}`,
  ];

  p.note(lines.join('\n'), 'Configuration');

  const startAnalysis = await p.confirm({
    message: 'Start analysis?',
    initialValue: true,
  });
  if (p.isCancel(startAnalysis) || !startAnalysis) {
    p.cancel('Cancelled.');
    return null;
  }

  p.outro('Starting analysis...');

  return {
    options: {
      force,
      embeddings: enableEmbeddings || undefined,
      verbose: verbose || undefined,
      db: dbChoice as string,
      neptuneEndpoint,
      neptuneRegion,
      neptunePort,
      embedProvider,
      embedModel,
      embedDims,
      embedEndpoint,
      embedApiKey,
    },
    path: inputPath,
  };
}
