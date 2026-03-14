import * as p from '@clack/prompts';
import pc from 'picocolors';
import { pickRepo } from '../components/repo-picker.js';
import { renderTable } from '../components/formatted-table.js';

export async function runCypherTUI(options?: { repo?: string }): Promise<void> {
  p.intro(`${pc.bgMagenta(pc.black(' GitNexus Cypher Console '))}`);

  let repoName = options?.repo;
  if (!repoName) {
    const repo = await pickRepo({ message: 'Query repository' });
    if (!repo) return;
    repoName = repo.name;
  }

  const query = await p.text({
    message: 'Cypher query',
    placeholder: 'e.g. MATCH (n:Function) RETURN n.name LIMIT 10',
    validate: (v) => v.trim().length === 0 ? 'Query is required' : undefined,
  });
  if (p.isCancel(query)) { p.cancel('Cancelled.'); return; }

  p.outro('Executing...');

  const { LocalBackend } = await import('../../../mcp/local/local-backend.js');
  const backend = new LocalBackend();
  const ok = await backend.init();
  if (!ok) {
    process.stderr.write('  No indexed repositories found. Run: gitnexus analyze\n');
    return;
  }

  const result = await backend.callTool('cypher', {
    query,
    repo: repoName,
  });

  renderCypherResults(result);
}

export function renderCypherResults(result: any): void {
  let text: string;
  if (Array.isArray(result)) {
    text = result.find((c: any) => c.type === 'text')?.text || JSON.stringify(result, null, 2);
  } else if (typeof result === 'object' && result.content) {
    text = result.content.find((c: any) => c.type === 'text')?.text || JSON.stringify(result, null, 2);
  } else {
    text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  try {
    const data = JSON.parse(text);
    if (Array.isArray(data) && data.length > 0) {
      // Auto-detect columns from first row
      const columns = Object.keys(data[0]).map(key => ({
        key,
        label: key,
      }));

      const rows = data.map((row: any) => {
        const mapped: Record<string, string | number> = {};
        for (const key of Object.keys(row)) {
          const val = row[key];
          mapped[key] = typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
        }
        return mapped;
      });

      renderTable({ columns, rows, title: `Results (${data.length} rows)` });
      return;
    }
  } catch {
    // Not JSON
  }

  process.stderr.write(text + '\n');
}
