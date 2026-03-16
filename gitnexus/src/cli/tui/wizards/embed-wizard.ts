/**
 * Embed Wizard — Interactive TUI for `gitnexus embed`
 *
 * Guides users through embedding configuration with smart defaults.
 * Only shown when no flags are passed in an interactive terminal.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import path from 'path';
import { getGitRoot } from '../../../storage/git.js';
import { getStoragePaths, loadMeta, readRegistry } from '../../../storage/repo-manager.js';
import { renderConfig } from '../components/config-display.js';
import type { EmbedOptions } from '../../embed-config.js';

export interface EmbedWizardResult {
  options: EmbedOptions & { force?: boolean };
  path?: string;
}

export async function runEmbedWizard(
  inputPath: string | undefined,
): Promise<EmbedWizardResult | null> {
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

  // Validate index exists
  const { storagePath } = getStoragePaths(repoPath);
  const meta = await loadMeta(storagePath);
  if (!meta) {
    p.log.error(`No GitNexus index found for ${pc.bold(projectName)}. Run ${pc.cyan('gitnexus analyze')} first.`);
    return null;
  }

  p.intro(`${pc.bgCyan(pc.black(' GitNexus Embeddings '))}`);

  // Show existing embedding info if available
  const registry = await readRegistry();
  const existingEntry = registry.find(e => path.resolve(e.path) === path.resolve(repoPath));
  const existingEmbed = existingEntry?.embedding;
  const existingCount = meta.stats?.embeddings ?? 0;

  if (existingEmbed) {
    p.log.info(
      `Existing: ${pc.bold(existingEmbed.provider)}/${pc.bold(existingEmbed.model)} ` +
      `(${existingEmbed.dimensions}d) — ${existingCount.toLocaleString()} embeddings`
    );
  } else {
    p.log.info('No existing embeddings found.');
  }

  // ── Provider ──────────────────────────────────────────────────────
  const providerChoice = await p.select({
    message: 'Embedding provider',
    options: [
      { value: 'local', label: 'Local', hint: 'runs on your machine, no API key needed' },
      { value: 'ollama', label: 'Ollama', hint: 'local Ollama server' },
      { value: 'openai', label: 'OpenAI', hint: 'requires API key' },
      { value: 'cohere', label: 'Cohere', hint: 'requires API key' },
    ],
    initialValue: existingEmbed?.provider ?? 'local',
  });
  if (p.isCancel(providerChoice)) { p.cancel('Cancelled.'); return null; }

  // ── Model ─────────────────────────────────────────────────────────
  const defaultModels: Record<string, string> = {
    local: 'Snowflake/snowflake-arctic-embed-xs',
    ollama: 'nomic-embed-text',
    openai: 'text-embedding-3-small',
    cohere: 'embed-english-light-v3.0',
  };

  const modelDefault = (existingEmbed?.provider === providerChoice && existingEmbed?.model)
    ? existingEmbed.model
    : defaultModels[providerChoice] || defaultModels.local;

  const model = await p.text({
    message: 'Embedding model',
    initialValue: modelDefault,
  });
  if (p.isCancel(model)) { p.cancel('Cancelled.'); return null; }

  // ── Dimensions ────────────────────────────────────────────────────
  const dimsDefault = existingEmbed?.dimensions
    ? String(existingEmbed.dimensions)
    : '384';

  const dims = await p.text({
    message: 'Vector dimensions',
    initialValue: dimsDefault,
  });
  if (p.isCancel(dims)) { p.cancel('Cancelled.'); return null; }

  // ── Endpoint (Ollama / OpenAI) ────────────────────────────────────
  let embedEndpoint: string | undefined;
  if (providerChoice === 'ollama') {
    const endpoint = await p.text({
      message: 'Ollama endpoint',
      initialValue: existingEmbed?.endpoint || process.env.GITNEXUS_EMBED_ENDPOINT || 'http://localhost:11434',
    });
    if (p.isCancel(endpoint)) { p.cancel('Cancelled.'); return null; }
    embedEndpoint = endpoint;
  } else if (providerChoice === 'openai') {
    const endpoint = await p.text({
      message: 'OpenAI-compatible endpoint (leave empty for default)',
      initialValue: existingEmbed?.endpoint || process.env.GITNEXUS_EMBED_ENDPOINT || '',
    });
    if (p.isCancel(endpoint)) { p.cancel('Cancelled.'); return null; }
    embedEndpoint = endpoint || undefined;
  }

  // ── API Key (OpenAI / Cohere) ─────────────────────────────────────
  let embedApiKey: string | undefined;
  if (providerChoice === 'openai' || providerChoice === 'cohere') {
    const existingKey = process.env.GITNEXUS_EMBED_API_KEY
      || (providerChoice === 'openai' ? process.env.OPENAI_API_KEY : undefined)
      || (providerChoice === 'cohere' ? process.env.COHERE_API_KEY : undefined);

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

  // ── Force? ────────────────────────────────────────────────────────
  let force = false;
  const newDims = parseInt(dims || '384', 10);
  const configChanged = existingEmbed && (
    existingEmbed.provider !== providerChoice ||
    existingEmbed.model !== model ||
    existingEmbed.dimensions !== newDims
  );

  if (configChanged && existingCount > 0) {
    p.log.warn(
      `Config changed from ${existingEmbed!.provider}/${existingEmbed!.model}/${existingEmbed!.dimensions}d ` +
      `to ${providerChoice}/${model}/${newDims}d — all embeddings will be regenerated.`
    );
    force = true;
  } else if (existingCount > 0) {
    const forceChoice = await p.confirm({
      message: `${existingCount.toLocaleString()} embeddings exist. Force regenerate all?`,
      initialValue: false,
    });
    if (p.isCancel(forceChoice)) { p.cancel('Cancelled.'); return null; }
    force = forceChoice;
  }

  // ── Summary ───────────────────────────────────────────────────────
  renderConfig({
    'Repository': projectName,
    'Provider': providerChoice,
    'Model': model,
    'Dimensions': newDims,
    'Endpoint': embedEndpoint,
    'Force': force,
  });

  const startEmbed = await p.confirm({
    message: 'Start embedding?',
    initialValue: true,
  });
  if (p.isCancel(startEmbed) || !startEmbed) {
    p.cancel('Cancelled.');
    return null;
  }

  p.outro('Starting embeddings...');

  return {
    options: {
      embedProvider: providerChoice,
      embedModel: model,
      embedDims: dims || '384',
      embedEndpoint,
      embedApiKey,
      force,
    },
    path: inputPath,
  };
}
