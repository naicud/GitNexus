import * as p from '@clack/prompts';
import pc from 'picocolors';

export async function runAugmentTUI(): Promise<void> {
  p.intro(`${pc.bgCyan(pc.black(' GitNexus Augment '))}`);

  const pattern = await p.text({
    message: 'Search pattern',
    placeholder: 'Enter pattern to augment with graph context',
    validate: (v) => v.trim().length < 3 ? 'Pattern must be at least 3 characters' : undefined,
  });
  if (p.isCancel(pattern)) { p.cancel('Cancelled.'); return; }

  p.outro('Augmenting...');

  const { augment } = await import('../../../core/augmentation/engine.js');

  try {
    const result = await augment(pattern, process.cwd());
    if (result) {
      process.stderr.write(result + '\n');
    } else {
      process.stderr.write('  No augmentation found for this pattern.\n');
    }
  } catch {
    process.stderr.write('  Augmentation failed.\n');
  }
}

export function renderAugmentResults(result: string | null): void {
  if (result) {
    process.stderr.write(result + '\n');
  } else {
    process.stderr.write('  No augmentation found.\n');
  }
}
