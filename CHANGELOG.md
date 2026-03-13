# Changelog

All notable changes to GitNexus will be documented in this file.

## [1.3.13] - 2026-03-13

### Added

- **AWS Bedrock backend proxy**: Bedrock API calls now route through the local Express server (`/api/bedrock/converse`, `/api/bedrock/converse-stream`) to bypass browser CORS/COEP restrictions that blocked direct browser-to-AWS calls — @naicud
- **Bedrock health check**: "Test Connection" button in Settings validates credentials, region, and model access in one click — shows detailed error messages on failure — @naicud
- **Claude 4 model support**: Added `anthropic.claude-sonnet-4-20250514-v1:0` and `anthropic.claude-opus-4-20250514-v1:0` to the Bedrock model list — @naicud

### Changed

- **Bedrock dual-mode routing**: `ChatBedrockBrowser` supports both direct browser calls (standalone) and backend proxy (server-connected) — proxy is auto-selected when backend is available — @naicud

## [1.3.12] - 2026-03-12

### Added

- **COBOL language support**: Full indexing pipeline for GnuCOBOL codebases — PROGRAM-ID, paragraphs, sections, CALL/PERFORM/COPY edges extracted via regex-only processing (no tree-sitter) for reliable performance on large repos (#1) — @naicud
- **COBOL regex-only worker path**: Replaces tree-sitter-cobol entirely in both worker pool and sequential fallback to avoid external-scanner hangs on ~5% of files; sub-batch size auto-set to 200 for COBOL repos (#1) — @naicud
- **AWS Bedrock & custom OpenAI-compatible providers**: Embeddings and LLM calls can now target AWS Bedrock endpoints and any OpenAI-compatible API in addition to OpenAI
- **Enhanced `analyze` progress display**: Optional `--detail` flag surfaces per-file parse stats; removed the large-file skip logic from the filesystem walker so all files are considered for indexing
- **Web UI — model text input**: Settings panel model selector replaced with a free-text input, removing hard-coded dropdown options for improved flexibility

### Fixed

- **C/C++/C#/Rust language support**: Consolidated 6 overlapping PRs into unified `shared/utils.ts`; deduplicated `call-processor.ts`, `parse-worker.ts`, and `parsing-processor.ts`; fixed per-call `new Set()` allocation in `export-detection.ts`; added 72 tests (#237)
- **Swift parser availability**: Sequential ingestion now skips unavailable native Swift parsers gracefully and emits a warning in verbose mode (#188)
- **README**: Corrected backend and frontend directory paths in setup instructions

### Changed

- **CI — fork PR support**: PR report moved to `workflow_run` event and Claude Code Review workflow updated to handle fork-originated pull requests (#225, #222)
- **CI — security hardening**: Workflow permissions tightened and reliability improvements applied across CI/CD pipeline (#222)

## [1.3.11] - 2026-03-08

### Security

- Fix FTS Cypher injection by escaping backslashes in search queries (#209) — @magyargergo

### Added

- Auto-reindex hook that runs `gitnexus analyze` after commits and merges, with automatic embeddings preservation (#205) — @L1nusB
- 968 integration tests (up from ~840) covering unhappy paths across search, enrichment, CLI, pipeline, worker pool, and KuzuDB (#209) — @magyargergo
- Coverage auto-ratcheting so thresholds bump automatically on CI (#209) — @magyargergo
- Rich CI PR report with coverage bars, test counts, and threshold tracking (#209) — @magyargergo
- Modular CI workflow architecture with separate unit-test, integration-test, and orchestrator jobs (#209) — @magyargergo

### Fixed

- KuzuDB native addon crashes on Linux/macOS by running integration tests in isolated vitest processes with `--pool=forks` (#209) — @magyargergo
- Worker pool `MODULE_NOT_FOUND` crash when script path is invalid (#209) — @magyargergo

### Changed

- Added macOS to the cross-platform CI test matrix (#208) — @magyargergo

## [1.3.10] - 2026-03-07

### Security

- **MCP transport buffer cap**: Added 10 MB `MAX_BUFFER_SIZE` limit to prevent out-of-memory attacks via oversized `Content-Length` headers or unbounded newline-delimited input
- **Content-Length validation**: Reject `Content-Length` values exceeding the buffer cap before allocating memory
- **Stack overflow prevention**: Replaced recursive `readNewlineMessage` with iterative loop to prevent stack overflow from consecutive empty lines
- **Ambiguous prefix hardening**: Tightened `looksLikeContentLength` to require 14+ bytes before matching, preventing false framing detection on short input
- **Closed transport guard**: `send()` now rejects with a clear error when called after `close()`, with proper write-error propagation

### Added

- **Dual-framing MCP transport** (`CompatibleStdioServerTransport`): Auto-detects Content-Length (Codex/OpenCode) and newline-delimited JSON (Cursor/Claude Code) framing on the first message, responds in the same format (#207)
- **Lazy CLI module loading**: All CLI subcommands now use `createLazyAction()` to defer heavy imports (tree-sitter, ONNX, KuzuDB) until invocation, significantly improving `gitnexus mcp` startup time (#207)
- **Type-safe lazy actions**: `createLazyAction` uses constrained generics to validate export names against module types at compile time
- **Regression test suite**: 13 unit tests covering transport framing, security hardening, buffer limits, and lazy action loading

### Fixed

- **CALLS edge sourceId alignment**: `findEnclosingFunctionId` now generates IDs with `:startLine` suffix matching node creation format, fixing process detector finding 0 entry points (#194)
- **LRU cache zero maxSize crash**: Guard `createASTCache` against `maxSize=0` when repos have no parseable files (#144)

### Changed

- Transport constructor accepts `NodeJS.ReadableStream` / `NodeJS.WritableStream` (widened from concrete `ReadStream`/`WriteStream`)
- `processReadBuffer` simplified to break on first error instead of stale-buffer retry loop

## [1.3.9] - 2026-03-06

### Fixed

- Aligned CALLS edge sourceId with node ID format in parse worker (#194)

## [1.3.8] - 2026-03-05

### Fixed

- Force-exit after analyze to prevent KuzuDB native cleanup hang (#192)
