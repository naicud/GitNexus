import cliProgress from 'cli-progress';
import pc from 'picocolors';

export interface PhaseConfig {
  name: string;
  label: string;
  weight: number; // % of total (all should sum to 100)
}

export interface MultiProgress {
  setPhase(name: string): void;
  update(percent: number, detail?: string): void;
  setStats(stats: Record<string, number>): void;
  log(message: string): void;
  complete(summary: Record<string, string | number>): void;
  stop(): void;
}

export function createMultiProgress(phases: PhaseConfig[]): MultiProgress {
  // Validate weights sum to ~100
  const totalWeight = phases.reduce((s, p) => s + p.weight, 0);

  // State
  let currentPhaseIdx = -1;
  const phaseStartTimes: number[] = new Array(phases.length).fill(0);
  const phaseDoneTimes: number[] = new Array(phases.length).fill(0);
  let currentDetail = '';
  let currentStats: Record<string, number> = {};
  let stopped = false;

  // Single progress bar (renders the active phase)
  const bar = new cliProgress.SingleBar({
    format: '  {bar} {percentage}% | {phase}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    barGlue: '',
    autopadding: true,
    clearOnComplete: false,
    stopOnComplete: false,
  }, cliProgress.Presets.shades_grey);

  bar.start(100, 0, { phase: 'Initializing...' });

  // Safe console routing
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const barLog = (...args: unknown[]) => {
    process.stdout.write('\x1b[2K\r');
    origLog(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  console.log = barLog;
  console.warn = barLog;
  console.error = barLog;

  // Elapsed time ticker
  let lastPhaseLabel = 'Initializing...';
  let lastPhaseStart = Date.now();

  const elapsedTimer = setInterval(() => {
    if (stopped || currentPhaseIdx < 0) return;
    const elapsed = Math.round((Date.now() - lastPhaseStart) / 1000);
    if (elapsed >= 3) {
      const detailPart = currentDetail ? ` | ${currentDetail}` : '';
      bar.update({ phase: `${lastPhaseLabel}${detailPart} (${elapsed}s)` });
    }
  }, 1000);

  function logPhaseTransition(fromIdx: number, _toIdx: number) {
    if (fromIdx >= 0 && fromIdx < phases.length) {
      const elapsed = Math.round((Date.now() - phaseStartTimes[fromIdx]) / 1000);
      barLog(`  ${pc.green('\u2713')} ${phases[fromIdx].label} ${pc.dim(`(${elapsed}s)`)}`);
    }
  }

  function calcOverallPercent(phaseIdx: number, phasePercent: number): number {
    let base = 0;
    for (let i = 0; i < phaseIdx; i++) {
      base += phases[i].weight;
    }
    const scaled = base + (phases[phaseIdx].weight * phasePercent / 100);
    return Math.min(100, Math.round(scaled * 100 / totalWeight));
  }

  return {
    setPhase(name: string) {
      const idx = phases.findIndex(p => p.name === name);
      if (idx < 0) return;
      if (idx === currentPhaseIdx) return;

      const prevIdx = currentPhaseIdx;
      if (prevIdx >= 0) {
        phaseDoneTimes[prevIdx] = Date.now();
      }

      logPhaseTransition(prevIdx, idx);

      currentPhaseIdx = idx;
      phaseStartTimes[idx] = Date.now();
      currentDetail = '';
      lastPhaseLabel = phases[idx].label;
      lastPhaseStart = Date.now();

      const overall = calcOverallPercent(idx, 0);
      bar.update(overall, { phase: phases[idx].label });
    },

    update(percent: number, detail?: string) {
      if (currentPhaseIdx < 0) return;
      if (detail !== undefined) currentDetail = detail;

      const overall = calcOverallPercent(currentPhaseIdx, percent);
      const elapsed = Math.round((Date.now() - lastPhaseStart) / 1000);
      const detailPart = currentDetail ? ` | ${currentDetail}` : '';
      const timePart = elapsed >= 3 ? ` (${elapsed}s)` : '';
      bar.update(overall, { phase: `${lastPhaseLabel}${detailPart}${timePart}` });
    },

    setStats(stats: Record<string, number>) {
      currentStats = { ...currentStats, ...stats };
      // Show stats in detail line
      const parts = Object.entries(currentStats).map(([k, v]) => `${v.toLocaleString()} ${k}`);
      if (parts.length > 0 && currentDetail) {
        currentDetail = `${currentDetail} | ${parts.join(' \u00b7 ')}`;
      }
    },

    log(message: string) {
      barLog(message);
    },

    complete(summary: Record<string, string | number>) {
      if (currentPhaseIdx >= 0) {
        phaseDoneTimes[currentPhaseIdx] = Date.now();
        logPhaseTransition(currentPhaseIdx, -1);
      }

      clearInterval(elapsedTimer);
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;

      bar.update(100, { phase: 'Done' });
      bar.stop();
      stopped = true;

      // Print summary
      const lines = Object.entries(summary).map(([k, v]) => `  ${pc.dim(k + ':')} ${pc.bold(String(v))}`);
      process.stderr.write('\n' + lines.join('\n') + '\n\n');
    },

    stop() {
      clearInterval(elapsedTimer);
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
      bar.stop();
      stopped = true;
    },
  };
}
