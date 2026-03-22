# Upstream Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `upstream/main` (51 commits) into our `main` branch, absorbing Phase 14 cross-file binding, markdown indexing, MiniMax LLM, worker hydration, and language dispatch refactor — without breaking Neptune, COBOL, perfection-loop skill, LOD/DataExplorer, or Bedrock/Custom providers.

**Architecture:** `git merge upstream/main` directly on `main` — same pattern as previous syncs. Conflict resolution is pre-analyzed: 11 files have markers, 2 hidden new files need patching. All our 55 exclusive commits survive intact.

**Tech Stack:** TypeScript, Node.js, React/Vite, tree-sitter, KuzuDB (LadybugDB), AWS Neptune, COBOL regex extraction

**Spec:** `docs/superpowers/specs/2026-03-22-main-upstream-sync-design.md`

---

## File Map

### Modified (conflict resolution)
- `gitnexus/src/core/graph/types.ts` — add `Section` NodeLabel + `level` property alongside our COBOL types
- `gitnexus/src/cli/index.ts` — add "Codex" to setup description alongside our Neptune opts
- `gitnexus-web/src/core/llm/types.ts` — add `minimax` provider (9-type union total)
- `gitnexus-web/src/core/llm/agent.ts` — add `minimax` case alongside `custom`+`bedrock`
- `gitnexus-web/src/core/llm/settings-service.ts` — add `minimax` settings alongside ours
- `gitnexus-web/src/components/SettingsPanel.tsx` — add MiniMax UI alongside Neptune section
- `gitnexus/src/core/ingestion/pipeline.ts` — absorb Phase 14 (topo sort, cross-file loop, markdown) + keep COBOL expansion
- `gitnexus/src/core/ingestion/parsing-processor.ts` — add `typeEnvBindings`, replace inline label chain with `getLabelFromCaptures(captureMap, language)`
- `gitnexus/src/core/ingestion/import-processor.ts` — adopt upstream dispatch refactor, rename `suffixIndex`→`index`
- `gitnexus-web/src/hooks/useAppState.tsx` — keep ours (split hooks), add `hydrateWorkerFromServer` to interface
- `gitnexus-web/src/App.tsx` — keep ours (LOD/smartConnect), add `hydrateWorkerFromServer` + `setProgress(null)` to `handleServerConnect`

### Modified (new code, no conflict marker)
- `gitnexus/src/core/ingestion/import-resolution.ts` — NEW file from upstream; add `resolveCobolPath` + COBOL entries to both dispatch tables
- `gitnexus-web/src/hooks/useWorkerState.ts` — add `hydrateWorkerFromServer` callback + export

### Auto-merged (verify only)
- `gitnexus-web/src/workers/ingestion.worker.ts` — must have both `generateCypherQuery` (ours) AND `hydrateFromServerData` (upstream)
- `gitnexus/src/core/ingestion/utils.ts` — must have `export * from './ast-helpers.js'`
- `gitnexus/src/core/ingestion/ast-helpers.ts` — new file from upstream with 2-arg `getLabelFromCaptures`

---

## Task 1: Safety Net + Merge Initiation

**Files:** none modified — git state only

- [ ] **Step 1.1: Create backup branch**

```bash
cd /Users/danielnicusornaicu/private/GitNexus
git branch backup-before-upstream-sync-v3
git log --oneline -1  # confirm we're on main at the right commit
```

Expected: branch created, HEAD shows `a016806` or similar recent commit on our main.

- [ ] **Step 1.2: Confirm upstream is fetched**

```bash
git log --oneline upstream/main -3
```

Expected: shows recent upstream commits including `92a1086 Merge pull request #300 from jim80net/fix/onnxruntime-cuda-provider`.

- [ ] **Step 1.3: Run the merge**

```bash
git merge upstream/main
```

Expected: merge stops with conflict notice. Output will list ~11 files with `CONFLICT (content)`. A number of files will say `Auto-merging` — that is expected and fine.

- [ ] **Step 1.4: Verify conflict list matches spec**

```bash
git diff --name-only --diff-filter=U
```

Expected output (exact 11 files):
```
gitnexus-web/src/App.tsx
gitnexus-web/src/components/SettingsPanel.tsx
gitnexus-web/src/core/llm/agent.ts
gitnexus-web/src/core/llm/settings-service.ts
gitnexus-web/src/core/llm/types.ts
gitnexus-web/src/hooks/useAppState.tsx
gitnexus/src/cli/index.ts
gitnexus/src/core/graph/types.ts
gitnexus/src/core/ingestion/import-processor.ts
gitnexus/src/core/ingestion/parsing-processor.ts
gitnexus/src/core/ingestion/pipeline.ts
```

If you see additional files not in this list, stop and read their conflict carefully before proceeding.

---

## Task 2: Verify Auto-Merged Files

**Files:** read-only verification, no edits in this task

- [ ] **Step 2.1: Verify ingestion.worker.ts has both methods**

