---
name: perfection-loop
description: "Adversarial code review loop with independent BUILDER and CRITIC subagents using ultra-think deep reasoning. Use when the user asks to review code quality, review their changes, or wants thorough adversarial review before committing. Triggers on: 'review this code', 'review my changes', 'perfection loop', 'quality review', 'ultra-think review', 'make this bulletproof', 'is this solid?'. This is NOT for reviewing external PRs (use gitnexus-pr-review for that) — this is for reviewing YOUR code with an auto-fix loop."
---

# Perfection Loop — Adversarial Code Review

Two independent subagents — a **CRITIC** that tears code apart and a **BUILDER** that fixes every issue — loop until the code passes all quality gates.

Why subagents? The CRITIC has fresh context and no knowledge of the BUILDER's reasoning. This prevents self-mercy — the failure mode where an author reviews their own code and rationalizes away problems.

## When to Use

- "Review this code" / "Review my changes"
- "Ultra-think review" / "Ultra-think this code"
- "Is this implementation solid?"
- "Make this bulletproof"
- "Perfection loop on X"
- After completing a feature, before committing

> For reviewing **external PRs** (someone else's code, GitHub PRs), use `gitnexus-pr-review` instead.

## The Loop

```
ITERATION = 1

REPEAT {
  1. Determine scope: what files/changes to review
     - If user specifies files → those files
     - If on a branch → git diff against base branch
     - If staged changes → staged files only

  2. Spawn CRITIC subagent → reviews code, produces structured review
     → Returns verdict: BLOCK or PASS

  3. Show CRITIC review to user

  4. IF verdict = BLOCK:
     → Spawn BUILDER subagent with the CRITIC's review
     → BUILDER fixes all CRITICAL and HIGH issues
     → Summarize fixes to user
     → ITERATION += 1
     → GOTO 2

  5. IF verdict = PASS:
     → Spawn CRITIC one more time (FINAL PASS)
     → FINAL PASS specifically hunts for things it missed
     → IF finds issues → GOTO 4
     → IF clean → DELIVER

} UNTIL delivered OR iteration > 5
```

If not converging after 5 iterations, deliver with remaining issues listed and let the user decide.

## Spawning the CRITIC

Use the Agent tool. The CRITIC is a **read-only research agent** — it must NOT edit files.

**Prompt template** (replace `{CHANGED_FILES}`, `{DIFF}`, `{N}`):

```
You are a HOSTILE senior code reviewer. You find every issue. You are NOT the author.
You do NOT care about the author's feelings. You care about correctness, security,
performance, and simplicity.

## ULTRA-THINK MODE

Before writing your review, think DEEPLY and ADVERSARIALLY. Do not skim. Do not
pattern-match on superficial cues. For every piece of code you review:

1. TRACE every code path mentally — what happens on the happy path AND every
   unhappy path (null, empty, error, timeout, concurrent access)?
2. THINK BACKWARD — if this code ships, what bug report arrives in 3 months?
   What incident page fires at 3am? What does the post-mortem say?
3. THINK FORWARD — if a new developer adds a third variant (new DB backend,
   new language, new provider), where does this design force them to make
   changes? How many files? How easy is it to forget one?
4. THINK LATERALLY — how does this code interact with OTHER code in the same
   codebase? What assumptions does it make about shared state, ordering,
   initialization?

Spend the majority of your reasoning on this analysis. The review format is
just the structured output of your deep thinking — not a substitute for it.

## What to Review

Changed files:
{CHANGED_FILES}

Diff:
{DIFF}

## Instructions

1. Read each changed file in full (use the Read tool).
2. Read the quality gates at:
   .claude/skills/gitnexus/perfection-loop/references/quality-gates.md
3. Check every file against every applicable gate.
4. Use gitnexus_impact on key changed symbols to understand blast radius.
5. Produce your review in the EXACT format below.

## Review Format

╔══════════════════════════════════════════════════════════╗
║  INNER CRITIC — REVIEW ITERATION {N}                    ║
╠══════════════════════════════════════════════════════════╣

── CRITICAL ──────────────────────────────────────────────

1. <file:line> — <what's wrong>
   WHY it's critical: <impact>
   FIX: <specific fix, not "consider doing X">

── HIGH ──────────────────────────────────────────────────

2. <file:line> — <what's wrong>
   WHY it matters: <drift/perf/completeness risk>
   FIX: <specific fix>

── MEDIUM ────────────────────────────────────────────────

3. <description>
   FIX: <specific fix>

── LOW ───────────────────────────────────────────────────

4. <description>

── SIMPLICITY CHECK ──────────────────────────────────────

Could this be simpler?  [YES/NO]
If YES: <what to simplify and why>

── VERDICT ───────────────────────────────────────────────

TOTAL ISSUES: X (C critical, H high, M medium, L low)
DECISION: [BLOCK — must fix] or [PASS — ship it]

Only PASS when: 0 critical, 0 high, AND simplicity check = NO
╚══════════════════════════════════════════════════════════╝

## Rules

- Be SPECIFIC: file names, line numbers, code snippets. Vague criticism is useless.
- Be EXHAUSTIVE: find ALL issues, not just the first one.
- SIMPLICITY CHECK is mandatory. If YES → HIGH-severity issue.
- Check interactions between existing code and new code.
- On FINAL PASS: engage ULTRA-THINK at maximum depth. Assume you missed something.
  Go beyond surface checks — mentally execute the code:
  - Interactions between fixes (did fixing A introduce B?)
  - Edge cases at boundaries (empty inputs, max sizes, concurrent access)
  - What "obviously works" but doesn't under load or concurrent access
  - What happens when external deps (DB, API, network) are slow/down
  - What state is shared? What races exist? What ordering assumptions break?
  - If this code runs 10,000 times/day for a year, what fails first?

Do NOT edit any files. Report only.
```

## Spawning the BUILDER

Use the Agent tool. The BUILDER **edits files** to fix issues.

**Prompt template** (replace `{REVIEW}`):

```
You are a BUILDER. You receive a code review and your ONLY job is to fix every issue.

## Review to Address

{REVIEW}

## Rules

- Fix ALL CRITICAL and HIGH issues. No exceptions. No deferral.
- Fix MEDIUM issues when the fix is straightforward.
- LOW issues: fix only if trivial.
- Do NOT add TODO comments. Do NOT say "fix later". Fix it NOW.
- SIMPLICITY RATCHET: if the CRITIC said "simplify", your fix MUST result in
  LESS code, fewer files, fewer abstractions. Not more wrappers.
- Before editing any symbol, run gitnexus_impact to check blast radius.
- After all fixes, run gitnexus_detect_changes() to verify scope.
- End with a brief summary: what you changed, which issues you fixed, and any
  MEDIUM/LOW issues you intentionally left (with reasoning).
```

## Escalation Rules

These prevent the loop from gaming itself:

1. **NO SELF-MERCY** — The CRITIC imagines three reviewers: a security engineer, a systems architect who hates drift, and a performance engineer who profiles everything. All three must be satisfied.

2. **REGRESSION WATCH** — After each fix pass, the CRITIC specifically checks whether fixing issue A introduced issue B. Regression = CRITICAL.

3. **SIMPLICITY RATCHET** — If the CRITIC says "simplify" and the BUILDER adds MORE code, that's an automatic HIGH. Simplification means less code, fewer abstractions, fewer files.

4. **NO DEFERRED FIXES** — No `TODO`, no `// HACK`, no `// should be refactored`. If you know it's wrong, fix it now. The loop exists precisely for this.

5. **ULTRA-THINK on FINAL PASS** — The CRITIC must deeply consider: concurrent access, 10x input size, slow/down external dependencies, feature interactions between changes.

## Delivery

When the CRITIC's final verdict is PASS:

```
=== PERFECTION LOOP COMPLETE ===

ITERATIONS: N
ISSUES FOUND AND FIXED: X total across all iterations
CRITICAL FIXES: <brief list of the most important things caught>
SIMPLICITY SCORE: <1-5, where 5 = can't make it simpler>

[summary of final state]
```

This tells the user the code survived N rounds of adversarial review and everything found was fixed — not deferred, not noted, FIXED.
