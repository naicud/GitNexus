import pc from 'picocolors';
import { renderTable } from '../components/formatted-table.js';
import type { RegistryEntry } from '../../../storage/repo-manager.js';

export function renderRepoList(entries: RegistryEntry[]): void {
  if (entries.length === 0) {
    process.stderr.write('\n  No indexed repositories found.\n');
    process.stderr.write('  Run `gitnexus analyze` in a git repo to index it.\n\n');
    return;
  }

  process.stderr.write(`\n  ${pc.bold(`Indexed Repositories (${entries.length})`)}\n\n`);

  const rows = entries.map(entry => {
    const indexed = new Date(entry.indexedAt);
    const dateStr = indexed.toLocaleDateString();

    return {
      name: entry.name,
      path: entry.path,
      indexed: dateStr,
      commit: entry.lastCommit?.slice(0, 7) || '?',
      symbols: entry.stats?.nodes ?? 0,
      edges: entry.stats?.edges ?? 0,
    };
  });

  renderTable({
    columns: [
      { key: 'name', label: 'Name', color: (v) => pc.bold(v) },
      { key: 'path', label: 'Path', color: (v) => pc.dim(v) },
      { key: 'indexed', label: 'Indexed' },
      { key: 'commit', label: 'Commit' },
      { key: 'symbols', label: 'Symbols', align: 'right' },
      { key: 'edges', label: 'Edges', align: 'right' },
    ],
    rows,
  });
}
