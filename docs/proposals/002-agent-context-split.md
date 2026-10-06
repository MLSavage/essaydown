# Proposal 002 — split the agent rules by role and by path (advisor draft v1, 2026-10-05)

Status: **accepted with the principal's seven revisions (§7), Michael 2026-10-05; lands at the Phase 3→4 boundary, after `3.close`.** Written by Michael's outside advisor session and audited by the principal against RUNNER-SPEC and the runner code. §7 binds wherever it differs from §1–§6, and the landing commit applies §7 to the drafts as it copies them to their live paths. The drafts are preserved, unapplied, under `docs/proposals/002/` and renamed so that no file outside the root is named `CLAUDE.md` or `AGENTS.md`, because Claude Code auto-loads a `CLAUDE.md` in any folder an agent reads: `CLAUDE.proposed.md`, `AGENTS.proposed.md`, `PROMPT.proposed.md` (→ `ralph/PROMPT.md`), `markdown-roundtrip.proposed.md` (→ `docs/rules/markdown-roundtrip.md`), `PRINCIPAL-addition.proposed.md` (→ a section of `docs/PRINCIPAL.md`). The drafts' text is the advisor's v1; nothing in them is live. Every line number cites the tree at `ac3aac7` (phase/3).

## 1. The problem, measured

`wc -w` at `ac3aac7`: `CLAUDE.md` 2,628 words, of which `## Code rules` is 1,692 across 33 bullets. 16 of those bullets cite a Phase 1 review id (`#review-1-r4` … `r9`, `#022`) and govern one domain: the Markdown serializer, the editor tree, the position/cursor map and caret placement in e2e. Every agent loads the whole file: task agents (Claude Code auto-loads it at the worktree root), the Claude reviewer (auto-load at `/snapshot`), Sol (Codex reads `AGENTS.md`), Grok (its entrypoint names `CLAUDE.md` in its drift lane), the principal and the advisor session. A Rust rename task in Phase 3 reads 1,100 words about UTF-16 surrogates and delimiter runs. The cost is attention, not tokens: rules that matter for a task are diluted by rules that cannot apply to it.

Two structural duplications compound it:

