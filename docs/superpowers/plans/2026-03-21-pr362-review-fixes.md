# PR #362 Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all 6 issues + 1 minor note from the Claude performance review on PR #362, resolve merge conflicts with main, and run a GitNexus-powered PR review as final validation.

**Architecture:** Phase 1 resolves merge conflicts (blocking prerequisite). Phase 2 dispatches 4 parallel agents for independent file fixes. Phase 3 verifies builds/tests. Phase 4 runs the `gitnexus-pr-review` skill for blast-radius and risk assessment before push.

**Tech Stack:** TypeScript, KuzuDB (LadybugDB wrapper), React (Sigma.js graph viz), Vitest

---

## Conflict Files Reference (22 files)

```
gitnexus-web/src/App.tsx
gitnexus-web/src/components/ContextMenu.tsx
gitnexus-web/src/components/GraphCanvas.tsx
gitnexus-web/src/components/SettingsPanel.tsx
gitnexus-web/src/core/llm/agent.ts
gitnexus-web/src/core/llm/settings-service.ts
gitnexus-web/src/core/llm/types.ts
gitnexus-web/src/hooks/useAppState.tsx
gitnexus-web/src/hooks/useChatState.ts
gitnexus-web/src/hooks/useGraphState.ts
gitnexus-web/src/hooks/useSigma.ts
gitnexus-web/src/hooks/useWorkerState.ts
gitnexus-web/src/lib/graph-adapter.ts
gitnexus/src/cli/index.ts
gitnexus/src/core/graph/types.ts
gitnexus/src/core/ingestion/import-processor.ts
gitnexus/src/core/ingestion/parsing-processor.ts
gitnexus/src/core/ingestion/pipeline.ts
gitnexus/src/core/ingestion/utils.ts
gitnexus/src/mcp/local/local-backend.ts
gitnexus/src/server/api.ts
gitnexus/test/unit/schema.test.ts
```

---

## Phase 1: Merge Conflict Resolution (sequential, blocking)

### Task 1: Merge main into pr/performance-lod-rendering

**Files:** All 22 conflict files listed above

