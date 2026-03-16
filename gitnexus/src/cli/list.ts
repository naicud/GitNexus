/**
 * List Command
 *
 * Shows all indexed repositories from the global registry.
 */

import { listRegisteredRepos } from '../storage/repo-manager.js';

export const listCommand = async () => {
  const entries = await listRegisteredRepos({ validate: true });
  const { renderRepoList } = await import('./tui/formatters/list-formatter.js');
  renderRepoList(entries);
};