```bash
grep -n "generateCypherQuery\|hydrateFromServerData" \
  gitnexus-web/src/workers/ingestion.worker.ts
```

Expected: both method names appear. If only one appears, the merge went wrong — open the file and manually add the missing method body from `git show upstream/main:gitnexus-web/src/workers/ingestion.worker.ts`.

- [ ] **Step 2.2: Verify ast-helpers.ts arrived**

```bash
ls gitnexus/src/core/ingestion/ast-helpers.ts
grep -n "getLabelFromCaptures" gitnexus/src/core/ingestion/ast-helpers.ts | head -3
```

Expected: file exists, `getLabelFromCaptures` found with 2-arg signature `(captureMap, language)`.

- [ ] **Step 2.3: Verify utils.ts re-exports ast-helpers**

```bash
grep "ast-helpers" gitnexus/src/core/ingestion/utils.ts
```

Expected: `export * from './ast-helpers.js';`

- [ ] **Step 2.4: Verify import-resolution.ts arrived**

```bash
ls gitnexus/src/core/ingestion/import-resolution.ts
grep -n "satisfies Record" gitnexus/src/core/ingestion/import-resolution.ts
```

Expected: file exists, shows two `satisfies Record<SupportedLanguages, ...>` lines. This file WILL cause a build error until Task 7 patches it.

---

## Task 3: Low-Complexity Conflicts (5 files)

**Files:** 5 conflict files — all additive, different sections

### 3a: `gitnexus/src/core/graph/types.ts`

- [ ] **Step 3a.1: Resolve — keep both new NodeLabel entries**

Open `gitnexus/src/core/graph/types.ts`. Find the conflict marker around the `NodeLabel` type and `RelationshipType`. The conflict looks like:

```
<<<<<<< HEAD
  | 'Template'
  // Frontend-only (not stored in LadybugDB)
  | 'ClusterGroup';
=======
  | 'Template'
  | 'Section';
>>>>>>> upstream/main
```

Resolution — keep both:
```typescript
  | 'Template'
  | 'Section'
  // Frontend-only (not stored in LadybugDB)
  | 'ClusterGroup';
```

For the `NodeProperties` conflict (upstream adds `level?: number`), keep both by adding `level` alongside our properties:
```typescript
  parameterCount?: number,
  // Section-specific (markdown heading level, 1-6)
  level?: number,
  returnType?: string,
```

For the `RelationshipType` conflict (upstream adds nothing here; we added COBOL types), the resolution is to keep our COBOL types and verify no upstream marker exists there.

- [ ] **Step 3a.2: Confirm no remaining markers**

```bash
grep -n "<<<<<<\|>>>>>>>\|=======" gitnexus/src/core/graph/types.ts
```

Expected: no output.

- [ ] **Step 3a.3: Stage the file**

```bash
git add gitnexus/src/core/graph/types.ts
```

### 3b: `gitnexus/src/cli/index.ts`

- [ ] **Step 3b.1: Resolve — keep both description text and our Neptune/embed additions**

Find the conflict in `gitnexus/src/cli/index.ts`. Upstream only changed the setup description text. Accept upstream's description text (`'One-time setup: configure MCP for Cursor, Claude Code, OpenCode, Codex'`) and keep our Neptune options and `embed` command block exactly as-is.

```bash
grep -n "<<<<<<\|>>>>>>>\|=======" gitnexus/src/cli/index.ts
```

After resolving, the setup command should read:
```typescript
program
  .command('setup')
  .description('One-time setup: configure MCP for Cursor, Claude Code, OpenCode, Codex')
  .option('-y, --yes', 'Skip interactive prompts')
  .action(createLazyAction(() => import('./setup.js'), 'setupCommand'));
```

- [ ] **Step 3b.2: Stage**

```bash
git add gitnexus/src/cli/index.ts
```

### 3c: `gitnexus-web/src/core/llm/types.ts`

- [ ] **Step 3c.1: Resolve — 9-type union, all 3 new config interfaces**

The conflict is on the `LLMProvider` type line. Resolution:
```typescript
export type LLMProvider = 'openai' | 'azure-openai' | 'gemini' | 'anthropic' | 'ollama' | 'openrouter' | 'minimax' | 'custom' | 'bedrock';
```

Keep upstream's `MiniMaxConfig` interface AND our `CustomConfig` and `AWSBedrockConfig` interfaces.

The `ProviderConfig` union becomes:
```typescript
export type ProviderConfig = OpenAIConfig | AzureOpenAIConfig | GeminiConfig | AnthropicConfig | OllamaConfig | OpenRouterConfig | MiniMaxConfig | CustomConfig | AWSBedrockConfig;
```

The `LLMSettings` interface must include all three optional provider configs (`minimax?`, `custom?`, `bedrock?`). Keep all.

- [ ] **Step 3c.2: Confirm no markers, stage**

```bash
grep -n "<<<<<<\|>>>>>>>\|=======" gitnexus-web/src/core/llm/types.ts
git add gitnexus-web/src/core/llm/types.ts
```

