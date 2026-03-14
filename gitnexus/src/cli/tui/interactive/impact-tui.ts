import * as p from '@clack/prompts';
import pc from 'picocolors';
import { pickRepo } from '../components/repo-picker.js';
import { renderTable } from '../components/formatted-table.js';

export async function runImpactTUI(options?: { repo?: string }): Promise<void> {
  p.intro(`${pc.bgYellow(pc.black(' GitNexus Impact Analysis '))}`);

  let repoName = options?.repo;
  if (!repoName) {
    const repo = await pickRepo({ message: 'Analyze impact in repository' });
    if (!repo) return;
    repoName = repo.name;
  }

  const target = await p.text({
    message: 'Target symbol',
    placeholder: 'e.g. "AuthService", "handleLogin", "UserModel"',
    validate: (v) => v.trim().length === 0 ? 'Target is required' : undefined,
  });
  if (p.isCancel(target)) { p.cancel('Cancelled.'); return; }

  const direction = await p.select({
    message: 'Analysis direction',
    options: [
      { value: 'upstream', label: 'Upstream', hint: 'who depends on this? (what breaks if I change it)' },
      { value: 'downstream', label: 'Downstream', hint: 'what does this depend on?' },
    ],
    initialValue: 'upstream',
  });
  if (p.isCancel(direction)) { p.cancel('Cancelled.'); return; }

  p.outro('Analyzing...');

  const { LocalBackend } = await import('../../../mcp/local/local-backend.js');
  const backend = new LocalBackend();
  const ok = await backend.init();
  if (!ok) {
    process.stderr.write('  No indexed repositories found. Run: gitnexus analyze\n');
    return;
  }

  const result = await backend.callTool('impact', {
    target,
    direction,
    repo: repoName,
  });

  renderImpactResults(result);
}

export function renderImpactResults(result: any): void {
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
    if (data.affected && Array.isArray(data.affected)) {
      const rows = data.affected.map((item: any) => ({
        'Symbol': item.name || item.symbol || '?',
        'Type': item.type || '?',
        'Depth': item.depth || item.distance || '?',
        'Risk': item.depth === 1 ? 'WILL BREAK' : item.depth === 2 ? 'LIKELY' : 'MAY',
        'File': item.file?.split('/').pop() || '?',
      }));

      renderTable({
        title: `Impact Analysis (${data.affected.length} affected)`,
        columns: [
          { key: 'Symbol', label: 'Symbol', color: (v) => pc.bold(v) },
          { key: 'Type', label: 'Type', color: (v) => pc.dim(v) },
          { key: 'Depth', label: 'Depth', align: 'right' },
          { key: 'Risk', label: 'Risk', color: (v) => {
            if (v.includes('WILL BREAK')) return pc.red(v);
            if (v.includes('LIKELY')) return pc.yellow(v);
            return pc.green(v);
          }},
          { key: 'File', label: 'File', color: (v) => pc.dim(v) },
        ],
        rows,
      });
      return;
    }
  } catch {
    // Not JSON
  }

  process.stderr.write(text + '\n');
}
