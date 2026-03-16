import pc from 'picocolors';
import { confirmDestructive } from '../components/confirm-destructive.js';
import { listRegisteredRepos, unregisterRepo, findRepo } from '../../../storage/repo-manager.js';
import fs from 'fs/promises';

export async function cleanInteractive(options?: { force?: boolean; all?: boolean; yes?: boolean }): Promise<void> {
  if (options?.all) {
    const entries = await listRegisteredRepos();
    if (entries.length === 0) {
      process.stderr.write('  No indexed repositories found.\n');
      return;
    }

    // Skip confirmation if --force or --yes
    if (!options?.force && !options?.yes) {
      const confirmed = await confirmDestructive({
        message: `Delete GitNexus indexes for ${entries.length} repo(s)?`,
        details: entries.map(e => `${e.name} (${e.storagePath})`),
      });
      if (!confirmed) return;
    }

    for (const entry of entries) {
      try {
        await fs.rm(entry.storagePath, { recursive: true, force: true });
        await unregisterRepo(entry.path);
        process.stderr.write(`  ${pc.green('Deleted:')} ${entry.name} (${entry.storagePath})\n`);
      } catch (err: any) {
        process.stderr.write(`  ${pc.red('Failed:')} ${entry.name}: ${err.message}\n`);
      }
    }
    return;
  }

  // Default: clean current repo
  const cwd = process.cwd();
  const repo = await findRepo(cwd);

  if (!repo) {
    process.stderr.write('  No indexed repository found in this directory.\n');
    return;
  }

  const repoName = repo.repoPath.split(/[/\\]/).pop() || repo.repoPath;

  // Skip confirmation if --force or --yes
  if (!options?.force && !options?.yes) {
    const confirmed = await confirmDestructive({
      message: `Delete GitNexus index for ${repoName}?`,
      details: [`Path: ${repo.storagePath}`],
    });
    if (!confirmed) return;
  }

  try {
    await fs.rm(repo.storagePath, { recursive: true, force: true });
    await unregisterRepo(repo.repoPath);
    process.stderr.write(`  ${pc.green('Deleted:')} ${repo.storagePath}\n`);
  } catch (err: any) {
    process.stderr.write(`  ${pc.red('Failed:')} ${err.message}\n`);
  }
}
