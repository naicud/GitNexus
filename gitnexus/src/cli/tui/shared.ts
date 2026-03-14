/**
 * TUI Shared Utilities
 *
 * Detection logic for when to launch the interactive wizard,
 * and env-var serialization for surviving the heap re-exec.
 */

import type { AnalyzeOptions } from '../analyze.js';

/** Keys that don't count as "the user passed a real flag". */
const IGNORED_KEYS = new Set(['yes']);

/**
 * Returns true when no explicit flags were passed (ignoring `--yes`).
 * Commander sets missing options to `undefined`, so we check for that.
 */
export function hasExplicitFlags(options: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(options)) {
    if (IGNORED_KEYS.has(key)) continue;
    if (value !== undefined) return true;
  }
  return false;
}

/**
 * Check env vars that act as explicit configuration.
 * If any are set, the user is scripting / automating — skip the TUI.
 */
function hasExplicitEnvConfig(): boolean {
  return !!(
    process.env.GITNEXUS_DB_TYPE ||
    process.env.GITNEXUS_NEPTUNE_ENDPOINT ||
    process.env.GITNEXUS_EMBED_PROVIDER ||
    process.env.GITNEXUS_FORCE
  );
}

/**
 * Should we launch the interactive wizard?
 *
 * True when:
 *  - stdout is a TTY
 *  - not running in CI
 *  - no explicit CLI flags were passed
 *  - `--yes` was not passed
 *  - not a re-exec child (GITNEXUS_TUI_DONE !== '1')
 *  - no explicit env-var configuration
 */
export function shouldRunInteractive(options: Record<string, unknown>): boolean {
  if (process.env.GITNEXUS_TUI_DONE === '1') return false;
  if (!process.stdout.isTTY) return false;
  if (process.env.CI === 'true' || process.env.CI === '1') return false;
  if (options.yes) return false;
  if (hasExplicitFlags(options)) return false;
  if (hasExplicitEnvConfig()) return false;
  return true;
}

// ─── Env serialization (analyze wizard → heap re-exec) ───────────────

const ENV_MAP: Record<string, string> = {
  force: 'GITNEXUS_FORCE',
  embeddings: 'GITNEXUS_EMBEDDINGS',
  skills: 'GITNEXUS_SKILLS',
  verbose: 'GITNEXUS_VERBOSE',
  db: 'GITNEXUS_DB_TYPE',
  neptuneEndpoint: 'GITNEXUS_NEPTUNE_ENDPOINT',
  neptuneRegion: 'GITNEXUS_NEPTUNE_REGION',
  neptunePort: 'GITNEXUS_NEPTUNE_PORT',
  embedProvider: 'GITNEXUS_EMBED_PROVIDER',
  embedModel: 'GITNEXUS_EMBED_MODEL',
  embedDims: 'GITNEXUS_EMBED_DIMS',
  embedEndpoint: 'GITNEXUS_EMBED_ENDPOINT',
  embedApiKey: 'GITNEXUS_EMBED_API_KEY',
};

/**
 * Write wizard results into `process.env` so the heap re-exec child
 * can pick them up. Also sets `GITNEXUS_TUI_DONE=1`.
 */
export function serializeToEnv(result: { options: AnalyzeOptions; path?: string }): void {
  process.env.GITNEXUS_TUI_DONE = '1';
  if (result.path) {
    process.env.GITNEXUS_TUI_PATH = result.path;
  }
  for (const [key, envKey] of Object.entries(ENV_MAP)) {
    const val = (result.options as Record<string, unknown>)[key];
    if (val !== undefined && val !== false) {
      process.env[envKey] = String(val === true ? '1' : val);
    }
  }
}

/**
 * Read wizard results back from env vars after heap re-exec.
 * Only reads the flags that existing resolvers (resolveNeptuneConfig,
 * resolveEmbeddingConfig) do NOT already handle — i.e. force, embeddings,
 * skills, verbose.
 */
export function deserializeFromEnv(): Partial<AnalyzeOptions> & { tuiPath?: string } {
  const result: Partial<AnalyzeOptions> & { tuiPath?: string } = {};
  if (process.env.GITNEXUS_FORCE === '1') result.force = true;
  if (process.env.GITNEXUS_EMBEDDINGS === '1') result.embeddings = true;
  if (process.env.GITNEXUS_SKILLS === '1') result.skills = true;
  if (process.env.GITNEXUS_VERBOSE === '1') result.verbose = true;
  if (process.env.GITNEXUS_TUI_PATH) result.tuiPath = process.env.GITNEXUS_TUI_PATH;
  return result;
}
