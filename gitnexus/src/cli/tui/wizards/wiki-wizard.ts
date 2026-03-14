/**
 * Wiki Wizard — Interactive TUI for `gitnexus wiki`
 *
 * Replaces the hand-rolled readline prompts with a polished
 * @clack/prompts wizard. Only shown when no flags are passed.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import path from 'path';
import { loadCLIConfig, saveCLIConfig, getStoragePaths, loadMeta } from '../../../storage/repo-manager.js';
import { getGitRoot, isGitRepo } from '../../../storage/git.js';
import { renderConfig } from '../components/config-display.js';
import type { WikiCommandOptions } from '../../wiki.js';

interface LLMConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface WikiWizardResult {
  options: WikiCommandOptions;
  llmConfig: LLMConfig;
}

export async function runWikiWizard(
  inputPath: string | undefined,
  _currentOptions: WikiCommandOptions,
): Promise<WikiWizardResult | null> {
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

  if (!isGitRepo(repoPath)) {
    p.log.error('Not a git repository.');
    return null;
  }

  // Check for existing index
  const { storagePath } = getStoragePaths(repoPath);
  const meta = await loadMeta(storagePath);
  if (!meta) {
    p.log.error('No GitNexus index found. Run `gitnexus analyze` first.');
    return null;
  }

  const projectName = path.basename(repoPath);
  const savedConfig = await loadCLIConfig();

  p.intro(`${pc.bgMagenta(pc.black(' GitNexus Wiki Generator '))}`);

  p.log.info(`Generating wiki for ${pc.bold(projectName)}`);

  // ── Step 1: LLM Provider ─────────────────────────────────────────
  const providerChoice = await p.select({
    message: 'LLM provider',
    options: [
      { value: 'openai', label: 'OpenAI', hint: 'api.openai.com' },
      { value: 'openrouter', label: 'OpenRouter', hint: 'openrouter.ai — many models' },
      { value: 'custom', label: 'Custom endpoint', hint: 'any OpenAI-compatible API' },
    ],
    initialValue: savedConfig.baseUrl?.includes('openrouter') ? 'openrouter'
      : savedConfig.baseUrl?.includes('openai') ? 'openai'
      : savedConfig.baseUrl ? 'custom' : 'openai',
  });
  if (p.isCancel(providerChoice)) { p.cancel('Cancelled.'); return null; }

  let baseUrl: string;
  let defaultModel: string;

  if (providerChoice === 'openrouter') {
    baseUrl = 'https://openrouter.ai/api/v1';
    defaultModel = 'minimax/minimax-m2.5';
  } else if (providerChoice === 'custom') {
    const url = await p.text({
      message: 'Base URL',
      placeholder: 'http://localhost:11434/v1',
      initialValue: savedConfig.baseUrl || '',
      validate: (v) => v.length === 0 ? 'URL is required' : undefined,
    });
    if (p.isCancel(url)) { p.cancel('Cancelled.'); return null; }
    baseUrl = url;
    defaultModel = 'gpt-4o-mini';
  } else {
    baseUrl = 'https://api.openai.com/v1';
    defaultModel = 'gpt-4o-mini';
  }

  // ── Step 2: Model ─────────────────────────────────────────────────
  const model = await p.text({
    message: 'Model',
    initialValue: savedConfig.model || defaultModel,
  });
  if (p.isCancel(model)) { p.cancel('Cancelled.'); return null; }

  // ── Step 3: API Key ───────────────────────────────────────────────
  const envKey = process.env.GITNEXUS_API_KEY || process.env.OPENAI_API_KEY || '';
  let apiKey: string;

  if (savedConfig.apiKey || envKey) {
    const existing = savedConfig.apiKey || envKey;
    const masked = existing.slice(0, 6) + '...' + existing.slice(-4);
    const useExisting = await p.confirm({
      message: `Use saved API key (${masked})?`,
      initialValue: true,
    });
    if (p.isCancel(useExisting)) { p.cancel('Cancelled.'); return null; }

    if (useExisting) {
      apiKey = existing;
    } else {
      const key = await p.password({ message: 'API key' });
      if (p.isCancel(key)) { p.cancel('Cancelled.'); return null; }
      apiKey = key;
    }
  } else {
    const key = await p.password({ message: 'API key' });
    if (p.isCancel(key)) { p.cancel('Cancelled.'); return null; }
    apiKey = key;
  }

  if (!apiKey) {
    p.cancel('No API key provided.');
    return null;
  }

  // ── Step 4: Concurrency ───────────────────────────────────────────
  const concurrency = await p.text({
    message: 'Parallel LLM calls (1-10)',
    initialValue: '3',
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1 || n > 10) return 'Enter a number between 1 and 10';
      return undefined;
    },
  });
  if (p.isCancel(concurrency)) { p.cancel('Cancelled.'); return null; }

  // ── Step 5: Force regen ───────────────────────────────────────────
  let force = false;
  const wikiDir = path.join(storagePath, 'wiki');
  try {
    const fs = await import('fs/promises');
    await fs.access(wikiDir);
    // Wiki exists — ask about force
    const forceChoice = await p.confirm({
      message: 'Existing wiki found. Force full regeneration?',
      initialValue: false,
    });
    if (p.isCancel(forceChoice)) { p.cancel('Cancelled.'); return null; }
    force = forceChoice;
  } catch {
    // No existing wiki — no need to ask
  }

  // ── Summary ───────────────────────────────────────────────────────
  renderConfig({
    'Repository': projectName,
    'Provider': baseUrl,
    'Model': model || defaultModel,
    'Concurrency': concurrency || '3',
    'Force': force,
  });

  const startWiki = await p.confirm({
    message: 'Generate wiki?',
    initialValue: true,
  });
  if (p.isCancel(startWiki) || !startWiki) {
    p.cancel('Cancelled.');
    return null;
  }

  // Save config for next time
  await saveCLIConfig({ apiKey, baseUrl, model: model || defaultModel });
  p.log.success('Config saved to ~/.gitnexus/config.json');

  p.outro('Starting wiki generation...');

  return {
    options: {
      force: force || undefined,
      model: model || defaultModel,
      baseUrl,
      apiKey,
      concurrency: concurrency || '3',
    },
    llmConfig: {
      baseUrl,
      model: model || defaultModel,
      apiKey,
    },
  };
}
