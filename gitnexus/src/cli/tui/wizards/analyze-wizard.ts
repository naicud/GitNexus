/**
 * Analyze Wizard — Interactive TUI for `gitnexus analyze`
 *
 * Guides users through configuration with smart defaults
 * and progressive disclosure. Only shown when no flags are passed.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import path from 'path';
import { getGitRoot } from '../../../storage/git.js';
import { getStoragePaths, loadMeta } from '../../../storage/repo-manager.js';
import { getCurrentCommit } from '../../../storage/git.js';
import { renderConfig } from '../components/config-display.js';
import type { AnalyzeOptions } from '../../analyze.js';

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

  // ── Step 2: Embeddings ────────────────────────────────────────────
  const enableEmbeddings = await p.confirm({
    message: 'Enable semantic search (embeddings)?',
    initialValue: false,
  });
  if (p.isCancel(enableEmbeddings)) { p.cancel('Cancelled.'); return null; }

  // ── Step 2b: Embedding provider config (conditional) ──────────────
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

  // ── Step 3: Force re-index? (only if up-to-date) ─────────────────
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

  // ── Step 4: Verbose logging ───────────────────────────────────────
  const verbose = await p.confirm({
    message: 'Show detailed logs?',
    initialValue: false,
  });
  if (p.isCancel(verbose)) { p.cancel('Cancelled.'); return null; }

  // ── Summary ───────────────────────────────────────────────────────
  renderConfig({
    'Repository': projectName,
    'Path': repoPath,
    'Database': 'LadybugDB (local)',
    'Embeddings': enableEmbeddings ? `${embedProvider} / ${embedModel}` : 'off',
    'Force': force,
    'Verbose': verbose,
  });

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
      embedProvider,
      embedModel,
      embedDims,
      embedEndpoint,
      embedApiKey,
    },
    path: inputPath,
  };
}
