import * as p from '@clack/prompts';
import pc from 'picocolors';
import { listRegisteredRepos, type RegistryEntry } from '../../../storage/repo-manager.js';

export async function pickRepo(options?: {
  message?: string;
  allowMultiple?: boolean;
}): Promise<RegistryEntry | null> {
  // Load registry
  const entries = await listRegisteredRepos({ validate: true });

  // 0 repos: show error, return null
  if (entries.length === 0) {
    p.log.error('No indexed repositories found. Run `gitnexus analyze` first.');
    return null;
  }

  // 1 repo: auto-select, show info
  if (entries.length === 1) {
    p.log.info(`Using ${pc.bold(entries[0].name)}`);
    return entries[0];
  }

  // 2+ repos: p.select() with repo name, path, stats
  const selected = await p.select({
    message: options?.message || 'Select repository',
    options: entries.map(e => ({
      value: e.name,
      label: e.name,
      hint: `${e.path} — ${e.stats?.nodes ?? 0} symbols`,
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel('Cancelled.');
    return null;
  }

  return entries.find(e => e.name === selected) || null;
}
