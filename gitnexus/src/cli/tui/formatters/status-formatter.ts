import pc from 'picocolors';
import { renderSummaryBox } from '../components/summary-box.js';

interface StatusInfo {
  repoPath: string;
  indexedAt: string;
  indexedCommit: string;
  currentCommit: string;
  isUpToDate: boolean;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
}

export function renderStatus(info: StatusInfo): void {
  const items: Array<{ label: string; value: string | number; color?: (v: string) => string }> = [
    { label: 'Repository', value: info.repoPath, color: (v) => pc.bold(v) },
    { label: 'Indexed', value: new Date(info.indexedAt).toLocaleString() },
    { label: 'Indexed commit', value: info.indexedCommit?.slice(0, 7) || '?' },
    { label: 'Current commit', value: info.currentCommit?.slice(0, 7) || '?' },
    { label: 'Status', value: info.isUpToDate ? 'Up to date' : 'Stale',
      color: (v) => info.isUpToDate ? pc.green(v) : pc.yellow(v) },
  ];

  if (info.stats) {
    const s = info.stats;
    items.push({ label: 'Files', value: s.files ?? 0 });
    items.push({ label: 'Symbols', value: s.nodes ?? 0 });
    items.push({ label: 'Edges', value: s.edges ?? 0 });
    if (s.communities) items.push({ label: 'Communities', value: s.communities });
    if (s.processes) items.push({ label: 'Processes', value: s.processes });
    if (s.embeddings) items.push({ label: 'Embeddings', value: s.embeddings });
  }

  renderSummaryBox({ title: 'Repository Status', items });
}

export function renderNotIndexed(): void {
  process.stderr.write('\n  Repository not indexed.\n');
  process.stderr.write('  Run: gitnexus analyze\n\n');
}

export function renderNotGitRepo(): void {
  process.stderr.write('\n  Not a git repository.\n\n');
}