### 3d: `gitnexus-web/src/core/llm/agent.ts`

- [ ] **Step 3d.1: Resolve — keep all 3 new switch cases**

Keep upstream's `minimax` case AND our `custom` and `bedrock` cases in the `createChatModel` switch. Keep our `ChatBedrockBrowser` import. Keep upstream's `MiniMaxConfig` import.

The import block should include:
```typescript
import type { ProviderConfig, AzureOpenAIConfig, CustomConfig, AWSBedrockConfig, MiniMaxConfig } from './types';
```

- [ ] **Step 3d.2: Confirm no markers, stage**

```bash
grep -n "<<<<<<\|>>>>>>>\|=======" gitnexus-web/src/core/llm/agent.ts
git add gitnexus-web/src/core/llm/agent.ts
```

### 3e: `gitnexus-web/src/core/llm/settings-service.ts`

- [ ] **Step 3e.1: Resolve — keep all 3 provider settings**

Keep upstream's `minimax` settings block AND our `custom` and `bedrock` settings blocks. The merged `DEFAULT_LLM_SETTINGS` should include defaults for all three. The `updateProviderSettings` switch should include all three cases.

- [ ] **Step 3e.2: Confirm no markers, stage**

```bash
grep -n "<<<<<<\|>>>>>>>\|=======" gitnexus-web/src/core/llm/settings-service.ts
git add gitnexus-web/src/core/llm/settings-service.ts
```

---

## Task 4: Medium — SettingsPanel.tsx

**Files:** `gitnexus-web/src/components/SettingsPanel.tsx`

- [ ] **Step 4.1: Resolve providers array and icon map**

Find the conflict on the `providers` array line. Set it to:
```typescript
const providers: LLMProvider[] = ['openai', 'gemini', 'anthropic', 'azure-openai', 'ollama', 'openrouter', 'minimax', 'custom', 'bedrock'];
```

For the icon map ternary chain, add `minimax` before our `custom`/`bedrock` entries:
```typescript
{provider === 'openai' ? '🤖' : provider === 'gemini' ? '💎' : provider === 'anthropic' ? '🧠' : provider === 'ollama' ? '🦙' : provider === 'openrouter' ? '🌐' : provider === 'minimax' ? '⚡' : provider === 'custom' ? '🔧' : provider === 'bedrock' ? '☁️' : '☁️'}
```

- [ ] **Step 4.2: Resolve MiniMax settings section**

Find the conflict block for the MiniMax settings section. Keep upstream's MiniMax settings UI block (the `{settings.activeProvider === 'minimax' && (...)}`  section). Place it near the existing provider sections (before our Bedrock section is fine). Do NOT remove our Neptune DB section or CypherConsole.

- [ ] **Step 4.3: Confirm no markers, stage**

```bash
grep -n "<<<<<<\|>>>>>>>\|=======" gitnexus-web/src/components/SettingsPanel.tsx
git add gitnexus-web/src/components/SettingsPanel.tsx
```

---

## Task 5: Medium — pipeline.ts (Phase 14 + COBOL)

**Files:** `gitnexus/src/core/ingestion/pipeline.ts`

This is the most content-heavy merge. Work section by section.

- [ ] **Step 5.1: Resolve the import block**

Find the conflict marker in the imports at the top. The resolved imports block must include ALL of the following (merge both sides):

```typescript
import { createKnowledgeGraph } from '../graph/graph.js';
import { processStructure } from './structure-processor.js';
import { processMarkdown } from './markdown-processor.js';
import { processParsing } from './parsing-processor.js';
import {
  processImports,
  processImportsFromExtracted,
  buildImportResolutionContext
} from './import-processor.js';
import { EMPTY_INDEX } from './resolvers/index.js';
import { processCalls, processCallsFromExtracted, processAssignmentsFromExtracted, processRoutesFromExtracted, seedCrossFileReceiverTypes, buildImportedReturnTypes, buildImportedRawReturnTypes, type ExportedTypeMap, buildExportedTypeMapFromGraph } from './call-processor.js';
import { processHeritage, processHeritageFromExtracted } from './heritage-processor.js';
import { computeMRO } from './mro-processor.js';
import { processCommunities } from './community-processor.js';
import { createResolutionContext } from './resolution-context.js';
import { createASTCache } from './ast-cache.js';
import { PipelineProgress, PipelineResult } from '../../types/pipeline.js';
import { walkRepositoryPaths, readFileContents } from './filesystem-walker.js';
import { getLanguageFromFilename, getLanguageFromPath } from './utils.js';
import { isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { createWorkerPool, WorkerPool } from './workers/worker-pool.js';
import { expandCopies, DEFAULT_MAX_DEPTH } from './cobol-copy-expander.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { KnowledgeGraph } from '../graph/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
```

- [ ] **Step 5.2: Resolve the `isDev` line**

