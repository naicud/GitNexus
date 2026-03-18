import pc from 'picocolors';

export interface LogPanel {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  flush(): void;
}

export function createLogPanel(options?: { maxLines?: number; verbose?: boolean }): LogPanel {
  const maxLines = options?.maxLines ?? 100;
  const verbose = options?.verbose ?? !!process.env.GITNEXUS_VERBOSE;
  const buffer: Array<{ level: 'info' | 'warn' | 'error'; msg: string }> = [];
  let warnCount = 0;
  let errorCount = 0;

  return {
    info(msg: string) {
      if (verbose) {
        process.stderr.write(`  ${pc.dim(msg)}\n`);
      } else {
        if (buffer.length < maxLines) {
          buffer.push({ level: 'info', msg });
        }
      }
    },

    warn(msg: string) {
      warnCount++;
      if (verbose) {
        process.stderr.write(`  ${pc.yellow('warn')} ${msg}\n`);
      } else {
        buffer.push({ level: 'warn', msg });
      }
    },

    error(msg: string) {
      errorCount++;
      process.stderr.write(`  ${pc.red('error')} ${msg}\n`);
      buffer.push({ level: 'error', msg });
    },

    flush() {
      if (!verbose && (warnCount > 0 || errorCount > 0)) {
        const parts: string[] = [];
        if (errorCount > 0) parts.push(pc.red(`${errorCount} error${errorCount > 1 ? 's' : ''}`));
        if (warnCount > 0) parts.push(pc.yellow(`${warnCount} warning${warnCount > 1 ? 's' : ''}`));
        process.stderr.write(`  ${parts.join(', ')}\n`);
      }
    },
  };
}
