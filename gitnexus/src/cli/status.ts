/**
 * Status Command
 *
 * Shows the indexing status of the current repository.
 */

import { findRepo } from '../storage/repo-manager.js';
import { getCurrentCommit, isGitRepo } from '../storage/git.js';

export const statusCommand = async () => {
  const cwd = process.cwd();

  if (!isGitRepo(cwd)) {
    const { renderNotGitRepo } = await import('./tui/formatters/status-formatter.js');
    renderNotGitRepo();
    return;
  }

  const repo = await findRepo(cwd);
  if (!repo) {
    const { renderNotIndexed } = await import('./tui/formatters/status-formatter.js');
    renderNotIndexed();
    return;
  }

  const currentCommit = getCurrentCommit(repo.repoPath);
  const isUpToDate = currentCommit === repo.meta.lastCommit;

  const { renderStatus } = await import('./tui/formatters/status-formatter.js');
  renderStatus({
    repoPath: repo.repoPath,
    indexedAt: repo.meta.indexedAt,
    indexedCommit: repo.meta.lastCommit,
    currentCommit: currentCommit || '',
    isUpToDate,
    stats: repo.meta.stats,
  });
};