Keep our version (includes VERBOSE):
```typescript
const isDev = process.env.NODE_ENV === 'development' || !!process.env.GITNEXUS_VERBOSE;
```

- [ ] **Step 5.3: Resolve the block after `isDev` — keep both `topologicalLevelSort` and our COBOL constants**

From upstream, after `isDev`, insert `topologicalLevelSort` (~60-line function) + `CROSS_FILE_SKIP_THRESHOLD` + `MAX_CROSS_FILE_REPROCESS`. Then keep our COBOL constants (`COPYBOOK_EXTENSIONS`, `COBOL_PROGRAM_EXTENSIONS`) and helper functions (`isCobolCopybook`, `getCopybookName`, `expandCobolCopies`).

Order:
1. `topologicalLevelSort` (from upstream)
2. `CHUNK_BYTE_BUDGET` + `AST_CACHE_CAP` constants
3. `CROSS_FILE_SKIP_THRESHOLD` + `MAX_CROSS_FILE_REPROCESS` (from upstream)
4. Our COBOL constants + helpers

- [ ] **Step 5.4: Resolve `synthesizeWildcardImportBindings`**

Keep upstream's `synthesizeWildcardImportBindings` function in full. It goes after our COBOL helpers, before the main pipeline function.

- [ ] **Step 5.5: Resolve the main pipeline function body**

Inside the main `runPipeline` / `analyzeRepository` function:

a) Keep our COBOL copy expansion block intact (the section that calls `expandCobolCopies`)

b) Add `typeEnvBindings` accumulation across chunks (after each chunk result is processed):
```typescript
workerTypeEnvBindings.push(...(chunkWorkerData.typeEnvBindings ?? []));
```

c) Add `processMarkdown` invocation in the md-files section (from upstream)

d) After the existing `processCalls` block, add the cross-file re-resolution loop from upstream (calls `seedCrossFileReceiverTypes`, `buildImportedReturnTypes`, `buildImportedRawReturnTypes`, the topological pass, etc.)

e) Replace manual memory-release with upstream's approach:
```typescript
importCtx.index = EMPTY_INDEX; // Release suffix index memory (~30MB for large repos)
```

- [ ] **Step 5.6: Confirm no markers**

```bash
grep -n "<<<<<<\|>>>>>>>\|=======" gitnexus/src/core/ingestion/pipeline.ts
```

Expected: no output.

- [ ] **Step 5.7: Stage**

```bash
git add gitnexus/src/core/ingestion/pipeline.ts
```

---

## Task 6: High — parsing-processor.ts

**Files:** `gitnexus/src/core/ingestion/parsing-processor.ts`

- [ ] **Step 6.1: Resolve the imports block**

The merged imports must include ALL of the following:

```typescript
import { getLanguageFromFilename, getLanguageFromPath, yieldToEventLoop, getDefinitionNodeFromCaptures, findEnclosingClassId, extractMethodSignature, isBuiltInOrNoise, getLabelFromCaptures } from './utils.js';
```

Keep `SupportedLanguages` import (upstream removes it — we need it for COBOL):
```typescript
import { SupportedLanguages } from '../../config/supported-languages.js';
```

Add `FileTypeEnvBindings` to the parse-worker import:
```typescript
import type { ParseWorkerResult, ParseWorkerInput, ExtractedImport, ExtractedCall, ExtractedAssignment, ExtractedHeritage, ExtractedRoute, FileConstructorBindings, FileTypeEnvBindings } from './workers/parse-worker.js';
```

- [ ] **Step 6.2: Update `WorkerExtractedData` interface**

Add `typeEnvBindings` field:
```typescript
export interface WorkerExtractedData {
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  assignments: ExtractedAssignment[];
  heritage: ExtractedHeritage[];
  routes: ExtractedRoute[];
  constructorBindings: FileConstructorBindings[];
  typeEnvBindings: FileTypeEnvBindings[];
  /** True when data came from the sequential fallback (only COBOL data present) */
  sequentialFallback?: boolean;
}
```

- [ ] **Step 6.3: Remove `isNodeExported` re-export**

Delete this block (upstream removes it — the export lives directly in `export-detection.js`):
```typescript
// isNodeExported imported from ./export-detection.js (shared module)
// Re-export for backward compatibility with any external consumers
export { isNodeExported } from './export-detection.js';
```

- [ ] **Step 6.4: Update `processParsingWithWorkers` return statements**

Add `typeEnvBindings: []` to the early-return and accumulate from worker results:
```typescript
if (parseableFiles.length === 0) return { imports: [], calls: [], assignments: [], heritage: [], routes: [], constructorBindings: [], typeEnvBindings: [] };
```

And in the result accumulation loop:
```typescript
const allTypeEnvBindings: FileTypeEnvBindings[] = [];
// ... inside loop:
allTypeEnvBindings.push(...result.typeEnvBindings);
// ... final return:
return { imports: allImports, calls: allCalls, assignments: allAssignments, heritage: allHeritage, routes: allRoutes, constructorBindings: allConstructorBindings, typeEnvBindings: allTypeEnvBindings };
```

