# Embeddings Guide

GitNexus supports semantic search via vector embeddings. When enabled, code symbols (functions, classes, methods, interfaces, files) are embedded into vectors and stored alongside the graph, enabling similarity-based search beyond keyword matching.

## Quick Start

```bash
# Local provider (default) — no API key needed
gitnexus analyze --embeddings

# Check it works
gitnexus mcp  # semantic search is now available in query results
```

## Providers

### Local (default)

Uses [transformers.js](https://huggingface.co/docs/transformers.js) with the `Snowflake/snowflake-arctic-embed-xs` model (22M parameters, 384 dimensions, ~90MB download).

```bash
gitnexus analyze --embeddings
```

- **GPU acceleration**: Automatically tries CUDA (Linux) or DirectML (Windows), falls back to CPU
- **First run**: Downloads the model (~90MB), cached for subsequent runs
- **No external dependencies**: Everything runs in-process

### Ollama

Uses [Ollama's](https://ollama.com) HTTP embedding API. Ollama must be running.

```bash
# Default endpoint is http://localhost:11434
gitnexus analyze --embeddings \
  --embed-provider ollama \
  --embed-model nomic-embed-text \
  --embed-dims 768

# Custom endpoint (remote Ollama server)
gitnexus analyze --embeddings \
  --embed-provider ollama \
  --embed-model nomic-embed-text \
  --embed-dims 768 \
  --embed-endpoint http://my-server:11434
```

Make sure the model is pulled first:
```bash
ollama pull nomic-embed-text
```

Common Ollama embedding models:

| Model | Dimensions |
|-------|-----------|
| `nomic-embed-text` | 768 |
| `mxbai-embed-large` | 1024 |
| `all-minilm` | 384 |
| `snowflake-arctic-embed` | 1024 |

### OpenAI

Works with OpenAI and any OpenAI-compatible API (LiteLLM, vLLM, Ollama `/v1`).

```bash
gitnexus analyze --embeddings \
  --embed-provider openai \
  --embed-model text-embedding-3-small \
  --embed-dims 1536 \
  --embed-api-key sk-xxx
```

The API key is read in this order:
1. `--embed-api-key` flag
2. `GITNEXUS_EMBED_API_KEY` environment variable
3. `OPENAI_API_KEY` environment variable

Default endpoint is `https://api.openai.com/v1`. Override with `--embed-endpoint` for proxies or compatible APIs:

```bash
# LiteLLM proxy
gitnexus analyze --embeddings \
  --embed-provider openai \
  --embed-model text-embedding-3-small \
  --embed-dims 1536 \
  --embed-endpoint http://localhost:4000/v1 \
  --embed-api-key sk-xxx
```

OpenAI embedding models:

| Model | Dimensions | Notes |
|-------|-----------|-------|
| `text-embedding-3-small` | 1536 | Cheapest, good quality |
| `text-embedding-3-large` | 3072 | Best quality |
| `text-embedding-ada-002` | 1536 | Legacy |

### Cohere

```bash
gitnexus analyze --embeddings \
  --embed-provider cohere \
  --embed-model embed-english-light-v3.0 \
  --embed-dims 384 \
  --embed-api-key xxx
```

The API key is read in this order:
1. `--embed-api-key` flag
2. `GITNEXUS_EMBED_API_KEY` environment variable
3. `COHERE_API_KEY` environment variable

Cohere embedding models:

| Model | Dimensions | Notes |
|-------|-----------|-------|
| `embed-english-light-v3.0` | 384 | Fast, English only |
| `embed-english-v3.0` | 1024 | Best English quality |
| `embed-multilingual-v3.0` | 1024 | Multilingual |
| `embed-multilingual-light-v3.0` | 384 | Fast, multilingual |

## CLI Flags Reference

| Flag | Environment Variable | Default | Description |
|------|---------------------|---------|-------------|
| `--embeddings` | — | off | Enable embedding generation |
| `--embed-provider <type>` | `GITNEXUS_EMBED_PROVIDER` | `local` | Provider: `local`, `ollama`, `openai`, `cohere` |
| `--embed-model <model>` | `GITNEXUS_EMBED_MODEL` | Per-provider default | Model name |
| `--embed-dims <n>` | `GITNEXUS_EMBED_DIMS` | `384` | Vector dimensions |
| `--embed-endpoint <url>` | `GITNEXUS_EMBED_ENDPOINT` | Per-provider default | API endpoint URL |
| `--embed-api-key <key>` | `GITNEXUS_EMBED_API_KEY` | — | API key |

Priority: CLI flags > environment variables > defaults.

## Environment Variables Example

```bash
# .env or shell profile
export GITNEXUS_EMBED_PROVIDER=ollama
export GITNEXUS_EMBED_MODEL=nomic-embed-text
export GITNEXUS_EMBED_DIMS=768
export GITNEXUS_EMBED_ENDPOINT=http://localhost:11434

# Then just:
gitnexus analyze --embeddings
```

## Embedding Caching

GitNexus caches embeddings across re-indexes. When you run `gitnexus analyze` again (without `--force`):

1. Existing embeddings are extracted from the current index
2. The graph is rebuilt
3. Cached embeddings are re-inserted for symbols that still exist
4. Only new/changed symbols need fresh embedding

This makes incremental re-indexing much faster. Use `--force` to regenerate all embeddings from scratch.

If you change the embedding provider or model, cached embeddings are automatically discarded and regenerated.

## What Gets Embedded

These node types are embedded for semantic search:

- **Function** — function/method bodies and signatures
- **Class** — class definitions
- **Method** — class method bodies
- **Interface** — interface definitions
- **File** — file-level summaries

Each node's embedding text includes its name, file path, and a code snippet (up to 500 characters).

## Limitations

- **Neptune**: Embeddings are not supported with the Neptune backend (v1). Use KuzuDB.
- **Large codebases**: Embedding generation adds time proportional to the number of embeddable symbols. The `local` provider processes ~16 symbols per batch on CPU.
- **Dimensions must match**: Setting `--embed-dims` to a value that doesn't match the model's actual output will produce incorrect results. Always check the model's documentation.
