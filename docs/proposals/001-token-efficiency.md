# Proposal 001 — token efficiency (advisor draft v3, after the principal's review, 2026-09-24)

Status: **v3 folds in the principal's objections of 2026-09-24 (runner invariants read at the cited lines); what remains open is marked.** Written by Michael's outside advisor session, not by the principal. Nothing here is a decision until Michael approves it and the principal records it in `docs/DECISIONS.md`. The principal is asked to object wherever RUNNER-SPEC, PRD §10 or a runner invariant makes something below wrong or costlier than stated; the advisor read the runner code paths cited here but not RUNNER-SPEC in full.

## 1. Evidence (measured 2026-09-24 on the Mini; re-run before quoting)

Sources: the `result` line of every transcript under `.evidence/tasks/*/*.log` and `.evidence/reviews/*/*/claude/*.log` (their own `costUSD`, list price), and the principal's session files under `~/.claude/projects/-Users-mlsavage-Developer-essaydown/*.jsonl` (token counts × published Fable 5.1 rates: $0.25 cache read, $20 one-hour cache write, $50 output per MTok — an estimate). Sol and Grok are not included. List-price dollars are a proxy for share of the subscription, nothing more; the binding constraint is the usage window, which transcripts report in `rate_limit_event` lines (§4 item 10). The principal's recount of task runs alone (187 with a result line, 54 capped, $457) differs from this table's scope, which also counts reviewer runs.

| Consumer | ≈ list $ | share |
|---|---|---|
| Principal sessions, Fable 5.1 (estimate) | ~478 | ~44% |
| Task agents, Opus 5 | 359 | 33% |
| Claude reviewer, Opus 5 | 151 | 14% |
| Task agents, Sonnet 5 (incl. verify/repair) | 99 | 9% |

- **F1 — the review loop.** Phase 1's build (1.1–1.8) ran on 2026-09-07 for ≈ $43 of task spend. From the first verify gate (2026-09-09) on: 83 task commits ≈ $345, Claude reviewer r0–r8 ≈ $112, plus most principal time. ≈ 90% of Phase 1 task spend is the fix/review loop. Claude reviewer turns rose from 42 (0.r0) to 128 (1.r7).
- **F2 — the principal pays Fable rates for routine signals.** About half of the principal's inbound turns were watcher/task notifications (≈ 194 signal lines, 42 task exits, 22 watcher expiries); 188 Bash calls were `ralph status/run/retry`. The watcher already filters to stop signals, so these are real events — the cost is that each is handled at Fable rates on a context whose median is 186k tokens (p90 440k).
- **F3 — retry tax.** 57 of 201 runs ended at `max_turns`; 47 of 111 tasks needed more than one attempt; $217 of $458 task spend was on attempts that did not complete (capped attempts still carry work forward in wip commits, so not all of it is waste). Median first-turn context is 30k tokens before any work, and agents ran ≈ 2,600 grep/sed/cat calls, much of it over `docs/lessons.md` (238 KB), the journal (925 KB) and the PRD (708 KB).
- **F4 — context growth.** Median end-of-run context 110k (p90 161k). A run costs ≈ turns × average context, so late turns cost ~3× early ones.
- **F5 — journal verbosity.** 190 entries, median 4,175 chars, p90 10,250. `summary.md` (20.6 KB) carries the last five in full and every agent reads it at orientation, so each entry is paid for once as output and many times as input.

## 2. The five changes

