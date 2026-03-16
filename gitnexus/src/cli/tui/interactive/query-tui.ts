import * as p from '@clack/prompts';
import pc from 'picocolors';
import { pickRepo } from '../components/repo-picker.js';
import { renderTable } from '../components/formatted-table.js';

export async function runQueryTUI(options?: { repo?: string }): Promise<void> {
  p.intro(`${pc.bgCyan(pc.black(' GitNexus Query '))}`);

  let repoName = options?.repo;
  if (!repoName) {
    const repo = await pickRepo({ message: 'Search in repository' });
    if (!repo) return;
    repoName = repo.name;
  }

  const queryText = await p.text({
    message: 'Search query',
    placeholder: 'e.g. "authentication flow", "error handling", "database connection"',
    validate: (v) => v.trim().length === 0 ? 'Query is required' : undefined,
  });
  if (p.isCancel(queryText)) { p.cancel('Cancelled.'); return; }

  const context = await p.text({
    message: 'Task context (optional)',
    placeholder: 'What are you working on?',
  });
  if (p.isCancel(context)) { p.cancel('Cancelled.'); return; }

  p.outro('Searching...');

  // Execute query via LocalBackend
  const { LocalBackend } = await import('../../../mcp/local/local-backend.js');
  const backend = new LocalBackend();
  const ok = await backend.init();
  if (!ok) {
    process.stderr.write('  No indexed repositories found. Run: gitnexus analyze\n');
    return;
  }

  const result = await backend.callTool('query', {
    query: queryText,
    task_context: (context as string)?.trim() || undefined,
    repo: repoName,
  });

  renderQueryResults(result);
}

export function renderQueryResults(result: any): void {
  if (!result) {
    process.stderr.write('  No results found.\n');
    return;
  }

  // The result from callTool is a tool result with content array
  // Parse the text content
  let data: any;
  if (Array.isArray(result)) {
    const textContent = result.find((c: any) => c.type === 'text');
    if (textContent) {
      try {
        data = JSON.parse(textContent.text);
      } catch {
        // Just output raw text
        process.stderr.write(textContent.text + '\n');
        return;
      }
    }
  } else if (typeof result === 'object' && result.content) {
    const textContent = result.content.find((c: any) => c.type === 'text');
    if (textContent) {
      try {
        data = JSON.parse(textContent.text);
      } catch {
        process.stderr.write(textContent.text + '\n');
        return;
      }
    }
  } else {
    // Raw result - just display as formatted JSON
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    process.stderr.write(text + '\n');
    return;
  }

  // If we got structured data with processes, render as table
  if (data?.processes && Array.isArray(data.processes)) {
    const rows = data.processes.map((proc: any, i: number) => ({
      '#': i + 1,
      'Process': proc.name || proc.process || 'Unknown',
      'Relevance': proc.relevance || proc.score || '',
      'Symbols': proc.symbolCount || proc.symbols?.length || 0,
    }));

    renderTable({
      title: `Query Results (${data.processes.length} flows)`,
      columns: [
        { key: '#', label: '#', align: 'right' },
        { key: 'Process', label: 'Process', color: (v) => pc.bold(v) },
        { key: 'Relevance', label: 'Relevance' },
        { key: 'Symbols', label: 'Symbols', align: 'right' },
      ],
      rows,
    });
  } else {
    // Fallback to formatted JSON
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    process.stderr.write(text + '\n');
  }
}
