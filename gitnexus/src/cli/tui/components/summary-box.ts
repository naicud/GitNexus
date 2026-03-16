import * as p from '@clack/prompts';
import pc from 'picocolors';

export function renderSummaryBox(options: {
  title: string;
  items: Array<{ label: string; value: string | number; color?: (v: string) => string }>;
}): void {
  const maxLabelLen = Math.max(...options.items.map(i => i.label.length));

  const lines = options.items.map(item => {
    const label = item.label.padEnd(maxLabelLen);
    const val = String(item.value);
    const coloredVal = item.color ? item.color(val) : pc.bold(val);
    return `${pc.dim(label)}  ${coloredVal}`;
  });

  p.note(lines.join('\n'), options.title);
}
