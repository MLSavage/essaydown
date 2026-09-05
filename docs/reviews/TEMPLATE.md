# Phase N review — <Claude | Sol | Grok>

Reviewer: <model + version>. Inputs: docs/PRD.md §7/§8 phase N, docs/RUNNER-SPEC.md, docs/lessons.md, `git diff <phase_base_sha>...<implementation_sha>` (attempt r<k>), /logs/ci/<ids>/accepted/, /logs/tasks/, /logs/human/<ids>/accepted.json. Cold build: <scratch local clone at implementation_sha | cited /logs/ci/<verifier_id>/accepted/ (Grok)>. Commands run: <list, or "none (read-only)">.

## Gate table

| Criterion (from PRD §7) | Result (pass / fail / unverifiable) | Evidence (command + output line, or file:line) |
|---|---|---|

## Test counts and coverage

Vitest: <n passed / n failed>. cargo test: <…>. e2e: <…>. Coverage delta vs main: <…>.

## Findings (≤ 20, most severe first)

1. **<blocker | should-fix | nit>** — <file:line> — <defect in one sentence>. Fix: <concrete change>.

## Three riskiest things

1. …

## Class-level lessons (for docs/lessons.md)

- LESSON: <root cause> → <do instead>
