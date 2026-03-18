#!/usr/bin/env node

// Heap re-spawn removed — only analyze.ts needs the 8GB heap (via its own ensureHeap()).
// Removing it from here improves MCP server startup time significantly.

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { createLazyAction } from './lazy-action.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');
const program = new Command();

program
  .name('gitnexus')
  .description('GitNexus local CLI and MCP server')
  .version(pkg.version);

program
  .command('setup')
  .description('One-time setup: configure MCP for Cursor, Claude Code, OpenCode')
  .option('-y, --yes', 'Skip interactive prompts')
  .action(createLazyAction(() => import('./setup.js'), 'setupCommand'));

program
  .command('analyze [path]')
  .description('Index a repository (full analysis)')
  .option('-f, --force', 'Force full re-index even if up to date')
  .option('--embeddings', 'Enable embedding generation for semantic search (off by default)')
  .option('--embed-provider <type>', 'Embedding provider: ollama | cohere | openai | local (default: local)')
  .option('--embed-model <model>', 'Embedding model name (e.g. nomic-embed-text)')
  .option('--embed-dims <n>', 'Embedding vector dimensions (default: 384)')
  .option('--embed-endpoint <url>', 'API endpoint URL for remote providers')
  .option('--embed-api-key <key>', 'API key for cloud embedding providers')
  .option('--skills', 'Generate repo-specific skill files from detected communities')
   .option('-v, --verbose', 'Enable verbose ingestion warnings (default: false)')
   .option('-y, --yes', 'Skip interactive prompts, use defaults/flags')
   .addHelpText('after', '\nEnvironment variables:\n  GITNEXUS_NO_GITIGNORE=1  Skip .gitignore parsing (still reads .gitnexusignore)')
   .action(createLazyAction(() => import('./analyze.js'), 'analyzeCommand'));

program
  .command('embed [path]')
  .description('Generate or update embeddings for an already-indexed repository')
  .option('--provider <type>', 'Embedding provider: local | ollama | openai | cohere')
  .option('--model <model>', 'Embedding model name')
  .option('--dims <n>', 'Vector dimensions (default: 384)')
  .option('--endpoint <url>', 'API endpoint URL (Ollama, OpenAI-compatible)')
  .option('--api-key <key>', 'API key for cloud providers')
  .option('--embed-provider <type>', 'Alias for --provider')
  .option('--embed-model <model>', 'Alias for --model')
  .option('--embed-dims <n>', 'Alias for --dims')
  .option('--embed-endpoint <url>', 'Alias for --endpoint')
  .option('--embed-api-key <key>', 'Alias for --api-key')
  .option('-f, --force', 'Regenerate all embeddings')
  .option('-y, --yes', 'Skip interactive prompts')
  .action(createLazyAction(() => import('./embed.js'), 'embedCommand'));

program
  .command('serve')
  .description('Start local HTTP server for web UI connection')
  .option('-p, --port <port>', 'Port number', '4747')
  .option('--host <host>', 'Bind address (default: 127.0.0.1, use 0.0.0.0 for remote access)')
  .action(createLazyAction(() => import('./serve.js'), 'serveCommand'));

program
  .command('mcp')
  .description('Start MCP server (stdio) — serves all indexed repos')
  .action(createLazyAction(() => import('./mcp.js'), 'mcpCommand'));

program
  .command('list')
  .description('List all indexed repositories')
  .action(createLazyAction(() => import('./list.js'), 'listCommand'));

program
  .command('status')
  .description('Show index status for current repo')
  .action(createLazyAction(() => import('./status.js'), 'statusCommand'));

program
  .command('clean')
  .description('Delete GitNexus index for current repo')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--all', 'Clean all indexed repos')
  .option('-y, --yes', 'Skip interactive prompts')
  .action(createLazyAction(() => import('./clean.js'), 'cleanCommand'));

program
  .command('wiki [path]')
  .description('Generate repository wiki from knowledge graph')
  .option('-f, --force', 'Force full regeneration even if up to date')
  .option('--model <model>', 'LLM model name (default: minimax/minimax-m2.5)')
  .option('--base-url <url>', 'LLM API base URL (default: OpenAI)')
  .option('--api-key <key>', 'LLM API key (saved to ~/.gitnexus/config.json)')
  .option('--concurrency <n>', 'Parallel LLM calls (default: 3)', '3')
  .option('--gist', 'Publish wiki as a public GitHub Gist after generation')
  .option('-y, --yes', 'Skip interactive prompts, use defaults/flags')
  .action(createLazyAction(() => import('./wiki.js'), 'wikiCommand'));

program
  .command('augment <pattern>')
  .description('Augment a search pattern with knowledge graph context (used by hooks)')
  .action(createLazyAction(() => import('./augment.js'), 'augmentCommand'));

// ─── Direct Tool Commands (no MCP overhead) ────────────────────────
// These invoke LocalBackend directly for use in eval, scripts, and CI.

program
  .command('query [search_query]')
  .description('Search the knowledge graph for execution flows related to a concept')
  .option('-r, --repo <name>', 'Target repository (omit if only one indexed)')
  .option('-c, --context <text>', 'Task context to improve ranking')
  .option('-g, --goal <text>', 'What you want to find')
  .option('-l, --limit <n>', 'Max processes to return (default: 5)')
  .option('--content', 'Include full symbol source code')
  .action(createLazyAction(() => import('./tool.js'), 'queryCommand'));

program
  .command('context [name]')
  .description('360-degree view of a code symbol: callers, callees, processes')
  .option('-r, --repo <name>', 'Target repository')
  .option('-u, --uid <uid>', 'Direct symbol UID (zero-ambiguity lookup)')
  .option('-f, --file <path>', 'File path to disambiguate common names')
  .option('--content', 'Include full symbol source code')
  .action(createLazyAction(() => import('./tool.js'), 'contextCommand'));

program
  .command('impact [target]')
  .description('Blast radius analysis: what breaks if you change a symbol')
  .option('-d, --direction <dir>', 'upstream (dependants) or downstream (dependencies)', 'upstream')
  .option('-r, --repo <name>', 'Target repository')
  .option('--depth <n>', 'Max relationship depth (default: 3)')
  .option('--include-tests', 'Include test files in results')
  .action(createLazyAction(() => import('./tool.js'), 'impactCommand'));

program
  .command('cypher [query]')
  .description('Execute raw Cypher query against the knowledge graph')
  .option('-r, --repo <name>', 'Target repository')
  .action(createLazyAction(() => import('./tool.js'), 'cypherCommand'));

// ─── Eval Server (persistent daemon for SWE-bench) ─────────────────

program
  .command('eval-server')
  .description('Start lightweight HTTP server for fast tool calls during evaluation')
  .option('-p, --port <port>', 'Port number', '4848')
  .option('--idle-timeout <seconds>', 'Auto-shutdown after N seconds idle (0 = disabled)', '0')
  .action(createLazyAction(() => import('./eval-server.js'), 'evalServerCommand'));

program.parse(process.argv);
