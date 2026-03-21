# Quality Gates

The CRITIC checks every applicable gate. CRITICAL and HIGH gates are blocking.

## Gate 1 — Backward Compatibility (CRITICAL)

- Existing code paths UNTOUCHED — new features are additive
- Old data/config formats still work (missing fields default gracefully)
- No function signatures changed without backward-compatible overload
- No existing imports/exports removed or renamed
- Regression test: "If I revert my diff, does the original build identically?"

## Gate 2 — Security (CRITICAL)

- NO string interpolation in queries (SQL, Cypher, GraphQL) — parameterized always
- Escaping correct for target dialect (Cypher: `''` not `\'`, SQL: prepared statements)
- No hardcoded secrets, credentials, or API keys
- User input validated/sanitized at every entry point
- Auth on every new endpoint
- Error messages don't leak internals (stack traces, DB schema, file paths)

## Gate 3 — Architectural Fit (HIGH)

- ONE dispatch layer — no duplicated dispatch across parallel code paths
- Interfaces enforced — every impl goes through the interface
- No copy-paste between modules — shared logic in one place
- No `if (isBackendX) ... else if (isBackendY)` in business logic — polymorphic dispatch
- Read AND write path go through the same abstraction
- Third-variant test: adding a new backend/provider/language touches ≤2 files

## Gate 4 — Completeness (HIGH)

- Every defined function is CALLED somewhere — no dead code
- Every code path is reachable
- Every feature described in comments actually works end-to-end
- Cache exists → invalidation wired up and called
- ALL endpoints correct for ALL config variants, not just the default
- Error paths produce useful, actionable messages — not empty arrays or silent catches

## Gate 5 — Performance (HIGH)

- No full-scan on large text fields (`CONTAINS` on source code = timeout)
- Batch sizes reasonable (not 25 when 100-250 works, not 10000 causing OOM)
- No per-request construction of expensive objects — reuse/pool
- Timeouts configured, timeout errors handled gracefully
- Index creation syntax compatible with target engine
- Parallelizable async ops use `Promise.all`, not sequential `await`

## Gate 6 — Simplicity (HIGH)

- No abstraction without at least 2 concrete users — don't pre-abstract
- Could achieve the same result with fewer files, classes, or indirections?
- Not building for a problem that doesn't exist yet (YAGNI)
- Every layer of indirection has a concrete benefit TODAY
- If asked "why is this abstracted?" there's a real answer beyond "it might be useful"

## Gate 7 — Type Safety & Clean Code (MEDIUM)

- No `as any` casts when a proper type exists
- No `(obj as unknown as {...})` hacks — expose proper public getters
- Private fields needing external access → public getter/property
- Parameters and return types explicitly typed
- No unused imports or variables
- Consistent naming conventions

## Gate 8 — Separation of Concerns (MEDIUM)

- Unrelated changes NOT bundled
- Each file has one clear responsibility
- UI components free of business logic
- Config separate from implementation
- Tests test ONE thing, named to match

## Gate 9 — UX & Observability (LOW)

- UI shows active backend/mode/state
- Loading, error, and empty states all handled
- Long operations have progress/status output
- Logs structured and useful

## Gate 10 — LLM/Agent Compatibility (LOW, skip if N/A)

- Tested with multiple LLM dialects (LLMs default to most popular syntax)
- Query error messages include fix hints for retry guidance
- Malformed LLM output handled gracefully (parse errors, wrong syntax)

---

## Anti-Patterns — Instant CRITICAL

If the CRITIC spots any of these, flag immediately:

| # | Anti-pattern | Example | Gate |
|---|---|---|---|
| 1 | Silent swallow | `.catch(() => [])`, empty `catch {}` | 4 |
| 2 | Duplicated dispatch | Same if/else branching in two files | 3 |
| 3 | Query interpolation | `` WHERE x = '${val}' `` | 2 |
| 4 | Dead exports | `export function X()` never imported | 4 |
| 5 | `as any` | Casting when proper type exists | 7 |
| 6 | Unrelated changes | Removing unrelated code in same PR | 8 |
| 7 | Partial coverage | Endpoint works for variant A, crashes on B | 4 |
| 8 | Per-request construction | `new DbAdapter()` in request handler | 5 |
| 9 | Full-scan text match | `CONTAINS` on source code, no size guard | 5 |
| 10 | Misleading comments | "critical for perf" but code silently fails | 4 |
| 11 | Premature abstraction | Interface with 1 impl, no plan for 2nd | 6 |
| 12 | Copy-paste adapter | `getDbConfigFromEntry()` duplicates `getDbConfig()` | 3 |