Also add `requiredParameterCount` and `parameterTypes` to symbol table adds:
```typescript
symbolTable.add(sym.filePath, sym.name, sym.nodeId, sym.type, {
  parameterCount: sym.parameterCount,
  requiredParameterCount: sym.requiredParameterCount,
  parameterTypes: sym.parameterTypes,
  returnType: sym.returnType,
  ...
});
```

- [ ] **Step 6.5: Replace inline label-detection chain in `processParsingSequential`**

In the sequential fallback (for non-COBOL files), find the inline `if/else` label-detection block that builds `nodeLabel` from `captureMap`. Replace it with:
```typescript
const nodeLabel = getLabelFromCaptures(captureMap, language);
```

The upstream 2-arg `getLabelFromCaptures` in `ast-helpers.ts` handles all the same cases including the C/C++ dedup guard — you do NOT need the old inline chain anymore.

- [ ] **Step 6.6: Update COBOL sequential path return**

The COBOL sequential fallback return (at end of `processParsingSequential`) must include `typeEnvBindings`:
```typescript
return { imports: cobolImports, calls: cobolCalls, assignments: cobolAssignments, heritage: [], routes: [], constructorBindings: [], typeEnvBindings: [], sequentialFallback: true };
```

Also update the `null` return at the bottom:
```typescript
// If reached: no COBOL data, no sequential data — return null or empty
return null;
```

- [ ] **Step 6.7: Confirm no markers, stage**

```bash
grep -n "<<<<<<\|>>>>>>>\|=======" gitnexus/src/core/ingestion/parsing-processor.ts
git add gitnexus/src/core/ingestion/parsing-processor.ts
```

---

## Task 7: High — import-processor.ts + import-resolution.ts

**Files:**
- `gitnexus/src/core/ingestion/import-processor.ts` (conflict file)
- `gitnexus/src/core/ingestion/import-resolution.ts` (new file from upstream, no conflict marker)

### 7a: Resolve `import-processor.ts`

- [ ] **Step 7a.1: Resolve imports block — adopt upstream structure**

The merged imports must use upstream's refactored structure. Replace the old individual resolver imports with:

```typescript
import { KnowledgeGraph } from '../graph/types.js';
import { ASTCache } from './ast-cache.js';
import Parser from 'tree-sitter';
import { isLanguageAvailable, loadParser, loadLanguage } from '../tree-sitter/parser-loader.js';
import { LANGUAGE_QUERIES } from './tree-sitter-queries.js';
import { generateId } from '../../lib/utils.js';
import { getLanguageFromFilename, isVerboseIngestionEnabled, yieldToEventLoop } from './utils.js';
import type { ExtractedImport } from './workers/parse-worker.js';
import { getTreeSitterBufferSize } from './constants.js';
import { loadImportConfigs } from './language-config.js';
import { buildSuffixIndex } from './resolvers/index.js';
import { callRouters } from './call-routing.js';
import type { ResolutionContext } from './resolution-context.js';
import type { SuffixIndex } from './resolvers/index.js';
import { importResolvers, namedBindingExtractors, preprocessImportPath } from './import-resolution.js';
import type { ImportResult, ResolveCtx, NamedBinding } from './import-resolution.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
```

Note: `SupportedLanguages` is re-added even though upstream removed it — we need it for the COBOL guard in `processImportsFromExtracted`.

- [ ] **Step 7a.2: Rename `suffixIndex` → `index` in `ImportResolutionContext`**

Find the `ImportResolutionContext` interface and update:
```typescript
export interface ImportResolutionContext {
  allFilePaths: Set<string>;
  allFileList: string[];
  normalizedFileList: string[];
  index: SuffixIndex;           // was: suffixIndex
  resolveCache: Map<string, string | null>;
}
```

Update `buildImportResolutionContext` to use `index`:
```typescript
export function buildImportResolutionContext(allPaths: string[]): ImportResolutionContext {
  const allFileList = allPaths;
  const normalizedFileList = allFileList.map(p => p.replace(/\\/g, '/'));
  const allFilePaths = new Set(allFileList);
  const index = buildSuffixIndex(normalizedFileList, allFileList);
  return { allFilePaths, allFileList, normalizedFileList, index, resolveCache: new Map() };
}
```

- [ ] **Step 7a.3: Verify then remove `resolveCobolImport` from this file**

