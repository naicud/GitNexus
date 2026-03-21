# GitNexus

**Graph-powered code intelligence for AI agents.** Index any codebase into a knowledge graph, then query it via MCP or CLI.

Works with **Cursor**, **Claude Code**, **Codex**, **Windsurf**, **Cline**, **OpenCode**, and any MCP-compatible tool.

[![npm version](https://img.shields.io/npm/v/gitnexus.svg)](https://www.npmjs.com/package/gitnexus)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](https://polyformproject.org/licenses/noncommercial/1.0.0/)

---

## Why?

AI coding tools don't understand your codebase structure. They edit a function without knowing 47 other functions depend on it. GitNexus fixes this by **precomputing every dependency, call chain, and relationship** into a queryable graph.

**Three commands to give your AI agent full codebase awareness.**

## Quick Start

```bash
# Index your repo (run from repo root)
npx gitnexus analyze
```

That's it. This indexes the codebase, installs agent skills, registers Claude Code hooks, and creates `AGENTS.md` / `CLAUDE.md` context files — all in one command.

To configure MCP for your editor, run `npx gitnexus setup` once — or set it up manually below.

`gitnexus setup` auto-detects your editors and writes the correct global MCP config. You only need to run it once.

### Editor Support

| Editor | MCP | Skills | Hooks (auto-augment) | Support |
|--------|-----|--------|---------------------|---------|
| **Claude Code** | Yes | Yes | Yes (PreToolUse) | **Full** |
| **Cursor** | Yes | Yes | — | MCP + Skills |
| **Codex** | Yes | Yes | — | MCP + Skills |
| **Windsurf** | Yes | — | — | MCP |
| **OpenCode** | Yes | Yes | — | MCP + Skills |

> **Claude Code** gets the deepest integration: MCP tools + agent skills + PreToolUse hooks that automatically enrich grep/glob/bash calls with knowledge graph context.

### Community Integrations

| Agent | Install | Source |
|-------|---------|--------|
| [pi](https://pi.dev) | `pi install npm:pi-gitnexus` | [pi-gitnexus](https://github.com/tintinweb/pi-gitnexus) |

## MCP Setup (manual)

If you prefer to configure manually instead of using `gitnexus setup`:

### Claude Code (full support — MCP + skills + hooks)

```bash
claude mcp add gitnexus -- npx -y gitnexus@latest mcp
```

### Codex (full support — MCP + skills)

```bash
codex mcp add gitnexus -- npx -y gitnexus@latest mcp
```

### Cursor / Windsurf

Add to `~/.cursor/mcp.json` (global — works for all projects):

```json
{
  "mcpServers": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus@latest", "mcp"]
    }
  }
}
```

### OpenCode

Add to `~/.config/opencode/config.json`:

```json
{
  "mcp": {
    "gitnexus": {
      "command": "npx",
      "args": ["-y", "gitnexus@latest", "mcp"]
    }
  }
}
```

## How It Works

GitNexus builds a complete knowledge graph of your codebase through a multi-phase indexing pipeline:

1. **Structure** — Walks the file tree and maps folder/file relationships
2. **Parsing** — Extracts functions, classes, methods, and interfaces using Tree-sitter ASTs
3. **Resolution** — Resolves imports and function calls across files with language-aware logic
4. **Clustering** — Groups related symbols into functional communities
5. **Processes** — Traces execution flows from entry points through call chains
6. **Search** — Builds hybrid search indexes for fast retrieval

The result is a **LadybugDB graph database** stored locally in `.gitnexus/` with full-text search and semantic embeddings. Alternatively, you can use [AWS Neptune](#database-backends) as a managed cloud backend.

## Database Backends

| | LadybugDB (default) | AWS Neptune |
|---|---|---|
| **Storage** | Local `.gitnexus/` directory | Managed AWS cluster |
| **Setup** | Zero config | VPC, IAM, cluster provisioning |
| **Full-text search** | BM25 indexes | CONTAINS predicate (no FTS indexes) |
| **Semantic search** | Embeddings supported | Not supported (v1) |
| **Multi-repo** | Automatic via registry | One cluster per repo (v1) |
| **Cost** | Free | AWS Neptune pricing |

LadybugDB is the default and recommended for most users. Neptune is for teams that need a managed, always-on graph database in AWS.

```bash
# Index with Neptune backend
gitnexus analyze --db neptune \
  --neptune-endpoint your-cluster.us-east-1.neptune.amazonaws.com \
  --neptune-region us-east-1
```

Or use environment variables: `GITNEXUS_DB_TYPE=neptune`, `GITNEXUS_NEPTUNE_ENDPOINT`, `GITNEXUS_NEPTUNE_REGION`.

See [Neptune setup guide](../docs/neptune-setup.md) for full AWS configuration (VPC, IAM, security groups, SSH tunneling).

## Semantic Search (Embeddings)

By default, GitNexus uses BM25 full-text search. Add `--embeddings` to generate vector embeddings for semantic search — finds conceptually similar code, not just keyword matches.

```bash
gitnexus analyze --embeddings
```

### Embedding Providers

| Provider | Model (default) | Dims | Requires |
|----------|----------------|------|----------|
| `local` | `snowflake-arctic-embed-xs` | 384 | Nothing (runs locally via transformers.js) |
| `ollama` | `nomic-embed-text` | 768 | Ollama running locally or remotely |
| `openai` | `text-embedding-3-small` | 1536 | API key |
| `cohere` | `embed-english-light-v3.0` | 384 | API key |

### Configuration

CLI flags take priority over environment variables, which take priority over defaults.

```bash
# Local (default) — zero config, ~90MB model download on first run
gitnexus analyze --embeddings

# Ollama
gitnexus analyze --embeddings \
  --embed-provider ollama \
  --embed-model nomic-embed-text \
  --embed-dims 768

# OpenAI
gitnexus analyze --embeddings \
  --embed-provider openai \
  --embed-model text-embedding-3-small \
  --embed-dims 1536 \
  --embed-api-key sk-xxx

# Cohere
gitnexus analyze --embeddings \
  --embed-provider cohere \
  --embed-model embed-english-light-v3.0 \
  --embed-dims 384 \
  --embed-api-key xxx
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GITNEXUS_EMBED_PROVIDER` | Provider type: `local`, `ollama`, `openai`, `cohere` |
| `GITNEXUS_EMBED_MODEL` | Model name |
| `GITNEXUS_EMBED_DIMS` | Vector dimensions (must match the model) |
| `GITNEXUS_EMBED_ENDPOINT` | API endpoint URL (override default) |
| `GITNEXUS_EMBED_API_KEY` | API key (also reads `OPENAI_API_KEY` / `COHERE_API_KEY`) |

See the [embeddings guide](../docs/embeddings.md) for detailed provider setup, GPU acceleration, and troubleshooting.

> **Note:** Neptune does not support embeddings in v1. Embeddings are stored in LadybugDB only.

## MCP Tools

Your AI agent gets these tools automatically:

| Tool | What It Does | `repo` Param |
|------|-------------|--------------|
| `list_repos` | Discover all indexed repositories | — |
| `query` | Process-grouped hybrid search (BM25 + semantic + RRF) | Optional |
| `context` | 360-degree symbol view — categorized refs, process participation | Optional |
| `impact` | Blast radius analysis with depth grouping and confidence | Optional |
| `detect_changes` | Git-diff impact — maps changed lines to affected processes | Optional |
| `rename` | Multi-file coordinated rename with graph + text search | Optional |
| `cypher` | Raw Cypher graph queries | Optional |

> With one indexed repo, the `repo` param is optional. With multiple, specify which: `query({query: "auth", repo: "my-app"})`.

## MCP Resources

| Resource | Purpose |
|----------|---------|
| `gitnexus://repos` | List all indexed repositories (read first) |
| `gitnexus://repo/{name}/context` | Codebase stats, staleness check, and available tools |
| `gitnexus://repo/{name}/clusters` | All functional clusters with cohesion scores |
| `gitnexus://repo/{name}/cluster/{name}` | Cluster members and details |
| `gitnexus://repo/{name}/processes` | All execution flows |
| `gitnexus://repo/{name}/process/{name}` | Full process trace with steps |
| `gitnexus://repo/{name}/schema` | Graph schema for Cypher queries |

## MCP Prompts

| Prompt | What It Does |
|--------|-------------|
| `detect_impact` | Pre-commit change analysis — scope, affected processes, risk level |
| `generate_map` | Architecture documentation from the knowledge graph with mermaid diagrams |

## CLI Commands

```bash
gitnexus setup                    # Configure MCP for your editors (one-time)
gitnexus analyze [path]           # Index a repository (or update stale index)
gitnexus analyze --force          # Force full re-index
gitnexus analyze --embeddings     # Enable embedding generation (slower, better search)
gitnexus analyze --embeddings \   # Use a specific embedding provider
  --embed-provider ollama \       #   ollama | openai | cohere | local
  --embed-model nomic-embed-text \#   Model name
  --embed-dims 768                #   Vector dimensions (must match model)
gitnexus analyze --verbose        # Log skipped files when parsers are unavailable
gitnexus analyze --db neptune \   # Use AWS Neptune backend
  --neptune-endpoint <host> \     # Neptune cluster endpoint
  --neptune-region <region>       # AWS region
gitnexus mcp                     # Start MCP server (stdio) — serves all indexed repos
gitnexus serve                   # Start local HTTP server (multi-repo) for web UI
gitnexus list                    # List all indexed repositories
gitnexus status                  # Show index status for current repo
gitnexus clean                   # Delete index for current repo
gitnexus clean --all --force     # Delete all indexes
gitnexus wiki [path]             # Generate LLM-powered docs from knowledge graph
gitnexus wiki --model <model>    # Wiki with custom LLM model (default: gpt-4o-mini)
```

## Multi-Repo Support

GitNexus supports indexing multiple repositories. Each `gitnexus analyze` registers the repo in a global registry (`~/.gitnexus/registry.json`). The MCP server serves all indexed repos automatically.

> **Neptune:** v1 supports one cluster per repository. Multi-repo requires separate Neptune clusters.

## Supported Languages

TypeScript, JavaScript, Python, Java, C, C++, C#, Go, Rust, PHP, Kotlin, Swift, Ruby

### Language Feature Matrix

| Language | Imports | Types | Exports | Named Bindings | Config | Frameworks | Entry Points | Heritage |
|----------|---------|-------|---------|----------------|--------|------------|-------------|----------|
| TypeScript | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| JavaScript | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Python | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| C# | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Java | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| Kotlin | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| Go | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| Rust | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| PHP | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Swift | — | ✓ | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| Ruby | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | ✓ |
| C | — | ✓ | ✓ | — | — | ✓ | ✓ | ✓ |
| C++ | — | ✓ | ✓ | — | — | ✓ | ✓ | ✓ |

**Imports** — cross-file import resolution · **Types** — type annotation extraction · **Exports** — public/exported symbol detection · **Named Bindings** — `import { X }` tracking · **Config** — language toolchain config parsing (tsconfig, go.mod, etc.) · **Frameworks** — AST-based framework pattern detection · **Entry Points** — entry point scoring heuristics · **Heritage** — class inheritance / interface implementation

## Agent Skills

GitNexus ships with skill files that teach AI agents how to use the tools effectively:

- **Exploring** — Navigate unfamiliar code using the knowledge graph
- **Debugging** — Trace bugs through call chains
- **Impact Analysis** — Analyze blast radius before changes
- **Refactoring** — Plan safe refactors using dependency mapping

Installed automatically by both `gitnexus analyze` (per-repo) and `gitnexus setup` (global).

## Requirements

- Node.js >= 18
- Git repository (uses git for commit tracking)

## Privacy

- **LadybugDB (default):** All processing happens locally on your machine. No code is sent to any server.
- **Neptune:** Code metadata (symbol names, file paths, relationships) is sent to your AWS Neptune cluster. Source code content is not stored in the graph.
- Index stored in `.gitnexus/` inside your repo (gitignored)
- Global registry at `~/.gitnexus/` stores only paths and metadata

## Web UI

GitNexus also has a browser-based UI at [gitnexus.vercel.app](https://gitnexus.vercel.app) — 100% client-side, your code never leaves the browser.

**Local Backend Mode:** Run `gitnexus serve` and open the web UI locally — it auto-detects the server and shows all your indexed repos, with full AI chat support. No need to re-upload or re-index. The agent's tools (Cypher queries, search, code navigation) route through the backend HTTP API automatically.

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)

Free for non-commercial use. Contact for commercial licensing.
