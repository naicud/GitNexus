import * as p from '@clack/prompts';
import pc from 'picocolors';

export function renderServeBanner(options: { port: number; host: string }): void {
  const url = `http://${options.host}:${options.port}`;

  p.intro(`${pc.bgCyan(pc.black(' GitNexus Web Server '))}`);
  p.log.info(`Listening at ${pc.bold(pc.cyan(url))}`);
  p.log.info(pc.dim('Press Ctrl+C to stop'));
}
