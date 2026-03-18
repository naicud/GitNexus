import * as p from '@clack/prompts';
import pc from 'picocolors';
import { pickRepo } from '../components/repo-picker.js';
import { renderSummaryBox } from '../components/summary-box.js';

export async function runContextTUI(options?: { repo?: string }): Promise<void> {
  p.intro(`${pc.bgCyan(pc.black(' GitNexus Context '))}`);

  let repoName = options?.repo;
  if (!repoName) {
    const repo = await pickRepo({ message: 'Look up symbol in repository' });
    if (!repo) return;
    repoName = repo.name;
  }

  const symbolName = await p.text({
    message: 'Symbol name',
    placeholder: 'e.g. "validateUser", "AuthService", "handleRequest"',
    validate: (v) => v.trim().length === 0 ? 'Symbol name is required' : undefined,
  });
  if (p.isCancel(symbolName)) { p.cancel('Cancelled.'); return; }

  p.outro('Looking up...');

  const { LocalBackend } = await import('../../../mcp/local/local-backend.js');
  const backend = new LocalBackend();
  const ok = await backend.init();
  if (!ok) {
    process.stderr.write('  No indexed repositories found. Run: gitnexus analyze\n');
    return;
  }

  const result = await backend.callTool('context', {
    name: symbolName,
    repo: repoName,
  });

  renderContextResults(result);
}

export function renderContextResults(result: any): void {
  // Parse the tool result
  let text: string;
  if (Array.isArray(result)) {
    text = result.find((c: any) => c.type === 'text')?.text || JSON.stringify(result, null, 2);
  } else if (typeof result === 'object' && result.content) {
    text = result.content.find((c: any) => c.type === 'text')?.text || JSON.stringify(result, null, 2);
  } else {
    text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  // Try to parse as JSON for structured display
  try {
    const data = JSON.parse(text);
    if (data.symbol) {
      const items: Array<{ label: string; value: string | number }> = [
        { label: 'Name', value: data.symbol.name || '?' },
        { label: 'Type', value: data.symbol.type || '?' },
        { label: 'File', value: data.symbol.file || '?' },
      ];
      if (data.callers?.length) items.push({ label: 'Callers', value: data.callers.length });
      if (data.callees?.length) items.push({ label: 'Callees', value: data.callees.length });
      if (data.processes?.length) items.push({ label: 'Processes', value: data.processes.length });

      renderSummaryBox({ title: 'Symbol Context', items });

      // Show details
      if (data.callers?.length) {
        process.stderr.write(`  ${pc.bold('Callers:')}\n`);
        for (const c of data.callers.slice(0, 10)) {
          process.stderr.write(`    ${pc.dim('\u2190')} ${c.name || c}\n`);
        }
        if (data.callers.length > 10) process.stderr.write(`    ${pc.dim(`... and ${data.callers.length - 10} more`)}\n`);
      }
      if (data.callees?.length) {
        process.stderr.write(`  ${pc.bold('Callees:')}\n`);
        for (const c of data.callees.slice(0, 10)) {
          process.stderr.write(`    ${pc.dim('\u2192')} ${c.name || c}\n`);
        }
        if (data.callees.length > 10) process.stderr.write(`    ${pc.dim(`... and ${data.callees.length - 10} more`)}\n`);
      }
      process.stderr.write('\n');
      return;
    }
  } catch {
    // Not JSON -- just print
  }

  process.stderr.write(text + '\n');
}
