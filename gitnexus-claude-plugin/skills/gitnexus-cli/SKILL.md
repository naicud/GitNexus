---
name: gitnexus-cli
description: "Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: \"Index this repo\", \"Reanalyze the codebase\", \"Generate a wiki\""
---

# GitNexus CLI Commands

All commands work via `npx` — no global install required.

## Commands

### analyze — Build or refresh the index

```bash
npx gitnexus analyze
```

Run from the project root. This parses all source files, builds the knowledge graph, writes it to `.gitnexus/`, and generates CLAUDE.md / AGENTS.md context files.

| Flag | Effect |
|------|--------|
| `--force` | Force full re-index even if up to date |
| `--embeddings` | Enable embedding generation for semantic search (off by default) |
| `--db <type>` | Database backend: `kuzu` (default) or `neptune` |
| `--neptune-endpoint <host>` | Neptune cluster endpoint hostname |
| `--neptune-region <region>` | AWS region (falls back to `AWS_REGION`) |
| `--neptune-port <port>` | Neptune HTTP port (default: 8182) |

**When to run:** First time in a project, after major code changes, or when `gitnexus://repo/{name}/context` reports the index is stale.

#### Neptune environment variables

Instead of CLI flags, you can set these env vars:

| Variable | Effect |
| -------- | ------ |
| `GITNEXUS_DB_TYPE` | `kuzu` (default) or `neptune` |
| `GITNEXUS_NEPTUNE_ENDPOINT` | Neptune cluster endpoint hostname |
| `GITNEXUS_NEPTUNE_REGION` | AWS region (falls back to `AWS_REGION`) |
| `GITNEXUS_NEPTUNE_PORT` | Neptune HTTP port (default: 8182) |

```bash
# Full Neptune example
npx gitnexus analyze --db neptune \
  --neptune-endpoint your-cluster.us-east-1.neptune.amazonaws.com \
  --neptune-region us-east-1
```

Neptune requires valid AWS credentials (env vars, instance profile, or SSO). See [Neptune setup guide](../docs/neptune-setup.md) for VPC, IAM, and security group configuration.

### status — Check index freshness

```bash
npx gitnexus status
```

Shows whether the current repo has a GitNexus index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
npx gitnexus clean
```

Deletes the `.gitnexus/` directory and unregisters the repo from the global registry. Use before re-indexing if the index is corrupt or after removing GitNexus from a project.

| Flag | Effect |
|------|--------|
| `--force` | Skip confirmation prompt |
| `--all` | Clean all indexed repos, not just the current one |

### wiki — Generate documentation from the graph

```bash
npx gitnexus wiki
```

Generates repository documentation from the knowledge graph using an LLM. Requires an API key (saved to `~/.gitnexus/config.json` on first use).

| Flag | Effect |
|------|--------|
| `--force` | Force full regeneration |
| `--model <model>` | LLM model (default: minimax/minimax-m2.5) |
| `--base-url <url>` | LLM API base URL |
| `--api-key <key>` | LLM API key |
| `--concurrency <n>` | Parallel LLM calls (default: 3) |
| `--gist` | Publish wiki as a public GitHub Gist |

### list — Show all indexed repos

```bash
npx gitnexus list
```

Lists all repositories registered in `~/.gitnexus/registry.json`. The MCP `list_repos` tool provides the same information.

## After Indexing

1. **Read `gitnexus://repo/{name}/context`** to verify the index loaded
2. Use the other GitNexus skills (`exploring`, `debugging`, `impact-analysis`, `refactoring`) for your task

## Troubleshooting

- **"Not inside a git repository"**: Run from a directory inside a git repo
- **Index is stale after re-analyzing**: Restart Claude Code to reload the MCP server
- **Embeddings slow**: Omit `--embeddings` (it's off by default) or set `OPENAI_API_KEY` for faster API-based embedding
- **"Neptune endpoint is required"**: Pass `--neptune-endpoint <host>` or set `GITNEXUS_NEPTUNE_ENDPOINT`
- **Neptune connection timeout**: Neptune requires VPC network access — use a VPN, VPC peering, or SSH tunnel. See [Neptune setup guide](../docs/neptune-setup.md)