**Context:** @magyargergo requested merge conflict resolution. This branch has diverged from main after several PRs were merged (#397, #409, etc.). The conflicts span backend ingestion, CLI, server API, web components, hooks, and tests.

**Strategy:** Our branch (`pr/performance-lod-rendering`) is the feature branch with LOD changes. Main has received language dispatch unification (#409) and cross-file binding propagation (#397). For each conflict:
- LOD-specific additions (new endpoints, new components, new hooks) → keep ours
- Shared infrastructure (types, ingestion pipeline, imports) → merge both sides carefully
- Test files → merge both sides

- [ ] **Step 1: Start the merge**

```bash
cd /Users/danielnicusornaicu/private/GitNexus
git fetch origin main
git merge origin/main
```

Expected: `Automatic merge failed` with 22 CONFLICT markers.

- [ ] **Step 2: Resolve backend conflicts (7 files)**

Resolve each file, understanding what main changed vs what our branch changed:

1. `gitnexus/src/cli/index.ts` — Main added new CLI commands from #409. Keep both sides.
2. `gitnexus/src/core/graph/types.ts` — Main added new types from cross-file binding. Our branch added LOD types. Keep both.
3. `gitnexus/src/core/ingestion/import-processor.ts` — Main refactored import resolution (#409). Our branch has minor LOD changes. Accept main's refactor, re-apply our changes on top.
4. `gitnexus/src/core/ingestion/parsing-processor.ts` — Similar to import-processor. Main's language dispatch changes + our pipeline changes.
5. `gitnexus/src/core/ingestion/pipeline.ts` — Main added cross-file binding phase. Our branch added `skipGraphPhases` and `generateGraphSummary`. Keep both.
6. `gitnexus/src/core/ingestion/utils.ts` — Main extracted utilities into separate files. Our branch has LOD-related changes. Follow main's restructuring.
7. `gitnexus/src/mcp/local/local-backend.ts` — Both sides modified the backend. Merge carefully.

For each file: read both sides of the conflict, understand the intent, resolve, then `git add <file>`.

- [ ] **Step 3: Resolve server API conflict (1 file)**

`gitnexus/src/server/api.ts` — Main has changes from #409. Our branch adds all LOD endpoints. This is the biggest conflict file. Our LOD endpoints are additive (new routes), so keep both sides. Watch for import changes at the top.

- [ ] **Step 4: Resolve web frontend conflicts (13 files)**

These are mostly add/add conflicts (new files created on both branches) or component changes:

1. `gitnexus-web/src/App.tsx` — Both sides modified layout. Our LOD panels + main's changes.
2. `gitnexus-web/src/components/ContextMenu.tsx` — add/add conflict. Likely identical or very similar.
3. `gitnexus-web/src/components/GraphCanvas.tsx` — Both modified. Our LOD rendering + main's fixes.
4. `gitnexus-web/src/components/SettingsPanel.tsx` — Both modified. Merge carefully.
5. `gitnexus-web/src/core/llm/agent.ts` — LLM changes from both sides.
6. `gitnexus-web/src/core/llm/settings-service.ts` — Same.
7. `gitnexus-web/src/core/llm/types.ts` — Type additions from both sides.
8. `gitnexus-web/src/hooks/useAppState.tsx` — Major: our refactor into 6 hooks + main's state additions.
9. `gitnexus-web/src/hooks/useChatState.ts` — add/add: our new hook vs main's.
10. `gitnexus-web/src/hooks/useGraphState.ts` — add/add: our new hook vs main's.
11. `gitnexus-web/src/hooks/useSigma.ts` — Both modified.
12. `gitnexus-web/src/hooks/useWorkerState.ts` — add/add: our new hook vs main's.
13. `gitnexus-web/src/lib/graph-adapter.ts` — Both modified batch import logic.

For each: read conflicts, resolve, `git add`.

- [ ] **Step 5: Resolve test conflict**

`gitnexus/test/unit/schema.test.ts` — Merge both sides' test additions.

- [ ] **Step 6: Verify build passes**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus && npm run build
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus-web && npm run build
```

Expected: Both builds succeed with no errors.

- [ ] **Step 7: Run tests**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus && npx vitest run --reporter=verbose 2>&1 | tail -20
```

Expected: All existing tests pass.

- [ ] **Step 8: Commit the merge**

```bash
git commit -m "merge: resolve conflicts with main (post #409, #397)"
```

---

## Phase 2: Review Fixes (4 parallel agents)

> **Parallelization:** Tasks 2A, 2B, 2C, 2D touch entirely different files and can be dispatched as parallel subagents. No shared state.

### Task 2A: Backend Security & Performance Fixes (api.ts)

**Priority:** HIGH — Issues #1 (Cypher injection), #2 (LOD threshold), #3 (count queries), #6 (content removal)

**Files:**
- Modify: `gitnexus/src/server/api.ts`

**Reference:** `executeParameterizedQuery` is defined in `gitnexus/src/core/lbug/lbug-adapter.ts:511-524`. It uses `conn.prepare(cypher)` + `conn.execute(stmt, params)`. Parameters use `$paramName` syntax. Supports scalar strings, arrays (with `IN $arr`), etc.

---

#### Issue #1: Fix Cypher Injection — Parameterize All String-Interpolated Queries

- [ ] **Step 1: Parameterize community expansion queries (~lines 551-603)**

Replace the 3 string-interpolated queries that use `groupLabel.replace(/'/g, "\\'")` with parameterized calls.

**Before (query 1 — node fetch):**
```typescript
const nodeRows = await executeQuery(`
  MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
  WHERE c.heuristicLabel = '${groupLabel.replace(/'/g, "\\'")}'
  RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
         n.startLine AS startLine, n.endLine AS endLine,
         labels(n)[0] AS nodeLabel
  LIMIT ${limit}
`);
```

**After:**
```typescript
const nodeRows = await executeParameterizedQuery(
  `MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
   WHERE c.heuristicLabel = $groupLabel
   RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
          n.startLine AS startLine, n.endLine AS endLine,
          labels(n)[0] AS nodeLabel
   LIMIT ${limit}`,
  { groupLabel },
);
```

**Before (query 2 — intra-group edges):**
```typescript
const relRows = await executeQuery(`
  MATCH (a)-[r:CodeRelation]->(b),
        (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(ca:Community),
        (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(cb:Community)
  WHERE ca.heuristicLabel = '${groupLabel.replace(/'/g, "\\'")}'
    AND cb.heuristicLabel = '${groupLabel.replace(/'/g, "\\'")}'
    AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
  RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence
