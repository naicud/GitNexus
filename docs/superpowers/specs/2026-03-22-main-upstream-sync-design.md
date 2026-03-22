# Spec: Align main with upstream/main

**Date:** 2026-03-22
**Author:** Claude Code (brainstorming session)
**Status:** Approved

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
| Hidden build-breaking files | 1 (`import-resolution.ts`) |

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
| `gitnexus-web/src/core/llm/types.ts` | `custom` + `bedrock` providers | `minimax` provider | `LLMProvider` = 8 types; all 3 config interfaces additive |
| `gitnexus-web/src/core/llm/agent.ts` | `custom` + `bedrock` switch cases | `minimax` switch case | Keep all 3 new cases |
| `gitnexus-web/src/core/llm/settings-service.ts` | `custom` + `bedrock` settings | `minimax` settings | Keep all 3 providers |

### Medium Complexity

**`gitnexus/src/core/ingestion/pipeline.ts`**
- Ours: COBOL copy expansion (~200 lines), `expandCopies`/`getLanguageFromPath`/`cobol-copy-expander` imports, `isDev` extended with `GITNEXUS_VERBOSE`
- Upstream: `topologicalLevelSort` function, `CROSS_FILE_SKIP_THRESHOLD`, `MAX_CROSS_FILE_REPROCESS`, markdown processor import, `EMPTY_INDEX`, additional `call-processor` exports
- **Resolution:** Hand-merge import block; keep our COBOL block intact; add upstream's topo sort and cross-file constants; keep `isDev` with VERBOSE extension

**`gitnexus-web/src/components/SettingsPanel.tsx`**
- Ours: Neptune DB section (dbType/neptuneEndpoint states), CypherConsole, Bedrock test, new props (`onReloadGraph`, `currentRepo`)
- Upstream: MiniMax added to `providers` array, `⚡` icon, MiniMax settings section
- **Resolution:** Accept upstream's `providers` array change; keep our Neptune block; graft MiniMax settings section alongside our Neptune section

### High Complexity

**`gitnexus/src/core/ingestion/parsing-processor.ts`** (our 638 lines ↔ upstream 331 lines)
- Ours: COBOL regex-only block (~300 lines), `SupportedLanguages`, `getLanguageFromPath`, `isBuiltInOrNoise`, `sequentialFallback` flag
- Upstream: `typeEnvBindings` in `WorkerExtractedData`, `getLabelFromCaptures` import, `FileTypeEnvBindings` type, removed `SupportedLanguages` and `isNodeExported` re-export
- **Resolution:**
  - Keep `SupportedLanguages` import (removed by upstream but required for COBOL)
  - Keep entire COBOL regex-only block
  - Add `typeEnvBindings: FileTypeEnvBindings[]` to `WorkerExtractedData` interface
  - Add `FileTypeEnvBindings` to parse-worker imports, `getLabelFromCaptures` to utils imports
  - COBOL sequential path returns `{ ..., typeEnvBindings: [] }`
  - Remove `isNodeExported` re-export per upstream

**`gitnexus/src/core/ingestion/import-processor.ts`** (our 636 lines ↔ upstream 381 lines)
- Ours: `resolveCobolImport` function, `preprocessCobolSource` import, `suffixIndex` field in `ImportResolutionContext`, COBOL dispatch in `resolveLanguageImport`, `SupportedLanguages` import
- Upstream: Major refactor — 7 resolver imports replaced by `importResolvers` dispatch table (in new `import-resolution.ts`), `suffixIndex` renamed to `index`, `loadImportConfigs` replaces individual config loaders
- **Resolution:**
  - Adopt upstream's import structure (importResolvers + loadImportConfigs)
  - Keep `resolveCobolImport` function body, update `ctx.suffixIndex` → `ctx.index` (3 occurrences)
  - Re-add `SupportedLanguages` import for COBOL check
  - At the 3 call sites where upstream calls `importResolvers[language](...)`, add COBOL guard:
    ```typescript
    if (language === SupportedLanguages.COBOL) {
      // use resolveCobolImport
    } else {
      importResolvers[language](...)
    }
    ```

