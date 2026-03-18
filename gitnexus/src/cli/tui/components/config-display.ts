import * as p from '@clack/prompts';
import pc from 'picocolors';

export function renderConfig(config: Record<string, string | number | boolean | undefined>): void {
  const entries = Object.entries(config).filter(([_, v]) => v !== undefined);

  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));

  const lines = entries.map(([key, value]) => {
    const label = key.padEnd(maxKeyLen);
    const val = typeof value === 'boolean'
      ? (value ? pc.green('yes') : pc.dim('no'))
      : pc.bold(String(value));
    return `${label}  ${val}`;
  });

  p.note(lines.join('\n'), 'Configuration');
}