`);
```

**After:**
```typescript
const relRows = await executeParameterizedQuery(
  `MATCH (a)-[r:CodeRelation]->(b),
        (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(ca:Community),
        (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(cb:Community)
   WHERE ca.heuristicLabel = $groupLabel
     AND cb.heuristicLabel = $groupLabel
     AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
   RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence`,
  { groupLabel },
);
```

**Before (query 3 — cross-group edges):**
```typescript
const crossRows = await executeQuery(`
  MATCH (a)-[r:CodeRelation]->(b),
        (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(ca:Community),
        (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(cb:Community)
  WHERE ca.heuristicLabel = '${groupLabel.replace(/'/g, "\\'")}'
    AND cb.heuristicLabel <> '${groupLabel.replace(/'/g, "\\'")}'
    AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
  RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, cb.heuristicLabel AS targetGroup
  LIMIT 500
`);
```

**After:**
```typescript
const crossRows = await executeParameterizedQuery(
  `MATCH (a)-[r:CodeRelation]->(b),
        (a)-[:CodeRelation {type: 'MEMBER_OF'}]->(ca:Community),
        (b)-[:CodeRelation {type: 'MEMBER_OF'}]->(cb:Community)
   WHERE ca.heuristicLabel = $groupLabel
     AND cb.heuristicLabel <> $groupLabel
     AND r.type <> 'MEMBER_OF' AND r.type <> 'STEP_IN_PROCESS'
   RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, cb.heuristicLabel AS targetGroup
   LIMIT 500`,
  { groupLabel },
);
```

- [ ] **Step 1b: Parameterize remaining expand-group queries (~line 492, ~line 618)**

The expand-group endpoint has additional injection sites beyond the 3 community queries above:

**File-path prefix filter (~line 492):**
```typescript
// Before:
WHERE n.filePath STARTS WITH '${prefix.replace(/'/g, "\\'")}'
// After — use executeParameterizedQuery with $prefix:
WHERE n.filePath STARTS WITH $prefix
```

**Expand-group total count query (~line 618):**
```typescript
// Before:
WHERE c.heuristicLabel = '${groupLabel.replace(/'/g, "\\'")}'
// After — same $groupLabel param as above:
WHERE c.heuristicLabel = $groupLabel
```

Apply the same `executeParameterizedQuery` pattern used in Step 1.

- [ ] **Step 2: Parameterize hierarchy drill-down queries (~lines 860-901)**

Replace all `safeParentId` string interpolation with `$parentId` parameter.

**Before:**
```typescript
const safeParentId = parentId.replace(/'/g, "\\'");
const countRows = await executeQuery(
  `MATCH (parent)-[r:CodeRelation]->(child)
   WHERE parent.id = '${safeParentId}' AND r.type IN ['CONTAINS', 'DEFINES']
   RETURN count(child) AS total`
);
```

**After:**
```typescript
const countRows = await executeParameterizedQuery(
  `MATCH (parent)-[r:CodeRelation]->(child)
   WHERE parent.id = $parentId AND r.type IN ['CONTAINS', 'DEFINES']
   RETURN count(child) AS total`,
  { parentId },
);
```

Apply the same pattern to ALL queries in the hierarchy endpoint that use `safeParentId`:
- The group prefix query (`left(child.name, 2) AS prefix`)
- The parent type query (`MATCH (p) WHERE p.id = '${safeParentId}'`)
- The child rows query (main drill-down)
- The filtered count query (with namePrefix)

For the `namePrefix` filter (`safePrefixFilter`), also parameterize:

**Before:**
```typescript
const safePrefixFilter = namePrefix
  ? ` AND child.name STARTS WITH '${namePrefix.replace(/'/g, "\\'")}'`
  : '';