1. **Review stop rule (D1, decided by Michael).** A finding becomes a fix task only if it is **blocking**: wrong bytes or lost text reaching the user silently, a crash, or a security issue. Everything else goes to `docs/V1.1-BACKLOG.md` with its id and a revisit trigger. Severity is judged by consequence for a real document, not by how the input was built (emoji are astral characters). The principal triages against this rubric; Michael approves the list in one message.
   - **The runner requires a reviewed PASS to close** (`ralph/lib/close.mjs:59` verdict, `:63` head = reconciliation, `:66` no product file changed; RUNNER-SPEC §8.1). A fix after r9 therefore needs `1.verify.r10`, its CI gate and review set `1.10.r10a/b/c`. The stop rule applies through that set's task text: confirm the fixes and the backlog dispositions, report blockers only, no new sweeps or browser drives. A reviewer-less closing round would be new runner machinery; it goes on the D5 list only if the stop rule fires often in Phase 2.
   - **Phase 1 disposition:** fix Claude r9 finding 1 (blocker; sweep D's 25 mark pairs × ending classes as the test, the join leg as the destructive writing-surface leg, the installed emphasis/strong handlers read first) and finding 3 (the e2e race, under #037's pattern); backlog the rest with a `2.verify` trigger; `1.9.r1` per #040.
   - **A blocker found in r10 comes to Michael before any fix chain is planned**, so the stop rule cannot silently become r11, r12.
2. **Principal on Opus 5.5, Fable by escalation (D2).** No new watcher machinery: the principal keeps today's filtered watcher and handles every signal itself on Opus 5.5 (`claude --model claude-opus-5-5 --remote-control essaydown-principal`). Fable is a subagent on the §3 trigger list; the Agent tool in CLI 2.1.281 accepts `model: "fable"`. Rotate before context passes ~150k.
3. **Container Opus 5 → Opus 5.5 (D3), at the Phase 2 boundary.** The image pins CLI 2.1.261; `claude-task` passes tasks.json's `opus`/`sonnet` to `--model`; `claude-review` hardcodes `--model opus`. The alias → full-id mapping goes in the entrypoints (tasks.json and the validator's model enum stay). A `docker/` change means an image rebuild (manual procedure F17) and a DECISIONS note per the versions.env header; changing the reviewer's model is a reviewer reconfiguration, so boundary only. No effort setting until read on the pinned CLI.
4. **Retry tax (D4): keep `MAX_ATTEMPTS` at 3 and the turn caps.** Ten tasks reached a third attempt and eight completed on it, because capped attempts carry their work forward. The waste is inside each attempt — re-orienting, re-running the suite, writing the journal — and §4 items 1–4 address it.
5. **Scope the review-derived rules.** Editor-specific `#review-1-rN` bullets move from the root `CLAUDE.md`/`AGENTS.md` into `packages/editor/CLAUDE.md` and `packages/editor/AGENTS.md`; the principal decides which bullets are general. Claude loads a subdirectory CLAUDE.md when it reads files there. Codex reads AGENTS.md from its working directory upward, so Sol's packet must name the nested file. `ralph/check-agent-rules.sh` and `tests/agent-rules.test.ts` extend to the nested pair.

## 3. Fable escalation

The principal's Agent tool accepts `model: "fable"`. A subagent starts with an empty context — cheap, but it needs a written brief. Triggers come from runner signals, never from an agent's own judgment:

