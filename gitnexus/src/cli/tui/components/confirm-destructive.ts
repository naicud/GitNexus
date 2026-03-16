import * as p from '@clack/prompts';
import pc from 'picocolors';

export async function confirmDestructive(options: {
  message: string;
  details: string[];
}): Promise<boolean> {
  // Show warning banner
  p.log.warn(pc.red(pc.bold(options.message)));

  // List affected items
  if (options.details.length > 0) {
    for (const detail of options.details) {
      p.log.message(`  ${pc.red('\u2022')} ${detail}`);
    }
  }

  const confirmed = await p.confirm({
    message: pc.red('Are you sure?'),
    initialValue: false,
  });

  if (p.isCancel(confirmed)) {
    p.cancel('Cancelled.');
    return false;
  }

  return confirmed;
}
