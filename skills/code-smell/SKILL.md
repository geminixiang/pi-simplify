---
name: code-smell
description: Find, verify, explain, and clean code smells using programmatic scanner leads plus agent review. Use when asked to find code smells, architecture smells, maintainability issues, complexity, duplication, coupling, state, error-handling, or performance smells.
---

# Code Smell

Use this skill when the user asks to find, review, or clean code smells, architecture smells, maintainability problems, or suspicious patterns.

## Goal

Find code whose structure will make future changes harder, then clean it with the smallest behavior-preserving edit.

## Workflow

1. Run programmatic checks first when the `code_smell_scan` tool is available.
2. Treat tool results as leads, not verdicts. Read the files and verify the smell.
3. Build a cause-effect chain before proposing a fix:
   - Root smell: what structure is wrong?
   - Evidence: where is it visible in code?
   - Impact: what gets worse if left alone?
   - Small fix: what is the next safe edit?
4. Prefer one small cleanup at a time. Run tests/type-checks after edits.
5. Skip smells whose fix requires a redesign unless the user explicitly asks for a larger refactor.

## Smell Families

- Complexity: long functions, deep nesting, branch-heavy flows, mixed responsibilities.
- Duplication: copy-paste blocks, repeated condition chains, repeated data mappings.
- Coupling: feature code imports internals, cross-layer reach-through, circular-feeling modules.
- State: redundant derived state, mutable globals, stale caches, multiple sources of truth.
- Errors: swallowed errors, empty catches, broad catch-and-ignore, inconsistent error mapping.
- Performance: N+1 loops, repeated I/O, sequential independent awaits, hot-path blocking work.
- Maintainability: debug remnants, commented-out code, TODO/HACK markers, stringly-typed constants.

## Discipline

Do not flag pure style preferences. A finding is valid only when the impact is concrete.