- review reconciliation (`N.10.r*d`) — Fable reads the findings packet and returns decisions; the principal writes the commits;
- `REPLAN`, `PLAN-GATE`, `CLOSE-DRIFT`;
- `STUCK` (after three attempts);
- the runner contradicting itself (PRINCIPAL.md's cut-to-manual rule);
- Michael asks for it.

Brief: the signal and task id; evidence paths; what was tried; the one question; the answer format (decision, reasons, confidence, commands). Fable returns an answer, never edits. Output tokens are the bulk of a reconciliation; with Opus writing the DECISIONS entry and task texts, they are billed at Opus rates. The trigger list and brief live in `docs/PRINCIPAL.md`, not `CLAUDE.md`, so task agents never see an invitation to call it.

## 4. Scripts and routing — inside the existing structure

No new top-level tree: the repo already separates roles (`docs/PRINCIPAL.md`, `CLAUDE.md`/`AGENTS.md`, reviewer prompts in `docker/entrypoints`), procedures (`ralph/`, `scripts/`, `.claude/commands/`) and evidence (`.evidence/`). What is missing is routing — each reader told what to read and what to run — and scripts where agents now spend turns on deterministic work. Every item names its one home.

| # | Item | Home | Replaces |
|---|---|---|---|
| 1 | `ralph brief <id>`: the task entry, its accepted.json payloads, and the lessons indexed to its area | `ralph/lib/` | orientation grepping (F3) |
| 2 | `ralph journal stub\|complete <id>`: writes and commits the line; structured fields (status, files, suite counts parsed from output, the test discharging each guard, attempt) stay complete, the narrative is capped; keeps the `- [<id>] ` prefix the stop-check counts | `ralph/lib/` | hand-written entries (F5), the NO-JOURNAL class |
| 3 | `summary.md` shows one line per recent entry (a §10 wording change plus a conformance test) | `ralph/lib/summary.mjs` | 20 KB orientation read |
| 4 | `scripts/check`: lint, test, cargo with quiet reporters; failures and counts only | `scripts/` | ~6 suite runs per task with full output |
| 5 | Verify tasks stay Sonnet agents (promotion is reviewed code under §5.5; all 23 verify runs cost $17.29) and use items 1 and 4 | — | — |
| 6 | CI triage on GATE-FAILED: merged into the I7 boundary fix already listed | I7 | — |
| 7 | Reviewer scope: set by each review set's task text under the stop rule (reviewers already receive the backlog; their turn growth is sweeps and browser drives). A packet change is a `docker/` change, boundary only | reconciliation task text | reviewer turn growth |
| 8 | Model routing: a table in `docs/PRINCIPAL.md` that planning commits follow (a generator-read table would be a §3 change) | `docs/PRINCIPAL.md` | per-task model picks re-decided each time |
| 9 | Lessons index: generated file mapping lesson id → area and promoted/live; `lessons.md` itself untouched (old lines are never edited) | `ralph/lib/`, output under `docs/progress/` | reading all of `lessons.md` |
| 10 | Usage meter: reads `rate_limit_event` utilisation and per-run cost from the transcripts; printed by `doctor` and by the rotation, no stop signal | `scripts/`, `ralph/lib/doctor.mjs`, `/rotate` | nobody knowing the spend until the window runs out |
| 11 | "Where things live" index: ~10 lines at the top of `CLAUDE.md` (agents) and `docs/PRINCIPAL.md` (principal) pointing at the homes above | existing files | agents searching for procedures |

Reviewer turn cap: unchanged (160). Lesson `[0.12.r1d]` records that a 50-turn cap starved the Claude reviewer twice.

## 5. Measuring whether it worked

Run item 10 at the Phase 2 boundary (baseline = §1) and after the first ten Phase 2 tasks. Targets: principal share under 20%; median first-turn context under 15k; median journal narrative under 800 chars; non-completing attempts under 25% of task spend; usage-window utilisation per completed task falling. A change that misses its target is revisited, not extended.

## 6. Decisions that are Michael's

- D1: decided — the stop rule as §2.1 states it, with the scoped r10 round.
- D2: principal on Opus 5.5 with Fable escalation.
- D3: container CLI bump and Opus 5.5 at the Phase 2 boundary.
- D4: keep attempts and caps.
- D5: which §4 items to build at the boundary (suggested first: 2, 3, 1, 4, 10, 11).

## 7. Order

1. `1.10.r9d` reconciles under D1; the two fix tasks, `1.verify.r10`, its CI gate, the scoped `1.10.r10a/b/c`, `1.10.r10d`; `1.9.r1`; `1.close`.
2. At the Phase 1→2 boundary: D2–D5 recorded; runner, CLAUDE.md, entrypoint and script changes made, covered by `bash ralph/test/run.sh` and the suite; each its own commit with its reversal.
3. Rotate; the next principal session starts on Opus 5.5 under the new PRINCIPAL.md.