First verify the original function contains no logic beyond name-based path lookup (no calls to `preprocessCobolSource` or other helpers that `resolveCobolPath` in `import-resolution.ts` doesn't reproduce):

```bash
grep -n "preprocessCobolSource\|preprocessCobol" gitnexus/src/core/ingestion/import-processor.ts
```

Expected: no output inside `resolveCobolImport` body (the import line itself is fine — it was imported for other uses that are now removed). If `preprocessCobolSource` IS called inside `resolveCobolImport`, port that call into `resolveCobolPath` in `import-resolution.ts` before proceeding.

Once verified, delete the entire `resolveCobolImport` function (it moves to `import-resolution.ts` in Step 7b). Also remove the `preprocessCobolSource` import line — it's no longer needed in this file.

- [ ] **Step 7a.4: Remove old `resolveLanguageImport` switch and adopt upstream dispatch**

Remove the old `resolveLanguageImport` function (the big switch statement). It is replaced by `importResolvers[language](...)` calls. Upstream's `processImports` and `processImportsFromExtracted` already use the dispatch table — keep those bodies as upstream has them.

For `processImportsFromExtracted`, add a COBOL guard at the call site (since COBOL entries in `importResolvers` now live in `import-resolution.ts` — see Task 7b — the guard is already handled there, but add a `SupportedLanguages.COBOL` check if the function skips it via `isLanguageAvailable`):

```typescript
// In processImportsFromExtracted, the call site:
const result = importResolvers[imp.language](imp.rawImportPath, filePath, resolveCtx);
// This works because resolveCobolPath is now in importResolvers[COBOL]
```

- [ ] **Step 7a.5: Confirm no markers, stage**

```bash
grep -n "<<<<<<\|>>>>>>>\|=======" gitnexus/src/core/ingestion/import-processor.ts
git add gitnexus/src/core/ingestion/import-processor.ts
```

### 7b: Patch `import-resolution.ts` (no conflict marker — manual edit)

- [ ] **Step 7b.1: Add `resolveCobolPath` function before `importResolvers`**

Open `gitnexus/src/core/ingestion/import-resolution.ts`. Find the line:
```typescript
export const importResolvers = {
```

Insert this function immediately before it:

```typescript
// ============================================================================
// COBOL import resolution (moved from import-processor.ts)
// ============================================================================

/**
 * Resolve a COBOL COPY/CALL target to a file path.
 * COBOL imports are name-based: COPY SSTORIA → file named SSTORIA (often extensionless).
 */
function resolveCobolPath(
  importName: string,
  ctx: ResolveCtx,
): string | null {
  let name = importName.replace(/^['"]|['"]$/g, '').trim();
  if (!name) return null;
  const cacheKey = `cobol::${name}`;
  if (ctx.resolveCache.has(cacheKey)) return ctx.resolveCache.get(cacheKey) ?? null;
  const cache = (r: string | null): string | null => { ctx.resolveCache.set(cacheKey, r); return r; };
  const exact = ctx.index.get(name) || ctx.index.getInsensitive(name);
  if (exact) return cache(exact);
  for (const ext of ['.cpy', '.copy', '.cbl', '.cob', '.cobol']) {
    const r = ctx.index.get(name + ext) || ctx.index.getInsensitive(name + ext);
    if (r) return cache(r);
  }
  for (const v of [name.toUpperCase(), name.toLowerCase()]) {
    const r = ctx.index.get(v) || ctx.index.getInsensitive(v);
    if (r) return cache(r);
  }
  return cache(null);
}

```

- [ ] **Step 7b.2: Add COBOL entry to `importResolvers`**

Find the line:
```typescript
} satisfies Record<SupportedLanguages, ImportResolverFn>;
```

Add this entry immediately before that closing brace:
```typescript
  [SupportedLanguages.COBOL]: (raw, _fp, ctx) => {
    const p = resolveCobolPath(raw, ctx);
    return p ? { kind: 'files', files: [p] } : null;
  },
```

- [ ] **Step 7b.3: Add COBOL entry to `namedBindingExtractors`**

Find the second:
```typescript
} satisfies Record<SupportedLanguages, NamedBindingExtractorFn | undefined>;
```

Add immediately before that closing brace:
```typescript
  [SupportedLanguages.COBOL]: undefined,
```

- [ ] **Step 7b.4: Verify the file compiles conceptually**

```bash
grep -n "COBOL" gitnexus/src/core/ingestion/import-resolution.ts
```

Expected: shows `resolveCobolPath`, `SupportedLanguages.COBOL` in both dispatch tables.

- [ ] **Step 7b.5: Stage**

```bash
git add gitnexus/src/core/ingestion/import-resolution.ts
```

---

## Task 8: High — useAppState.tsx + useWorkerState.ts

**Files:**
- `gitnexus-web/src/hooks/useAppState.tsx` (conflict file — use `--ours`)
- `gitnexus-web/src/hooks/useWorkerState.ts` (no conflict — add new method)

### 8a: Restore useAppState.tsx

- [ ] **Step 8a.1: Discard upstream's monolith, keep our split-hooks version**

```bash
git checkout --ours -- gitnexus-web/src/hooks/useAppState.tsx
```

- [ ] **Step 8a.2: Verify the file is our 324-line split-hooks version**

```bash
wc -l gitnexus-web/src/hooks/useAppState.tsx
grep -n "useWorkerState\|useGraphState\|AppStateProvider" gitnexus-web/src/hooks/useAppState.tsx | head -5
```

Expected: ~324 lines, imports from split hooks visible.

### 8b: Add `hydrateWorkerFromServer` to `WorkerState` interface

- [ ] **Step 8b.1: Add to `WorkerState` interface in `useWorkerState.ts`**

Open `gitnexus-web/src/hooks/useWorkerState.ts`. Add to the `WorkerState` interface after `testArrayParams`:

```typescript
  // Server hydration (populate worker-side DB from server-loaded data)
  hydrateWorkerFromServer: (nodes: GraphNode[], relationships: GraphRelationship[], fileContents: Record<string, string>) => Promise<void>;
```

At the top of the file, add the graph type imports:
```typescript
import type { GraphNode, GraphRelationship } from '../core/graph/types';
```

- [ ] **Step 8b.2: Add the implementation in `useWorkerState` function body**

After the existing `testArrayParams` callback, add:

```typescript
  const hydrateWorkerFromServer = useCallback(async (
    nodes: GraphNode[],
    relationships: GraphRelationship[],
    fileContents: Record<string, string>
  ): Promise<void> => {
    const api = apiRef.current;
    if (!api) throw new Error('Worker not initialized');
    await api.hydrateFromServerData(nodes, relationships, fileContents);
  }, []);
```

- [ ] **Step 8b.3: Add to the `return` object of `useWorkerState`**

In the `return { ... }` block at the end of the function, add:
```typescript
    hydrateWorkerFromServer,
```

### 8c: Wire `hydrateWorkerFromServer` into `useAppState.tsx`

- [ ] **Step 8c.1: Add to `AppState` interface**

Open `gitnexus-web/src/hooks/useAppState.tsx`. In the `AppState` interface, add after `testArrayParams`:

```typescript
  // Server hydration
  hydrateWorkerFromServer: (nodes: GraphNode[], relationships: GraphRelationship[], fileContents: Record<string, string>) => Promise<void>;
```

Add type imports at the top if not present:
```typescript
import type { GraphNode, GraphRelationship } from '../core/graph/types';
```

- [ ] **Step 8c.2: Wire from `workerState` in `AppStateProvider`**

In `AppStateProvider`'s context value object (the large `value = { ... }` passed to the provider), add:
```typescript
    hydrateWorkerFromServer: workerState.hydrateWorkerFromServer,
```

- [ ] **Step 8c.3: Verify and stage**

```bash
grep -n "hydrateWorkerFromServer" gitnexus-web/src/hooks/useAppState.tsx gitnexus-web/src/hooks/useWorkerState.ts
git add gitnexus-web/src/hooks/useAppState.tsx gitnexus-web/src/hooks/useWorkerState.ts
```

Expected: appears in both files.

---

## Task 9: High — App.tsx

**Files:** `gitnexus-web/src/App.tsx` (conflict file — use `--ours`, then manual edit)

- [ ] **Step 9.1: Discard upstream changes, keep our LOD/smartConnect version**

```bash
git checkout --ours -- gitnexus-web/src/App.tsx
```

- [ ] **Step 9.2: Add `hydrateWorkerFromServer` to the destructure**

Find the `useAppState()` destructure near the top of the `App` component. Add `hydrateWorkerFromServer` to it:

```typescript
const {
  // ... existing fields ...
  hydrateWorkerFromServer,
  setProgress,
  // ... rest ...
} = useAppState();
```

(`setProgress` should already be there — just confirm it is, and add `hydrateWorkerFromServer` next to it.)

- [ ] **Step 9.3: Update `handleServerConnect` body**

Find the `handleServerConnect` useCallback (around line 145). The current body ends with:
```typescript
    if (getActiveProviderConfig()) {
      initializeAgent(projectName, backendUrl, fileMap);
    }
    startEmbeddings().catch((err) => { ... });
```

Replace those last lines with:
```typescript
    // Hydrate worker DB then initialize agent (non-blocking for graph UI)
    // Use result.fileContents directly (same data as fileMap — fileMap is built from it above)
    setProgress(null);
    hydrateWorkerFromServer(result.nodes, result.relationships, result.fileContents)
      .then(() => {
        if (getActiveProviderConfig()) {
          initializeAgent(projectName, backendUrl, fileMap);
        }
        startEmbeddings().catch((err) => {
          if (err?.name === 'WebGPUNotAvailableError' || err?.message?.includes('WebGPU')) {
            startEmbeddings('wasm').catch(console.warn);
          } else {
            console.warn('Embeddings auto-start failed:', err);
          }
        });
      })
      .catch((err) => {
        console.warn('Worker hydration failed (non-fatal):', err);
        if (getActiveProviderConfig()) initializeAgent(projectName, backendUrl, fileMap);
      });
```

**Important:** The synchronous block above this (graph build, `setGraph`, `setFileContents`, `setViewMode('exploring')`, `setGraphTruncated`) must stay as-is, outside and before the `hydrateWorkerFromServer` call.

- [ ] **Step 9.4: Add deps to `useCallback` dependency array**

The `handleServerConnect` useCallback dep array currently ends with:
```typescript
  }, [setViewMode, setGraph, setFileContents, setProjectName, setGraphTruncated, initializeAgent, startEmbeddings]);
```

Update to:
```typescript
  }, [setViewMode, setGraph, setFileContents, setProjectName, setGraphTruncated, initializeAgent, startEmbeddings, hydrateWorkerFromServer, setProgress]);
```

- [ ] **Step 9.5: Confirm no markers and stage**

```bash
grep -n "<<<<<<\|>>>>>>>\|=======" gitnexus-web/src/App.tsx
git add gitnexus-web/src/App.tsx
```

---

## Task 10: Build Verification

**Files:** no edits — verification only

- [ ] **Step 10.1: Confirm all conflicts are resolved**

```bash
git diff --name-only --diff-filter=U
```

Expected: no output (empty — all conflicts resolved).

- [ ] **Step 10.2: Build gitnexus backend**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus
npm run build 2>&1 | tail -20
```

Expected: exits 0. If TypeScript errors appear:
- `Property 'COBOL' is missing` → COBOL entry missing in a `satisfies Record<SupportedLanguages,...>` — check `import-resolution.ts` and `call-routing.ts`
- `Property 'index' does not exist on type 'ImportResolutionContext'` → `suffixIndex→index` rename incomplete in `import-processor.ts`
- `Property 'typeEnvBindings' is missing` → update `WorkerExtractedData` interface in `parsing-processor.ts`

- [ ] **Step 10.3: Build gitnexus-web frontend**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus-web
npm run build 2>&1 | tail -20
```

Expected: exits 0. If TypeScript errors appear:
- `Property 'hydrateWorkerFromServer' does not exist` → missing from `AppState` interface or `workerState` wiring
- `LLMProvider` union issues → re-check `llm/types.ts` 9-type union

- [ ] **Step 10.4: Run backend test suite**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus
npm test 2>&1 | tail -30
```

Expected: mostly passes. Pre-existing flaky tests acceptable:
- KuzuDB lock contention tests (5-6 failures) — pre-existing, not our fault
- `tree-sitter-queries.test.ts` COBOL entry failure — pre-existing

If NEW failures appear (tests that were passing before), investigate before proceeding.

- [ ] **Step 10.5: Verify must-preserve checklist**

```bash
# Neptune flags present
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus
node dist/cli/index.js analyze --help | grep -i neptune

# COBOL preprocessor untouched
git diff HEAD -- gitnexus/src/core/ingestion/cobol-preprocessor.ts

# perfection-loop skill untouched
ls .claude/skills/gitnexus/perfection-loop/

# All 55 commits present
git log --oneline upstream/main..HEAD | wc -l
```

Expected:
- Neptune flags visible in help output
- `cobol-preprocessor.ts` shows no diff (untouched)
- Skill directory exists with files
- ~55+ commits shown

---

## Task 11: Commit + Push

- [ ] **Step 11.1: Stage any remaining unstaged files**

```bash
cd /Users/danielnicusornaicu/private/GitNexus
git status
```

All modified/resolved files should show as `modified` (staged). If any show as unstaged, run `git add <file>`.

- [ ] **Step 11.2: Commit the merge**

```bash
git commit -m "$(cat <<'EOF'
Merge upstream/main: Phase 14 type resolution + markdown + MiniMax, preserve Neptune+COBOL+skills

Absorbed from upstream (51 commits):
- Phase 14: cross-file binding propagation (topologicalLevelSort, seedCrossFileReceiverTypes)
- Markdown file indexing (processMarkdown, Section NodeLabel)
- Language dispatch unification (import-resolution.ts dispatch tables)
- MiniMax LLM provider support
- Worker DB hydration (hydrateFromServerData)
- Codex setup support, ruby/ORT CUDA fixes, triage sweep workflow

Preserved from our fork:
- Neptune AWS graph backend (neptune/ dir, --db neptune CLI, SettingsPanel section)
- COBOL support (regex-only extraction, copy expansion, resolveCobolPath in dispatch)
- perfection-loop skill
- LOD/DataExplorer web UI (smartConnect, DataExplorer component)
- Bedrock + Custom LLM providers (9-type LLMProvider union)

Co-Authored-By: Claude Sonnet 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11.3: Verify commit**

```bash
git log --oneline -3
git log --oneline upstream/main..HEAD | wc -l
```

Expected: merge commit at HEAD, ~56 commits ahead of upstream.

- [ ] **Step 11.4: Push to origin**

```bash
git push origin main
```

Expected: push succeeds. If rejected (non-fast-forward), investigate — do NOT force push.

---

## Rollback

If anything goes wrong at any point before the commit (Step 11.2):
```bash
git merge --abort    # if merge is still in progress
# OR
git reset --hard backup-before-upstream-sync-v3   # if merge was completed but broken
```

After a successful push, the backup branch can be deleted:
```bash
git branch -d backup-before-upstream-sync-v3
```
