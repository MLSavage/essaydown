# Phase N review — <Claude | Sol | Grok>

Reviewer: <model + version>. Inputs: docs/PRD.md §7/§8 phase N, docs/RUNNER-SPEC.md, docs/lessons.md, `git diff <phase_base_sha>...<implementation_sha>` (attempt r<k>), /logs/ci/<ids>/accepted/, /logs/tasks/, /logs/human/<ids>/accepted.json. Cold build: <scratch local clone at implementation_sha | cited /logs/ci/<verifier_id>/accepted/ (Grok)>. Commands run: <list, or "none (read-only)">.

## Gate table

| Criterion (from PRD §7) | Result (pass / fail / unverifiable) | Evidence (command + output line, or file:line) |
|---|---|---|

## Test counts and coverage

Vitest: <n passed / n failed>. cargo test: <…>. e2e: <…>. Coverage delta vs main: <…>.

## Findings (≤ 20, most severe first)

Severity, rated by the consequence for the gate's criterion and never by the size of the fix (DECISIONS #review-1-r1): **blocker** — a gate criterion is not met, or wrong output reaches the user silently (example: Copy Markdown puts stale text on the clipboard and reports "Copied"); **should-fix** — a defect or a missing guard the phase should not close with, while the criterion still holds or the path is not the gate's own instrument (example: a redo chord bound under two names with no test that reads the binding table, so deleting one name stays green); **nit** — wording, citations, style, or an assertion with no behaviour behind it (example: `expect(checked).toBe(Object.keys(index).length)` where both sides are the same list). Mark a should-fix **Required** when the reconciliation should fail without it.

1. **<blocker | should-fix | nit>** — <file:line> — <defect in one sentence>. Fix: <concrete change>.

## Three riskiest things

1. …

## Class-level lessons (for docs/lessons.md)

- LESSON: <root cause> → <do instead>
