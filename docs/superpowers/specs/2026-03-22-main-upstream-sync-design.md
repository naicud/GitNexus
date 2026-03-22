# Spec: Align main with upstream/main

**Date:** 2026-03-22
**Author:** Claude Code (brainstorming session)
**Status:** Approved (v3 — all spec-review blockers resolved)

---

## Context

Our `main` branch is a fork of `abhigyanpatwari/GitNexus` with significant custom features:
- **Neptune** AWS graph DB backend (`gitnexus/src/core/db/neptune/`)
- **COBOL** language support (regex-only indexing, copy expansion, deep indexing)
- **perfection-loop** skill + reference docs
- **LOD/DataExplorer** web UI features
- **Bedrock + Custom** LLM providers in the web UI

Upstream has moved forward 51 commits since our last sync (merge base `c14a78a`).

---

## Divergence Summary

| Metric | Value |
|--------|-------|
| Merge base | `c14a78a` (Merge PR #394) |
| Our exclusive commits | 55 |
| Upstream commits to absorb | 51 |
| Files that differ | 315 |
| Conflict files | 11 |
| Hidden build-breaking new files | 2: `import-resolution.ts`, `ast-helpers.ts` |
| Auto-merge with critical new code | 1: `ingestion.worker.ts` |

---

## Strategy

**Approach:** `git merge upstream/main` directly on `main` with a backup branch.
**Same pattern used in:** `Merge upstream/main: Type resolution Phases 7-9C + Milestone D, preserve Neptune+COBOL`

---

## Conflict Resolution Guide

### Low Complexity (additive, no overlap)

| File | Ours | Upstream | Resolution |
|------|------|----------|------------|
| `gitnexus/src/core/graph/types.ts` | COBOL rel types + `ClusterGroup` NodeLabel | `Section` NodeLabel + `level` property | Keep all — blocks in different locations |
| `gitnexus/src/cli/index.ts` | Neptune `--db/--neptune-*` opts, `embed` command, `-y` flags | setup description adds "Codex" | Different sections, keep both |
| `gitnexus-web/src/core/llm/types.ts` | `custom` + `bedrock` providers | `minimax` provider | `LLMProvider` = **9 types** total; all 3 config interfaces additive |
| `gitnexus-web/src/core/llm/agent.ts` | `custom` + `bedrock` switch cases | `ChatBedrockBrowser` import | `minimax` switch case | Keep all 3 new cases |
| `gitnexus-web/src/core/llm/settings-service.ts` | `custom` + `bedrock` settings | `minimax` settings | Keep all 3 providers |

### Medium Complexity

**`gitnexus/src/core/ingestion/pipeline.ts`**

This file absorbs two major upstream features: Phase 14 cross-file binding propagation and markdown file indexing. Note: Step 9 (`import-processor.ts` suffix rename) must be completed before running `npm run build`, because `importCtx.index` written in Step 6 refers to the renamed field.

Upstream additions to integrate:
1. **Imports:** `processMarkdown` (markdown-processor), `EMPTY_INDEX` (resolvers/index), additional call-processor exports: `seedCrossFileReceiverTypes`, `buildImportedReturnTypes`, `buildImportedRawReturnTypes`, `type ExportedTypeMap`, `buildExportedTypeMapFromGraph`
2. **`topologicalLevelSort`** function (~60 lines) — inserted before `CHUNK_BYTE_BUDGET`
3. **`CROSS_FILE_SKIP_THRESHOLD`** and **`MAX_CROSS_FILE_REPROCESS`** constants
4. **`synthesizeWildcardImportBindings`** function (~40 lines)
5. **`typeEnvBindings` accumulation** across worker chunks
6. **`processMarkdown` invocation** in the md-files branch of the main loop
7. **Cross-file re-resolution loop** (calls `seedCrossFileReceiverTypes`, `buildImportedReturnTypes`, etc.) — after the existing `processCalls` block
8. **`importCtx.index = EMPTY_INDEX`** — replaces manual memory-release after `synthesizeWildcardImportBindings`

Our additions to preserve:
- COBOL copy expansion block (~200 lines)
- `isDev` extended with `|| !!process.env.GITNEXUS_VERBOSE`
- `getLanguageFromPath`, `expandCopies`, `cobol-copy-expander`, `KnowledgeGraph` imports

**Import block:** Hand-merge — both branches added different imports. All must survive.

---

**`gitnexus-web/src/components/SettingsPanel.tsx`**

- `providers` array merged result (explicit): `['openai', 'gemini', 'anthropic', 'azure-openai', 'ollama', 'openrouter', 'minimax', 'custom', 'bedrock']`
- Provider icon map: add `provider === 'minimax' ? '⚡' :` (do NOT remove `custom`/`bedrock` handling)
- Keep our Neptune DB section intact
- Graft MiniMax settings section alongside our Neptune section

---

### High Complexity

**`gitnexus/src/core/ingestion/parsing-processor.ts`** (our 638 lines ↔ upstream 331 lines)

**Resolution:**
1. Keep `SupportedLanguages` import (upstream removes it; we need it for COBOL detection)
2. Keep entire COBOL regex-only block
3. Add `typeEnvBindings: FileTypeEnvBindings[]` to `WorkerExtractedData` interface
4. Add `FileTypeEnvBindings` to parse-worker imports
5. **`getLabelFromCaptures`**: upstream moved this function to a new `ast-helpers.ts` file (arrives as a new, auto-merged file), re-exported via `utils.ts` `export * from './ast-helpers.js'`. The upstream version has a 2-arg signature `getLabelFromCaptures(captureMap, language)` and includes the C/C++ dedup guard (`isCppDuplicateClassFunction`). In `parsing-processor.ts`'s sequential fallback path, **replace the inline `if/else` label-detection chain with `getLabelFromCaptures(captureMap, language)`** — the upstream 2-arg version handles all the same cases including C/C++.
6. COBOL sequential path's final return must include `typeEnvBindings: []`
7. Remove `isNodeExported` re-export (per upstream)

---

**`gitnexus/src/core/ingestion/import-processor.ts`** (our 636 lines ↔ upstream 381 lines)

**Resolution:**
1. Adopt upstream's import structure (use `importResolvers`, `loadImportConfigs`, `namedBindingExtractors`, `preprocessImportPath` from `import-resolution.ts`)
2. `ImportResolutionContext.suffixIndex` → `index` (upstream rename; update interface definition AND all usage inside `import-processor.ts`)
3. **Move `resolveCobolImport` to `import-resolution.ts`** (see Hidden Issue section below for exact implementation)
4. Remove `resolveCobolImport` from `import-processor.ts` — it now lives in `import-resolution.ts`
5. Remove `preprocessCobolSource` import from `import-processor.ts` (no longer needed here)

---

**`gitnexus-web/src/hooks/useAppState.tsx`** (our 324 lines ↔ upstream 1217 lines)

**Resolution:**
1. `git checkout --ours -- gitnexus-web/src/hooks/useAppState.tsx`
2. `apiRef` lives in `useWorkerState.ts` — add `hydrateWorkerFromServer` there:
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
3. Export from `useWorkerState` return value
4. Add to `AppStateValue` interface in `useAppState.tsx` and wire via `workerState.hydrateWorkerFromServer`

**Note:** `hydrateFromServerData` on the worker **arrives via auto-merge** in `ingestion.worker.ts` (upstream added it, we added `generateCypherQuery` — no conflict). Must verify both methods exist after merge (Step 3 of sequence).

---

**`gitnexus-web/src/App.tsx`**

**Resolution:**
1. `git checkout --ours -- gitnexus-web/src/App.tsx`
2. Destructure `hydrateWorkerFromServer` from `useAppState`
3. Inside `handleServerConnect`, the **synchronous graph-build block** (graph node loop, `setGraph`, `setFileContents`, `setViewMode('exploring')`) stays synchronous and outside the hydration call. Only `initializeAgent` and `startEmbeddings` move into the `.then()`. Add `setProgress(null)` before the hydration call:
   ```typescript
   // These stay synchronous (graph is needed for the UI):
   setGraph(graph); setFileContents(...); setViewMode('exploring'); setGraphTruncated(...);

   // Then start hydration + agent init:
   setProgress(null);
   hydrateWorkerFromServer(result.nodes, result.relationships, result.fileContents)
     .then(() => {
       if (getActiveProviderConfig()) {
         initializeAgent(projectName, backendUrl, fileMap);
       }
       startEmbeddings().catch(...);
     })
     .catch((err) => {
       console.warn('Worker hydration failed (non-fatal):', err);
       if (getActiveProviderConfig()) initializeAgent(projectName, backendUrl, fileMap);
     });
   ```
4. Add `setProgress` and `hydrateWorkerFromServer` to the `useCallback` dependency array

---

## Hidden Build-Breaking Issues

### 1. `import-resolution.ts` (NEW file from upstream)

Arrives with no conflict markers. Contains two exhaustive dispatch tables:
```typescript
} satisfies Record<SupportedLanguages, ImportResolverFn>
} satisfies Record<SupportedLanguages, NamedBindingExtractorFn | undefined>
```

Our `SupportedLanguages` includes `COBOL`. TypeScript will fail without COBOL entries.

**Fix — add `resolveCobolImport` to this file and wire into both tables:**

The core COBOL resolution logic (moved from `import-processor.ts`) returns `string | null`. The `ImportResolverFn` signature requires `ImportResult | null`. Wrap the result:

```typescript
// Place the helper near the top of importResolvers:
function resolveCobolPath(
  importName: string,
  ctx: ResolveCtx,
): string | null {
  let name = importName.replace(/^['"]|['"]$/g, '').trim();
  if (!name) return null;
  const cacheKey = `cobol::${name}`;
  if (ctx.resolveCache.has(cacheKey)) return ctx.resolveCache.get(cacheKey) ?? null;
  const cache = (r: string | null) => { ctx.resolveCache.set(cacheKey, r); return r; };
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

// In importResolvers table (use pattern search, not line numbers):
// Find: } satisfies Record<SupportedLanguages, ImportResolverFn>
// Add before that line:
[SupportedLanguages.COBOL]: (raw, _fp, ctx) => {
  const p = resolveCobolPath(raw, ctx);
  return p ? { kind: 'files', files: [p] } : null;
},

// In namedBindingExtractors table:
// Find: } satisfies Record<SupportedLanguages, NamedBindingExtractorFn | undefined>
// Add before that line:
[SupportedLanguages.COBOL]: undefined,
```

### 2. `ast-helpers.ts` (NEW file from upstream)

Arrives with no conflict markers. Contains `getLabelFromCaptures(captureMap, language)` with the 2-arg signature and C/C++ dedup guard. `utils.ts` will auto-merge a new `export * from './ast-helpers.js'` line. No action needed beyond verifying the auto-merge added this re-export.

---

## Execution Sequence

```
Step  1  git branch backup-before-upstream-sync-v3
Step  2  git merge upstream/main            # produces 11 conflict markers
Step  3  Verify ingestion.worker.ts auto-merged: both generateCypherQuery (ours)
         AND hydrateFromServerData (upstream) must be present
         If auto-merge failed: manually merge the two method bodies
Step  4  Verify ast-helpers.ts arrived (new file) and utils.ts has
         `export * from './ast-helpers.js'`
Step  5  Resolve 5 LOW files                # ~5 min
Step  6  Resolve SettingsPanel.tsx (MEDIUM) # ~10 min
Step  7  Resolve pipeline.ts (MEDIUM)       # ~20 min — absorb full Phase 14
Step  8  Resolve parsing-processor.ts (HIGH)# ~20 min
Step  9  Rename suffixIndex→index in import-processor.ts, adopt upstream structure
         NOTE: must complete before Step 15 build, as pipeline.ts now uses importCtx.index
Step 10  Move resolveCobolImport to import-resolution.ts, fix return type, wire tables
Step 11  git checkout --ours gitnexus-web/src/hooks/useAppState.tsx
Step 12  Add hydrateWorkerFromServer to useWorkerState.ts, export it, add to
         AppStateValue interface in useAppState.tsx
Step 13  git checkout --ours gitnexus-web/src/App.tsx
Step 14  Add hydrateWorkerFromServer + setProgress(null) to handleServerConnect;
         keep graph-build block synchronous; add deps to useCallback array
Step 15  git add all resolved files
Step 16  npm run build   (in gitnexus/)     # backend — catches TS errors in core
Step 17  npm run build   (in gitnexus-web/) # frontend — catches TS errors in web
Step 18  npm test        (in gitnexus/)
Step 19  git commit "Merge upstream/main: preserve Neptune+COBOL+skills"
Step 20  git push origin main
```

---

## Must-Preserve Checklist

- [ ] Neptune: `gitnexus/src/core/db/neptune/`, `--db neptune` CLI flags, SettingsPanel Neptune section, CypherConsole
- [ ] COBOL: `cobol-preprocessor.ts`, `cobol-copy-expander.ts`, parse-worker COBOL block, parsing-processor COBOL block, `resolveCobolPath` (moved to `import-resolution.ts`), pipeline COBOL expansion
- [ ] perfection-loop skill: `.claude/skills/gitnexus/perfection-loop/` — auto-merge, verify
- [ ] LOD/DataExplorer: `App.tsx` `smartConnect` + `DataExplorer` component
- [ ] Bedrock+Custom providers: 9-type union in `llm/types.ts`, agent cases, settings entries
- [ ] `useWorkerState.ts`: contains `hydrateWorkerFromServer` (newly added), exported
- [ ] `ingestion.worker.ts`: both `generateCypherQuery` (ours) AND `hydrateFromServerData` (upstream) present
- [ ] `import-resolution.ts`: `[SupportedLanguages.COBOL]` entries in both tables

---

## Success Criteria

1. `npm run build` exits 0 in `gitnexus/` package
2. `npm run build` exits 0 in `gitnexus-web/` package
3. `npm test` passes in `gitnexus/` (pre-existing KuzuDB flakiness acceptable)
4. `git log --oneline` shows our 55 exclusive commits still reachable from HEAD
5. `gitnexus analyze --help | grep neptune` shows Neptune flags
6. COBOL regex extraction test passes (or manual verification: `src/core/ingestion/cobol-preprocessor.ts` unchanged)
