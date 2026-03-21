import pc from 'picocolors';

export function renderAiContextResult(files: string[]): void {
  if (files.length === 0) return;
  process.stderr.write(`  ${pc.dim('Context:')} ${files.join(', ')}\n`);
}