```

**After:**
```typescript
const prefixFilter = namePrefix ? ' AND child.name STARTS WITH $namePrefix' : '';
// ... then in each query that uses it, include namePrefix in the params object:
const params: Record<string, any> = { parentId };
if (namePrefix) params.namePrefix = namePrefix;
```

Remove the `safeParentId` variable entirely — it's no longer needed.

- [ ] **Step 2b: Parameterize hierarchy node-detail and ancestor queries (~lines 938, 965)**

Two additional injection sites in the hierarchy endpoint area:

**Node detail query (~line 938):**
```typescript
// Before:
const safeNodeId = nodeId.replace(/'/g, "\\'");
// ... WHERE p.id = '${safeNodeId}'
// After — use $nodeId param:
await executeParameterizedQuery(
  `MATCH (p) WHERE p.id = $nodeId RETURN ...`,
  { nodeId },
);
```

**Ancestor walk loop (~line 965):**
```typescript
// Before:
const safeCurrentId = currentId.replace(/'/g, "\\'");
// ... WHERE child.id = '${safeCurrentId}'
// After — use $currentId param:
await executeParameterizedQuery(
  `MATCH (parent)-[r:CodeRelation]->(child) WHERE child.id = $currentId AND r.type IN ['CONTAINS', 'DEFINES'] RETURN ...`,
  { currentId },
);
```

Remove `safeNodeId` and `safeCurrentId` variables.

- [ ] **Step 3: Verify no string-interpolated user input remains**

```bash
cd /Users/danielnicusornaicu/private/GitNexus
grep -n "replace(/'/g" gitnexus/src/server/api.ts
```

Expected: No matches (all replaced with parameterized queries).

---

#### Issue #2: Fix LOD Mode Threshold Mismatch

- [ ] **Step 4: Align thresholds with NODE_HARD_CAP**

Find the line (currently ~335):
```typescript
const mode = (totalNodes > 100000) ? 'hierarchy' : (totalNodes > 50000) ? 'summary' : 'full';
```

**Replace with:**
```typescript
const mode = (totalNodes > 50000) ? 'hierarchy' : (totalNodes > NODE_HARD_CAP) ? 'summary' : 'full';
```

This ensures:
- `> 50K` → hierarchy (cluster-level view)
- `> 20K (NODE_HARD_CAP)` → summary (prevents silent truncation)
- `<= 20K` → full (no truncation)

---

#### Issue #3: Eliminate Extra Count Queries in buildGraph

- [ ] **Step 5: Combine count with data fetch**

In `buildGraph`, replace the two-step pattern (fetch data + count) with a single query per table.

**Before (~lines 74-80 inside the for loop):**
```typescript
const rows = await executeQuery(query);
// ... process rows ...
remaining -= rows.length;

// Count total available for this table
try {
  const countRows = await executeQuery(`MATCH (n:${table}) RETURN count(n) AS cnt`);
  totalAvailable += countRows[0]?.cnt ?? rows.length;
} catch {
  totalAvailable += rows.length;
}
```

**After:** Track `prevRemaining` before the fetch. Only fire the count query if we actually hit the LIMIT (i.e., the table may have more rows than we fetched). Note: `${table}` comes from the hardcoded `NODE_TABLES` array, not user input, so it's safe to interpolate.

```typescript
const prevRemaining = remaining;
const rows = await executeQuery(query);
// ... process rows ...
remaining -= rows.length;

// Only count if we hit the limit (rows.length >= prevRemaining means table may have more)
if (rows.length >= prevRemaining) {
  try {
    const countRows = await executeQuery(`MATCH (n:${table}) RETURN count(n) AS cnt`);
    totalAvailable += countRows[0]?.cnt ?? rows.length;
  } catch {
    totalAvailable += rows.length;
  }
} else {
  // Got all nodes of this type — no extra query needed
  totalAvailable += rows.length;
}
```

This skips the count query for tables where we got all nodes (the common case for most of the ~12 table types).

---

#### Issue #6: Remove n.content from Graph Queries

- [ ] **Step 6: Strip content from buildGraph queries**

In `buildGraph`, remove `n.content AS content` from all node queries. The graph visualization never uses content — it's only needed for chat/search.

**File query — before:**
```typescript
query = `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content LIMIT ${remaining}`;
```

**After:**
```typescript
query = `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath LIMIT ${remaining}`;
```

**Generic symbol query — before:**
```typescript
query = `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content LIMIT ${remaining}`;
```

**After:**
```typescript
query = `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine LIMIT ${remaining}`;
```

Also remove `content` from the properties mapping below:
```typescript
// Remove this line from the properties object:
content: row.content,
```

- [ ] **Step 7: Build and verify**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus && npm run build
```

Expected: Build succeeds. If any code references `node.properties.content` from graph data, it will need a separate fetch — but the graph endpoints don't serve content to the visualization layer.

- [ ] **Step 8: Commit**

```bash
cd /Users/danielnicusornaicu/private/GitNexus
git add gitnexus/src/server/api.ts
git commit -m "fix: address PR #362 review — parameterize Cypher queries, fix LOD thresholds, optimize buildGraph

- Replace all string-interpolated Cypher with executeParameterizedQuery (injection fix)
- Align LOD mode thresholds with NODE_HARD_CAP (20K) to prevent silent truncation
- Skip count queries for non-truncated tables in buildGraph
- Remove n.content from graph visualization queries (bandwidth optimization)"
```

---

### Task 2B: Fix O(n) getVisibleNodeCount (hierarchy-graph-adapter.ts)

**Priority:** LOW — Issue #4

**Files:**
- Modify: `gitnexus-web/src/lib/hierarchy-graph-adapter.ts`

- [ ] **Step 1: Replace O(n) iteration with graph.order**

The reviewer noted that `getVisibleNodeCount` iterates all nodes to count visible ones, but in the hierarchy view nearly all nodes are visible (hidden nodes are rare). `graph.order` returns total node count in O(1).

However, if hidden nodes DO exist, `graph.order` would overcount. The safer fix: since `wouldExceedBudget` is a conservative check (it's OK to slightly overestimate), using `graph.order` as an upper bound is correct — it prevents expansion when we're near the budget, which is the desired behavior.

**Before:**
```typescript
export function getVisibleNodeCount(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
): number {
  let count = 0;
  graph.forEachNode((_, attrs) => {
    if (!attrs.hidden) count++;
  });
  return count;
}
```

**After:**
```typescript
export function getVisibleNodeCount(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
): number {
  // graph.order is O(1) — safe upper bound since hidden nodes are rare in hierarchy view
  return graph.order;
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus-web && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /Users/danielnicusornaicu/private/GitNexus
git add gitnexus-web/src/lib/hierarchy-graph-adapter.ts
git commit -m "perf: use graph.order for O(1) visible node count in hierarchy adapter"
```

---

### Task 2C: Document useMemo Re-render Trade-off (useAppState.tsx)

**Priority:** LOW — Issue #5

**Files:**
- Modify: `gitnexus-web/src/hooks/useAppState.tsx`

- [ ] **Step 1: Add documentation comment above the useMemo composition**

The reviewer noted that splitting into 6 hooks improves maintainability but doesn't improve re-render performance because they're re-composed into a single object. Components that need perf can import sub-hooks directly.

Find the `useMemo` block (currently ~line 210) and add a comment above it:

```typescript
// NOTE: This composed value re-creates when ANY sub-hook state changes, so all
// useAppState() consumers re-render together. For render-critical components,
// import the specific sub-hook directly (e.g., useGraphState, useFilterState)
// to subscribe only to the state slice you need.
const value: AppState = useMemo(() => ({
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus-web && npm run build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /Users/danielnicusornaicu/private/GitNexus
git add gitnexus-web/src/hooks/useAppState.tsx
git commit -m "docs: document useMemo composition re-render trade-off in useAppState"
```

---

### Task 2D: Extract Shared Edge Aggregation Helper (graph-summary.ts)

**Priority:** LOW — Minor note (duplicate code)

**Files:**
- Modify: `gitnexus/src/core/ingestion/graph-summary.ts`

- [ ] **Step 1: Extract shared helper function**

Both `generateGraphSummary` (~lines 112-145) and `generateStructuralSummary` (~lines 256-291) have nearly identical edge aggregation logic. Extract a shared helper.

Add this helper function before both callers:

```typescript
interface InterGroupEdgeAggregation {
  sourceGroupId: string;
  targetGroupId: string;
  count: number;
  types: Record<string, number>;
}

function aggregateInterGroupEdges(
  graph: { forEachRelationship: (cb: (rel: { type: string; sourceId: string; targetId: string }) => void) => void },
  nodeToGroup: Map<string, string>,
  resolveGroupId?: (groupKey: string) => string | undefined,
): InterGroupEdgeAggregation[] {
  const edgeKey = (src: string, tgt: string) => `${src}|||${tgt}`;
  const interGroupMap = new Map<string, { count: number; types: Record<string, number> }>();

  graph.forEachRelationship(rel => {
    if (rel.type === 'MEMBER_OF' || rel.type === 'STEP_IN_PROCESS') return;

    const srcGroupKey = nodeToGroup.get(rel.sourceId);
    const tgtGroupKey = nodeToGroup.get(rel.targetId);
    if (!srcGroupKey || !tgtGroupKey || srcGroupKey === tgtGroupKey) return;

    const srcGroupId = resolveGroupId ? resolveGroupId(srcGroupKey) : srcGroupKey;
    const tgtGroupId = resolveGroupId ? resolveGroupId(tgtGroupKey) : tgtGroupKey;
    if (!srcGroupId || !tgtGroupId) return;

    const key = edgeKey(srcGroupId, tgtGroupId);
    const existing = interGroupMap.get(key);
    if (existing) {
      existing.count++;
      existing.types[rel.type] = (existing.types[rel.type] || 0) + 1;
    } else {
      interGroupMap.set(key, { count: 1, types: { [rel.type]: 1 } });
    }
  });

  const edges: InterGroupEdgeAggregation[] = [];
  for (const [key, data] of interGroupMap) {
    const [src, tgt] = key.split('|||');
    edges.push({ sourceGroupId: src, targetGroupId: tgt, count: data.count, types: data.types });
  }
  edges.sort((a, b) => b.count - a.count);
  return edges;
}
```

- [ ] **Step 2: Replace both call sites**

In `generateGraphSummary` (~line 112), replace the entire block with:
```typescript
const interGroupEdges = aggregateInterGroupEdges(graph, nodeToGroup);
```

In `generateStructuralSummary` (~line 256), replace the entire block with:
```typescript
const interGroupEdges = aggregateInterGroupEdges(
  graph,
  nodeToGroup,
  (groupKey) => groupKeyToId.get(groupKey),
);
```

- [ ] **Step 3: Build and verify**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus && npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Run tests**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus && npx vitest run --reporter=verbose 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/danielnicusornaicu/private/GitNexus
git add gitnexus/src/core/ingestion/graph-summary.ts
git commit -m "refactor: extract shared edge aggregation helper in graph-summary.ts"
```

---

## Phase 3: Final Verification (sequential, blocking)

### Task 3: Build, Test, and Validate

- [ ] **Step 1: Full build**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus && npm run build
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus-web && npm run build
```

Expected: Both succeed.

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/danielnicusornaicu/private/GitNexus/gitnexus && npx vitest run --reporter=verbose 2>&1 | tail -30
```

Expected: All tests pass (2747+ tests).

- [ ] **Step 3: Verify no remaining Cypher injection patterns**

```bash
grep -n "replace(/'/g" gitnexus/src/server/api.ts
grep -n "safeParentId\|safePrefixFilter" gitnexus/src/server/api.ts
```

Expected: No matches.

- [ ] **Step 4: Verify content removed from graph queries**

```bash
grep -n "n\.content" gitnexus/src/server/api.ts
```

Expected: No matches in `buildGraph` function. May still exist in other endpoints that intentionally serve content (e.g., file detail endpoint) — that's fine.

---

## Phase 4: GitNexus PR Review (sequential, final gate)

### Task 4: Run gitnexus-pr-review Skill

**Context:** Before pushing, run the `gitnexus-pr-review` skill (`.claude/skills/gitnexus/gitnexus-pr-review/SKILL.md`) to perform a blast-radius and risk assessment using the code intelligence graph. This catches any missed breaking changes that the manual review might not cover.

**Prerequisite:** The GitNexus index must be fresh. After the Phase 1 merge commit + Phase 2 fix commits, the index is stale.

- [ ] **Step 1: Re-index the repo**

```bash
cd /Users/danielnicusornaicu/private/GitNexus
npx gitnexus analyze
```

Expected: Index rebuilt with updated symbols and relationships.

- [ ] **Step 2: Launch a PR review agent**

Dispatch a subagent that follows the `gitnexus-pr-review` skill workflow:

```
1. git diff main...HEAD --stat                        → See all changed files
2. gitnexus_detect_changes({scope: "compare", base_ref: "main"})
   → Map diff to affected execution flows and symbols
3. For each non-trivial changed symbol:
   gitnexus_impact({target: "<symbol>", direction: "upstream"})
   → Blast radius per change
4. gitnexus_context({name: "<key symbol>"})
   → Understand callers/callees of critical changed functions
5. Check if affected processes have test coverage
6. Produce review summary with risk assessment
```

The agent should output a structured review:

```markdown
## PR Review: LOD Graph Rendering + Review Fixes

**Risk: LOW / MEDIUM / HIGH / CRITICAL**

### Changes Summary
- N symbols changed across M files
- P execution flows affected

### Findings
1. **[severity]** Description
   - Evidence from GitNexus tools

### Missing Coverage
- Callers not updated: ...
- Untested flows: ...

### Recommendation
APPROVE / REQUEST CHANGES / NEEDS DISCUSSION
```

- [ ] **Step 3: Act on findings**

If the review surfaces HIGH/CRITICAL risk or unaddressed d=1 callers:
- Fix the issues before pushing
- Re-run `gitnexus_detect_changes()` to confirm

If APPROVE or LOW/MEDIUM with no breakage:
- Proceed to push

- [ ] **Step 4: Push and comment on PR**

```bash
git push origin pr/performance-lod-rendering
```

Comment on PR #362 with a summary of all changes made:
```bash
gh pr comment 362 --repo abhigyanpatwari/GitNexus --body "Addressed all review findings from the performance review:

1. **Cypher injection fixed** — All string-interpolated queries replaced with executeParameterizedQuery
2. **LOD threshold aligned** — Mode selection now matches NODE_HARD_CAP (20K)
3. **Count query optimization** — Skip count queries for non-truncated tables
4. **getVisibleNodeCount** — O(1) via graph.order
5. **useMemo trade-off documented** — Comment added about re-render behavior
6. **Content removed from graph payload** — n.content stripped from buildGraph queries
7. **Edge aggregation DRY** — Extracted shared helper in graph-summary.ts
8. **Merge conflicts resolved** — Merged main (post #409, #397)

GitNexus PR review: [risk level] — [summary]"
```

---

## Parallel Execution Map

```
Phase 1 (sequential):
  Task 1: Merge conflicts ────────────────────────────┐
                                                       │
Phase 2 (parallel after Phase 1):                      ▼
  ┌─────────────────────────────────────────────────────┐
  │  Agent A: api.ts security + perf (Issues #1,2,3,6) │
  │  Agent B: hierarchy-graph-adapter.ts (Issue #4)     │ ← all 4 run in parallel
  │  Agent C: useAppState.tsx docs (Issue #5)           │
  │  Agent D: graph-summary.ts DRY (minor note)        │
  └─────────────────────────────────────────────────────┘
                          │
Phase 3 (sequential):     ▼
  Task 3: Build + test ───────────────────────────────┐
                                                       │
Phase 4 (sequential):                                  ▼
  Task 4: gitnexus analyze → PR review agent → push ── Done
```

## Issue-to-Task Mapping

| Review Issue | Severity | Task | Status |
|---|---|---|---|
| Merge conflicts | Blocking | 1 | |
| #1 Cypher injection | Medium | 2A Steps 1-2b | |
| #2 LOD threshold mismatch | High | 2A Step 4 | |
| #3 Extra count queries | Medium | 2A Step 5 | |
| #4 O(n) getVisibleNodeCount | Low | 2B Step 1 | |
| #5 useMemo re-render docs | Low | 2C Step 1 | |
| #6 Content in graph payload | Medium | 2A Step 6 | |
| Duplicate edge aggregation | Minor | 2D Steps 1-2 | |
| GitNexus PR review | Final gate | 4 | |