**`gitnexus-web/src/hooks/useAppState.tsx`** (our 324 lines ↔ upstream 1217 lines)
- Ours: Refactored into split hooks (`useGraphState`, `useFilterState`, `useChatState`, `useWorkerState`)
- Upstream: Added `hydrateWorkerFromServer` callback to monolith
- **Resolution:**
  - `git checkout --ours -- gitnexus-web/src/hooks/useAppState.tsx`
  - Add `hydrateWorkerFromServer` to `useWorkerState.tsx`
  - Re-export from `useAppState.tsx`

**`gitnexus-web/src/App.tsx`**
- Ours: LOD/`smartConnect`, `DataExplorer`, `backendUrl` param in `handleServerConnect`, no `hydrateWorkerFromServer`
- Upstream: `hydrateWorkerFromServer` wrapping `initializeAgent` in `handleServerConnect`
- **Resolution:**
  - `git checkout --ours -- gitnexus-web/src/App.tsx`
  - Add `hydrateWorkerFromServer` from `useAppState` hook
  - Wrap `initializeAgent` call inside `handleServerConnect` in `hydrateWorkerFromServer(...).then()`

---

## Hidden Build-Breaking Issue

**`import-resolution.ts`** — NEW file from upstream, arrives with no conflict markers.

Uses exhaustive dispatch tables:
```typescript
} satisfies Record<SupportedLanguages, ImportResolverFn>
} satisfies Record<SupportedLanguages, NamedBindingExtractorFn | undefined>
```

Our `SupportedLanguages` includes `COBOL`. TypeScript will fail compilation unless COBOL entries are added.

**Required fix post-merge (before build):**
```typescript
// In importResolvers (~line 362):
[SupportedLanguages.COBOL]: () => null,  // resolved separately in import-processor.ts

// In namedBindingExtractors (~line 383):
[SupportedLanguages.COBOL]: undefined,   // COBOL has no named imports
```

---

## Execution Sequence

```
Step 1  git branch backup-before-upstream-sync-v3
Step 2  git merge upstream/main             # produces 11 conflict markers
Step 3  Resolve 5 LOW files                 # ~5 min
Step 4  Resolve 2 MEDIUM files              # ~15 min
Step 5  git checkout --ours useAppState.tsx + App.tsx
Step 6  Add hydrateWorkerFromServer to useWorkerState.tsx
Step 7  Integrate hydrateWorkerFromServer in App.tsx handleServerConnect
Step 8  Resolve parsing-processor.ts        # ~20 min
Step 9  Resolve import-processor.ts         # ~15 min
Step 10 Patch import-resolution.ts COBOL entries
Step 11 git add -- all resolved files
Step 12 npm run build   (in gitnexus/)
Step 13 npm test
Step 14 git commit "Merge upstream/main: preserve Neptune+COBOL+skills"
Step 15 git push origin main
```

---

## Must-Preserve Checklist

- [ ] Neptune: all files in `gitnexus/src/core/db/neptune/`, `--db neptune` CLI flags, SettingsPanel Neptune section
- [ ] COBOL: `cobol-preprocessor.ts`, `cobol-copy-expander.ts`, parse-worker COBOL block, parsing-processor COBOL block, import-processor `resolveCobolImport`, pipeline COBOL expansion
- [ ] perfection-loop skill: `.claude/skills/gitnexus/perfection-loop/` untouched
- [ ] LOD/DataExplorer: `App.tsx` `smartConnect` + `DataExplorer` component
- [ ] Bedrock+Custom providers: `llm/types.ts`, `llm/agent.ts`, `llm/settings-service.ts` entries

---

## Success Criteria

1. `npm run build` exits 0 in `gitnexus/` package
2. `npm test` passes (pre-existing KuzuDB test flakiness is acceptable)
3. `git log --oneline` shows the 55 original commits still reachable
4. Neptune CLI flags present: `gitnexus analyze --help | grep neptune`
5. COBOL regex extraction test passes
