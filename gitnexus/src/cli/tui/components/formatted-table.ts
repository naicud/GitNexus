import pc from 'picocolors';

interface Column {
  key: string;
  label: string;
  align?: 'left' | 'right';
  color?: (v: string) => string;
}

export function renderTable(options: {
  columns: Column[];
  rows: Record<string, string | number>[];
  title?: string;
  maxWidth?: number;
}): void {
  const { columns, rows, title } = options;

  if (rows.length === 0) {
    process.stderr.write('  No results.\n');
    return;
  }

  // Calculate column widths from content
  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col.key] = col.label.length;
    for (const row of rows) {
      const val = String(row[col.key] ?? '');
      widths[col.key] = Math.max(widths[col.key], val.length);
    }
  }

  // Render title
  if (title) {
    process.stderr.write(`\n  ${pc.bold(title)}\n\n`);
  }

  // Render header
  const headerParts = columns.map(col => {
    const label = col.label;
    return col.align === 'right'
      ? label.padStart(widths[col.key])
      : label.padEnd(widths[col.key]);
  });
  process.stderr.write(`  ${pc.dim(headerParts.join('  '))}\n`);

  // Separator
  const sepParts = columns.map(col => pc.dim('\u2500'.repeat(widths[col.key])));
  process.stderr.write(`  ${sepParts.join('  ')}\n`);

  // Render rows
  for (const row of rows) {
    const parts = columns.map(col => {
      const val = String(row[col.key] ?? '');
      const padded = col.align === 'right'
        ? val.padStart(widths[col.key])
        : val.padEnd(widths[col.key]);
      return col.color ? col.color(padded) : padded;
    });
    process.stderr.write(`  ${parts.join('  ')}\n`);
  }

  process.stderr.write('\n');
}
