# Type Resolution Roadmap

This roadmap describes the evolution of GitNexus's type-resolution layer from a receiver-disambiguation aid into a production-grade static-analysis foundation.

---

## Principles

- **stay conservative** — prefer missing a binding over introducing a misleading one
- **prefer explainable inference over clever but brittle inference**
- **limit performance overhead during ingestion**
- **keep per-language extractors explicit rather than over-generic**
- **separate "better receiver resolution" from "compiler-grade typing"**

The goal is not to build a compiler. The goal is to support high-value static analysis for call graphs, impact analysis, context gathering, and downstream graph features.

---

## Delivered Phases

### Phase 7: Cross-Scope and Return-Aware Propagation ✅

**Shipped in** `feat/phase7-type-resolution`.

- `ReturnTypeLookup` interface threading return-type knowledge into TypeEnv
- Iterable call-expression support across 7 languages (Go, TS, Python, Rust, Java, Kotlin, C#)
- PHP class-level `@var` property typing for `$this->property` foreach (Strategy C)
- `pendingCallResults` infrastructure (Tier 2b loop + `PendingAssignment` union) — activated by Phase 9

### Phase 8: Field and Property Type Resolution ✅

**Shipped in** `feat/phase8-field-property-type-resolution`.

- SymbolTable `fieldByOwner` index — O(1) field lookup by `ownerNodeId\0fieldName`
- `HAS_PROPERTY` edge type + `declaredType` on Property symbols
- Deep chain resolution up to 3 levels (`user.address.city.getName()`) across 10 languages
- Mixed field+method chains via unified `MixedChainStep[]` (`svc.getUser().address.save()`)
- Type-preserving stdlib passthroughs (`unwrap`, `clone`, `expect`, etc.)
- `ACCESSES` edge type — read/write field access tracking across 12 languages
- C++ `field_declaration` capture, `field_expression` receiver support
- Rust unit struct instantiation, Ruby YARD `@return` for `attr_accessor`

### Phase 9 + 9C: Return-Type-Aware Variable Binding ✅

**Shipped in** `feat/phase9-call-result-binding` (PR #379).

- Simple call-result binding: `const user = getUser(); user.save()` across 11 languages
- Unified fixpoint loop replacing sequential Tier 2b/2a — handles 4 binding kinds (`callResult`, `copy`, `fieldAccess`, `methodCallResult`) at arbitrary depth
- Field access binding: `const addr = user.address` resolves via `lookupFieldByOwner` + `declaredType`
- Method-call-result binding: `const city = addr.getCity()` resolves via `lookupFuzzyCallable` filtered by `ownerId`
- Fixpoint iterates until stable (max 10 iterations), enabling chains like `getUser() → .address → .getCity() → city.save()`
- Reverse-order copy chains now resolve (`const b = a; const a: User = x` → both resolve)

### Milestone D — Completeness ✅

**Shipped in** `feat/type-resolution-milestone-d` (PR #387). Consolidated original Phases 10–13 into 3 balanced phases.

#### Phase A: Fixpoint Completeness ✅

- Post-fixpoint for-loop replay (ex-9B): `pendingForLoops` collection + replay after fixpoint resolves iterable types
- Object destructuring via `fieldAccess` items (TS/JS `object_pattern`, Rust `struct_pattern`) — no new `destructure` PendingAssignment variant needed
- Extracted `resolveFixpointBindings()` helper with exhaustive switch + `classDefCache` memoization

#### Phase B: Inheritance & Receivers ✅

- `BuildTypeEnvOptions` interface replacing positional params for `buildTypeEnv`
- Heritage pre-pass constructing `parentMap` from tree-sitter query matches (not graph edges — heritage-processor runs in parallel)
- MRO-aware `walkParentChain()` (depth 5, cycle-safe BFS) for `resolveFieldType` and `resolveMethodReturnType`
- `this`/`self`/`$this`/`Me` receiver substitution via `substituteThisReceiver` hook
- Go `inc_statement`/`dec_statement` write-access queries

#### Phase C: Branch-Sensitive Narrowing ✅

- Null-check narrowing (`!= null`, `!== undefined`, `is not null`) via position-indexed `patternOverrides`
- Supported for TS, Kotlin, C# — renamed `PATTERN_BRANCH_TYPES` → `NARROWING_BRANCH_TYPES`
- Bug fix: Kotlin narrowing required 3 fixes in `jvm.ts` (AST node type `equality_expression`, anonymous `null` node, `nullable_type` parameter fallback)

#### Deferred from Milestone D

- **Type predicates (13A):** Cross-function analysis for niche TS `x is User` feature — deferred
- **Swift parity (11D):** tree-sitter-swift Node 22 issues — all Swift work consolidated to Phase S
- **Positional destructuring (12C):** Python/Kotlin/C#/C++ tuple-position-to-field mapping — deferred
- **Discriminated union narrowing (13C):** Needs tagged union metadata not in SymbolTable — deferred

#### Integration Test Coverage

17 fixture directories, 23 describe blocks, 705 lines of test code covering all 11 languages:
- Grandparent MRO (depth-2 C→B→A): TS, JS, Kotlin, C#, C++, Java, PHP, Python, Ruby
- Object destructuring: TS, JS
- Struct destructuring: Rust
- Post-fixpoint for-loop replay: TS, JS
- Go inc/dec write access
- Null-check narrowing: TS, C#, Kotlin

---

## Open Phases

### Phase P: Polymorphism & Overloading

**Plan:** `docs/plans/2026-03-19-feat-polymorphism-overloading-type-resolution-plan.md`

Four incremental phases:
1. **Parameter type metadata** — extend `SymbolDefinition` with `parameterTypes: string[]` extracted during parsing
2. **Overload disambiguation** — filter overloaded methods by argument literal types at call sites
3. **Constructor-visible virtual dispatch** — `Base b = new Derived(); b.method()` resolves to `Derived#method` when constructor type is a known subclass
4. **Covariant return type awareness** — prefer child's return type over inherited definition

Languages benefiting: Java, Kotlin, C#, C++, TypeScript (overloading). All OOP languages (virtual dispatch).

**Impact: High | Effort: High**

---

### Phase S: Swift Parity

**Blocked on** tree-sitter-swift Node 22 compatibility.

- For-loop element binding (from Phase 10)
- Assignment chains: copy, callResult, fieldAccess, methodCallResult (from Phase 11D)
- `guard let` narrowing (from Phase 13B) — uses scopeEnv path, not `patternOverrides`

**Impact: Medium | Effort: Medium**

---

### Phase 14: Cross-File Binding Propagation

**Problem:** `buildTypeEnv` is per-file. Inferred types don't cross file boundaries.

```typescript
// file-a.ts — fixpoint resolves: config → Config
export const config = getConfig();

// file-b.ts — config has no type
import { config } from './file-a';
config.validate();  // missed
```

**Approach: Export-type index.** After each file's fixpoint, export resolved bindings for exported symbols into `ExportedBindings: Map<filePath, Map<symbolName, typeName>>`. Subsequent files seed scopeEnv from this index for imported symbols.

**Details:**
- Process files in topological import order (import-processor already builds the dependency graph)
- Re-exports: follow import chain transitively in `ExportedBindings`
- Barrel files (`index.ts`): chain of re-exports — same mechanism
- Default exports: keyed as `"default"` in the map, mapped to local name at import site
- Dynamic imports (`import()`, conditional `require()`): excluded — runtime-only edges
- Circular imports: files in a cycle processed in arbitrary order within the cycle; cross-cycle bindings don't propagate (conservative)
- Parallelism preserved within topological levels

**Why this is last:** Every earlier phase makes the per-file fixpoint stronger, reducing cases where cross-file propagation is needed. This is also the highest-risk architectural change.

**Risks:** Topological ordering correctness (mitigated by reusing import-processor's existing graph). Re-export chain depth (bounded by import depth, typically 2-3). Memory for `ExportedBindings` (~100K entries for 10K-file monorepo — negligible).

**Impact: High | Effort: High**

---

## Dependency Graph

```
Milestone D (Phases A, B, C) ✅ ──┐
                                   ├──→ Phase 14 (cross-file)
Phase P (polymorphism) ───────────┤
                                   │
Phase S (Swift parity) ───────────┘

Phase P and Phase S are independent of each other and Phase 14.
Phase 14 benefits from Phase P (better per-file resolution = fewer cross-file gaps).
```

---

## Language-Specific Gaps (remaining)

### Swift
- For-loop element binding → Phase S
- Assignment chains (copy, callResult, fieldAccess, methodCallResult) → Phase S
- `guard let` narrowing → Phase S

### All languages
- Cross-file binding propagation → Phase 14

---

## Milestones

### Milestone A — Inference Expansion ✅ (Phase 7)

Loop inference, `ReturnTypeLookup`, PHP Strategy C.

### Milestone B — Structural Member Typing ✅ (Phase 8)

Field/property maps, deep chains, mixed chains, stdlib passthroughs.

### Milestone C — Static-Analysis Foundation ✅ (Phase 9 + 9C)

Unified fixpoint loop, call-result binding, field access binding, method-call-result binding, arbitrary-depth chain propagation.

### Milestone D — Completeness ✅ (Phases A, B, C)

Consolidated Phases 10–13 into 3 balanced phases. Loop-fixpoint bridge, MRO-aware inheritance walking, `this`/`self` resolution, object/struct destructuring, null-check narrowing. Kotlin null-check bug fix. Full 11-language integration test coverage.

### Milestone E — Cross-Boundary ← **next** (Phase 14)

Export-type index, cross-file binding propagation.

### Milestone P — Polymorphism & Overloading (Phase P)

Parameter type metadata, overload disambiguation, constructor-visible virtual dispatch, covariant return types.

### Milestone S — Swift Parity (Phase S)

For-loop binding, assignment chains, `guard let` narrowing. Blocked on tree-sitter-swift Node 22.

---

## Open Design Questions

| # | Question | Status |
|---|----------|--------|
| 1 | Where should field-type metadata live? | ✅ Resolved: `fieldByOwner` index in SymbolTable |
| 2 | How should ambiguity be represented? | ✅ Resolved: keep `undefined`. Conservative approach proven through 9 phases. |
| 3 | How much receiver context for return types? | ✅ Resolved: Phase 9C `resolveMethodReturnType` filters by `ownerId`. |
| 4 | How much branch sensitivity? | ✅ Resolved: type predicates + null checks only. No control-flow graph. (Phase 13) |
| 5 | Field typing and chain typing — one phase or two? | ✅ Resolved: incremental delivery within phases (Phase 8/8A precedent). |
| 6 | Phase 9B vs Phase 10? | ✅ Resolved: Phase 10 supersedes 9B via post-fixpoint replay. |

---

## What "Production-Grade" Means Here

For GitNexus, production-grade does **not** mean replacing a language compiler. The target:

- Strong receiver-constrained call resolution across common language idioms
- Reliable handling of typed loops, constructors, and common patterns
- Return-type propagation for service/repository code
- Field/property knowledge for chained-member analysis
- Inheritance-aware lookups
- Conservative behavior under ambiguity
- Predictable performance during indexing

That supports: better call graphs, more accurate impact analysis, stronger AI context assembly, more trustworthy graph traversal.

---

## Summary

**Complete:** Phases 7, 8, 9, 9C, Milestone D (A, B, C) — explicit types, constructor inference, loop inference, field/property resolution, deep chains, mixed chains, stdlib passthroughs, comment-based types, unified fixpoint with 4 binding kinds, arbitrary-depth chain propagation, MRO-aware inheritance walking, this/self resolution, object/struct destructuring, null-check narrowing — across 11 languages with full integration test coverage.

**Next:** Phase 14 (cross-file binding propagation) — the architectural capstone. Phase S (Swift parity) is independent and unblocked once tree-sitter-swift Node 22 is resolved.