- **The iteration steps exist twice.** `CLAUDE.md` `## Every iteration` (lines 20–27) and `ralph/PROMPT.md` `## Iteration` hold the same six steps, and a task agent receives both. The duplication has already failed once: the wrapper drifted from `CLAUDE.md` at `1.verify.r2.g1` (lessons `[1.verify.r2.g1]` ×2; #review-1-r2 H7), and the repair added machinery to keep the copies equal (`ralph/test/conformance.test.mjs:856`). Within that, the lesson-[1.29] sentence appears in both step 2 and step 4 of both files: four copies in a task agent's context.
- **Planning facts sit in the rules every agent reads.** Lines 67 (second clause), 68 and 69 describe how dependencies, retries and plan requests resolve. Only the principal acts on them.

`BUILD-DEFAULTS.md:128` already holds a pressure valve that was never used: "Rules untriggered for a phase demote back." By that rule, the Phase 1 serializer rules (untriggered through Phase 2) would demote to lessons. Demoting is wrong now, because Phase 3 tasks 3.12–3.16 are serializer fixes. Scoping them by path keeps them binding where they apply and silent where they cannot.

## 2. The design: three layers

| Layer | File | Who reads it | What it holds |
|---|---|---|---|
| 0, everyone | `CLAUDE.md` ≡ `AGENTS.md` | every agent | what the project is, non-negotiables, a `## Read next` routing section, container facts, rules that apply anywhere, two runner facts |
| 1, by role | `ralph/PROMPT.md` (task agents), entrypoint prompts (reviewers), `docs/PRINCIPAL.md` (principal) | that role only | the role's procedure; each file already exists and is already that role's input |
| 2, by path | `docs/rules/markdown-roundtrip.md` | any agent that changes or reviews files under its paths | the domain's rules, moved verbatim |

No new role file is created. Layer 1 is three files the runner already hands to each role; the proposal makes each the single copy of its role's procedure. Layer 2 starts with one file because one domain has accumulated rules. A second appears only when a second domain accumulates them (§6 Q3).

**Why routing by an explicit pointer and not nested `CLAUDE.md` files.** Claude Code loads a subfolder's `CLAUDE.md` when it reads a file in that folder. Two facts make that the wrong mechanism here. (1) The domain does not follow folders: the serializer and the position map are `packages/core/src/format.ts` and `positions.ts`, beside `assets.ts`, `settings.ts` and `undo.ts`, which are not in the domain; `packages/editor/CLAUDE.md` would miss both. (2) Codex (Sol) merges `AGENTS.md` files from the repo root down to its working directory only (`-C /snapshot`), so a nested file never reaches it. A nested file would also need its own twin and its own identity check. One explicit pointer in layer 0 reaches every tool the same way. *Principal: confirm (2) against the Codex version in `docker/versions.env`.*

## 3. File by file

### 3.1 `CLAUDE.md` / `AGENTS.md`: 2,628 → 1,180 words (−55%)

| Section at ac3aac7 | Disposition | Reason |
|---|---|---|
| Line 3, intro | Rewritten: what the project is and that the rules outrank task text. "Hands you exactly one task id; you never pick another" moves to PROMPT.md, which already says it (its line 3) | The sentence spoke to a task agent; reviewers and the principal read it as addressed to them |
| Non-negotiables, lines 5–12 | Unchanged | Everyone, always |
| — | **New `## Read next`**: by role (PROMPT.md / entrypoint / PRINCIPAL.md); by path (the domain file and its trigger paths) | The one routing point; §2 says why it is explicit |
| Where you are, line 16 | Split: the worktree and branch half dropped (PROMPT.md line 3 has it); the `/logs` read-only and host-checkout halves kept, widened to "your own transcript or report" | Reviewers write a report, not a transcript |
| Where you are, line 17 (orientation order) | Dropped; PROMPT.md `## Orientation` is the copy | Task-agent procedure, duplicated |
| Where you are, line 18 (toolchain, Linux) | Kept | Reviewers' cold builds run in the container too |
| Line 37, long-command rule (#049) | Moved out of `## Code rules` into the renamed `## The container`, verbatim | It is about how an agent runs commands, not about the code. Kept in layer 0 because a reviewer's cold build loses its work the same way |
| Every iteration, lines 20–27 | **Removed**; PROMPT.md holds the only copy | §1; removes the drift class H7 had to guard by test |
| Code rules: 15 general rules | Stay. Two edited (§3.4) | Apply anywhere |
| Code rules: 16 domain rules | Moved verbatim to the domain file. One rule split (§3.4) | §1 |
| Runner facts, lines 67 (first clause) and 70 | Stay, wording unchanged | Every agent needs them |
| Runner facts, lines 67 (second clause), 68, 69 | Moved verbatim to PRINCIPAL.md | Planning facts |

### 3.2 `docs/rules/markdown-roundtrip.md`: new, 1,119 words

Trigger paths: `packages/core/src/{parse,format,positions}.ts`, `packages/editor/`, `packages/modes/`, `fixtures/markdown/`, `e2e/`. `packages/modes/` is in because line 44 names "a mode operation's result" as a writing surface, so the Phase 3 mode tasks are in the domain by the rule's own words. `e2e/` is in because the caret rule (line 47) governs every spec that places a caret, shell or web.

Sections and the source lines each holds: *Round-trip families*: 44, line 46's second clause, 60. *Serializer handlers, marks and delimiter runs*: 48–52, 54–55. *Position and cursor maps*: 53, 56–59. *Caret placement in e2e*: 47. A script check over the drafts: each of the 33 source bullets appears exactly once across the two files, except the three edited in §3.4.

### 3.3 `ralph/PROMPT.md`: 685 → 608 words

- **Iteration steps become the only copy.** Line 24's cross-reference is replaced with "These steps are the only copy." Two clauses that existed only in `CLAUDE.md` are carried over so nothing is lost: step 1 "the runner rebases once, at integration" and step 6 "The runner squashes your branch…". The duplicated lesson-[1.29] sentence is cut from step 2 and kept in step 4, where the journal line is written.
- **Watch-outs 2–5 cut.** Each repeats a line the agent reads in `CLAUDE.md`: golden files (code rules), green and `.skip()` (step 3), dependencies (non-negotiables), never push and never edit progress.md (step 4 and `## Never`). Watch-out 1 (precedence) and 6 (never end the turn while something runs) stay. 6 now points to `## The container`, since the four lost attempts behind #049 were this failure.
- **Step 5's clean-break parenthesis** points to the `## Clean-break protocol` section below it instead of restating it.
- **Orientation step 1** adds "and every rules file its `## Read next` names for the paths your task touches."; step 5 gains "never the runner outcome" (from `CLAUDE.md` line 17, which is dropped).
- The two assertions the conformance test makes about PROMPT.md alone still hold: six numbered steps, step 2 holds "stub journal entry", step 6 holds the exact DONE line.

### 3.4 The three edited rules: the audit's focus

1. **Line 36, e2e tooling.** "Playwright only for pure-web dev routes (Phases 0–1)" → "Playwright only for the pure-web dev routes under `e2e/web/`." The phase scope is stale: 3.9 just fixed a Playwright spec under `e2e/web/`, and the specs run on every gate. *Principal: confirm the dev routes are meant to stay beyond Phase 3.*
2. **Line 43, guards.** "a rule promoted into **this file**" → "into **a rules file**". It would otherwise exempt promotions to the domain file from the journal requirement.
3. **Line 46, split in two.** Its first clause is general and stays: "A fix for one member of a stated invariant asserts the invariant over the corpus and enumerates instances only as named guards on top of it." Its second clause is about writing-surface corpus legs and moves, as its own bullet: "A corpus leg that claims to be seeded from the writing surface's own output includes at least one destructive transaction (a deletion, a split, a join), because the trees a parser cannot produce are usually reached by taking something away." Text is unchanged except the capital A. Line 46 was promoted by `1.verify.r3`, whose task text required the journal to name the tests discharging each clause, so the split keeps both clauses and both tests.

### 3.5 `docs/PRINCIPAL.md`: +98 words

A `## Runner facts for planning` section holding lines 67 (second clause), 68, 69 verbatim, attributed to the DECISIONS entry this lands with. It follows PRINCIPAL.md:40's own precedent: "This section lives here and not in `CLAUDE.md`, so task agents never see an invitation to call it."

## 4. What a reader loads, before → after (words, `wc -w`)

| Reader | Before | After |
|---|---|---|
| Task agent, task outside the domain (3.10, 3.11) | 3,313 (CLAUDE 2,628 + PROMPT 685) | 1,788 (−46%) |
| Task agent, task in the domain (3.12–3.16; mode tasks touching `packages/modes/`) | 3,313 | 2,907 (−12%), with the domain rules in one place |
| Reviewer, principal, advisor | 2,628 | 1,180 (+1,119 when reviewing the domain) |

## 5. Changes outside the drafts (not drafted, for the landing task)

1. `ralph/test/conformance.test.mjs:856`: the test compares `CLAUDE.md` steps 2–5 with PROMPT.md's; with one copy there is nothing to compare. Drop the cross-file comparison and keep the PROMPT.md-only assertions (six steps, the stub step, the DONE line). Optionally add one absence assertion: `CLAUDE.md` has no `## Every iteration`, so a second copy cannot quietly return. This removes machinery rather than adding it.
2. `docker/entrypoints/grok-review:11`: Grok's drift lane lists `CLAUDE.md`; add `docs/rules/*.md`, or a domain rule drifting from the code falls outside every lane.
3. `docs/RUNNER-SPEC.md:82` (promote-lessons): "applies them to `CLAUDE.md`/`AGENTS.md`" → "…or to the `docs/rules/` file whose paths the lesson's code falls under".
4. `BUILD-DEFAULTS.md:123` (orientation order) and `:128` (promotion target; and the demotion sentence, §6 Q4).
5. `ralph/check-agent-rules.sh` and `tests/agent-rules.test.ts`: unchanged; the twins stay identical below line 1 (checked on the drafts with `cmp`).
6. A DECISIONS entry recording a **move, not a removal**, listing the three edits of §3.4 and the word counts above, so a later reviewer does not read the slimmer `CLAUDE.md` as lost rules.

## 6. Risks and open questions

- **R1, an agent skips the pointer.** A task touching `format.ts` that never opens the domain file breaks a rule it never read. Mitigations, cheapest first: the trigger is a path list, not a judgement; PROMPT.md orientation step 1 names it; reviewers check against it. Stronger option, principal's choice: domain task texts name the file ("Read `docs/rules/markdown-roundtrip.md`"), as task texts already name DECISIONS entries. No new machinery is proposed.
- **R2, PROMPT.md is read from `/work`, CLAUDE.md from the worktree.** `claude-task:22` reads `/work/ralph/PROMPT.md`, the host checkout. `refreshCheckouts` (`integrate.mjs:153`) resets that checkout to the new phase head after each integration, unless it is dirty, which raises `STALE-CHECKOUT`. So a step change a verify task makes to PROMPT.md reaches the next task as it does today, and a dirty host checkout is already a stop. Moving the steps into PROMPT.md does not add the risk but does concentrate the procedure there. *Principal: confirm.*
- **Q1, landing.** RUNNER-SPEC §5 (line 82) routes rule changes through a verifier task so they are verified and reviewed, and items 1–2 of §5 touch runner code. Recommendation: **one Phase 3→4 boundary commit** on Michael's OK, with `sync-state` and a dry run per #051's rule. Phase 3 then runs and is reviewed under the rules it started with, and the domain tasks 3.12–3.16 are not moved mid-flight. The alternative is to carry it in 3.verify's text.
- **Q2, the three save-state rules (U1, U5, W1).** Kept in layer 0: they govern anything that drops state (save, switch, close, rename, and Phase 3's Rewrite persisting to the sidecar), which crosses `apps/desktop` and `packages/editor`. A second domain file (`persistence.md`) is the alternative if they grow.
- **Q3, the bar for a new domain file.** Proposed: a domain gets its own file when it holds three or more rules no other path needs. This keeps layer 2 from becoming a folder of single-rule files nobody opens.
- **Q4, BUILD-DEFAULTS:128 demotion.** "Rules untriggered for a phase demote back" was never applied. Proposed rewording: "Rules untriggered for a phase move to the `docs/rules/` file of their paths; a rule with no path demotes to lessons." Principal's call whether to take this now or leave it.

## 7. Principal audit and revisions (accepted by Michael, 2026-10-05)

The audit checked the drafts mechanically. `wc -w` reproduces §4's numbers (CLAUDE 2,628 → 1,180; domain file 1,119; PROMPT 685 → 608). The drafted twins are identical below line 1. A script finds each of the 33 `## Code rules` bullets at `ac3aac7` exactly once across the drafted `CLAUDE.md` and the domain file, except the three §3.4 edits. Findings on the open points:

- **§2's Codex claim.** It is consistent with Codex's documented root-to-working-directory merge, but could not be checked offline against 0.153.4. The design does not depend on it, because it uses no nested rule file.
- **R2, confirmed.** `refreshCheckouts` (`ralph/lib/integrate.mjs`, after line 145) resets the host checkout to the new phase head only when it is on the phase branch with its index at the old tree and a clean worktree (untracked files do not block). Otherwise it emits `STALE-CHECKOUT`. So `/work/ralph/PROMPT.md` reaches the next task as the phase head has it, and moving the steps there adds no risk.
- **§3.4 edit 1, the dev routes stay.** Task 3.9 edited `e2e/web/editor-astral-between-runs.spec.ts`, and tasks 3.12, 3.14 and 3.16 each require a new `e2e/web` case.
- **Q2 and Q3:** agreed as drafted. **Q4:** not taken; BUILD-DEFAULTS' demotion sentence stays as it is, because it has never been applied and no rule is waiting to demote.

The seven revisions, each applied by the landing commit:

1. **Line 36's Playwright edit lands with its PRD lines.** PRD §4's Tests row (line 53: "**Playwright** only for pure-web dev routes served by Vite (Phases 0–1)") and the directory tree (line 87: "web/ (Playwright, Phases 0–1)") drop the phase scope in the same commit, so that layer 0 does not contradict the PRD it cites.
2. **The domain's paths widen.** The trigger list in `## Read next` and the domain file's `Paths:` line become: `packages/core/` (whole, not `parse`/`format`/`positions` only); `packages/editor/`; `packages/modes/`; `fixtures/markdown/`; `e2e/`; `apps/desktop/src/dev/`; `apps/desktop/src/workspace/DocumentPane.tsx`.
   - Task 3.1 routes every mode mutation through core pure functions (`blocks.ts`, `sentences.ts` or new files), which are the "mode operation's result" line 44 names; the draft's three files would miss them.
   - `apps/desktop/src/dev/DevEditor.tsx` holds the toggle and the selection readout (the `[1.46]` caret-race class, task 3.9).
   - `DocumentPane.tsx` binds the editor's store.
3. **The dependency sentence stays in layer 0.** `CLAUDE.md`'s `## Runner facts` keeps line 67 whole: "`ralph/tasks.json` is immutable to you; status lives in `/logs/state/`. A dependency counts as satisfied when it is `passed` (and `ACCEPT` for human gates); a `superseded` gate counts as satisfied only for the fix tasks the planning commit appended after it." The PRINCIPAL.md section takes lines 68 and 69 only. Evidence: 3.1's first attempt read that dependency 3.16 had not passed and stopped instead of building against a stale graph (DECISIONS #051).
4. **The lesson-[1.29] sentence sits in PROMPT.md's step 2, not step 4.** The failure it guards happens when an attempt decides whether to append its own stub (3.10's second attempt met exactly that decision). Step 4 then reads "Complete this attempt's own stub in place, …", and the sentence appears once.
5. **The reviewers are routed to the domain file.** `review_prompt` in `docker/entrypoints/essaydown-common.sh` names `docs/rules/*.md` beside `CLAUDE.md` for all three reviewers, and `grok-review`'s drift lane adds it (§5 item 2). This closes R1 for reviewers. For task agents, R1's stronger option is taken: from Phase 4, every task text in the domain names `docs/rules/markdown-roundtrip.md`.
6. **The landing items §5 missed.**
   - Entrypoints are built into the image (`docker/Dockerfile:82`, `COPY entrypoints/ /usr/local/bin/`), so revision 5 needs an image rebuild before the restart. `ralph/PROMPT.md` is read from `/work` at run time and needs none.
   - The runner's conformance suite (`ralph/test`) must pass after §5 item 1. Its optional absence assertion (no `## Every iteration` in `CLAUDE.md`) is taken.
   - RUNNER-SPEC §5 line 82 and `BUILD-DEFAULTS.md:123` and `:128` (the promotion target only, per Q4) are edited as §5 items 3–4 say.
7. **The DECISIONS entry records a move, not a removal** (§5 item 6). It names the three §3.4 edits and revisions 1–6, so that a later reviewer does not read the slimmer `CLAUDE.md` as lost rules.

**Landing.** This is one principal commit on the host checkout on `phase/4`, after `3.close`, with the runner idle (#017). It contains:
- the drafts with §7 applied, copied to their live paths (the `docs/proposals/002/` copies stay as the record; a principal commit never deletes a path);
- the PRD, RUNNER-SPEC and BUILD-DEFAULTS edits;
- the conformance-test change;
- the entrypoint edits;
- the DECISIONS entry, with its reversal line.

Then:
1. `node --test ralph/test` and `ralph/check-agent-rules.sh` green;
2. the image rebuild;
3. `ralph/ralph.sh sync-state` and `ralph/ralph.sh run --phase 4 --dry-run` (#051);
4. the restart.

Phase 3 runs and is reviewed under the rules it started with.
