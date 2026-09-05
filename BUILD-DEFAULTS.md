# BUILD-DEFAULTS.md

Version: 1.11.0 (2026-09-05; v14-audit: RUNNER-SPEC 1.7 — audit budget then cut: publication manual in v1, doctor + admin over intents, gates never commit, digests in every CI manifest. v13-audit: RUNNER-SPEC 1.6 — no patch machinery in v1, trailing publication gates, intents for every multi-step mutation, generalized verifier grammar, producer-run artifact consumption)
Repo: `MLSavage/build-defaults` — copied into every new project at task 0.0. Edited only by a retrospective task (with evidence) or by Michael.

This is the file to open instead of remembering. Every agent-built project starts from these defaults. Each section has a **Default**, an **Override** rule (when it is fine to deviate) and, where one exists, the **Evidence** that put it here. Sections without evidence are first-principles defaults from project #1 and are the ones most likely to change at the first retrospective.

---

## 0. Roles

Default: Michael = product owner and human gate. Claude (Opus, interactive) = principal engineer: writes the PRD, the prompts, reconciles reviews, never writes production code. Claude Code (Opus / Sonnet by task) = implementer. Reviewers, three per phase, each its own task: Claude Opus (fresh context, `claude -p`), GPT-5.6 Sol (Codex CLI), Grok 4.6 (Grok Build CLI, X-account login). Everything on subscription; no API keys in any pipeline. A reviewer never has the implementing session's context; same-model review is fine and cheap, cross-model review is what finds the shared blind spots.
Override: a one-day throwaway can skip reviewers; anything that will be used for more than a week does not.

## 1. Planning artefacts (in this order, nothing else until they exist)

0. Apply the previous project's `docs/RETRO-CARRYFORWARD.md` (final-review lessons that missed its retrospective) to this file before anything else.
1. `docs/PRD.md` — problem, user, one workflow, locked stack, non-goals, architecture, phased task list with machine-checkable acceptance, agent rules, open questions, confidence scores.
2. Independent PRD review by a fresh Opus agent with web access **before** Michael sees it (Evidence: the Essay Down v1 PRD had 6 blockers a reviewer caught in one pass: an e2e harness that could not drive the target, golden files no task created, a decision gate that later tasks did not depend on).
3. Sol's PRD review after edits (Evidence: Sol found 9 blockers in a PRD that had already passed an Opus review — compound tasks, uncreatable acceptance artifacts, a bake-off that could never choose the alternative). Grok optional at this stage.
4. Lock. After Lock, PRD changes are commits with a DECISIONS.md entry.

Acceptance-criteria rules (each has bitten once):
- Every file a criterion asserts against must be created by that task or an earlier one; say which.
- Name the runner (Vitest / Playwright / WebdriverIO / cargo) in the criterion.
- Counts in prose must match counts in the criterion (7 token classes vs "8 assertions" was a real finding).
- Human judgement never hides inside an agent task; it is its own `blockedOnHuman` task.
- Any spike is one iteration, one output document, on a throwaway branch, and later tasks depend on it.
- A task that needs two commits was two tasks.
- A review report and its reconciliation are separate tasks; a human gate is never bundled with agent work in one task.
- Anything that discovers an unknown number of follow-ups is a re-planning gate that stops the loop, not a task that "fixes as filed".
- Every tool an acceptance criterion names must be installed by an earlier task (LibreOffice, epubcheck, a JDK…).
- Byte-preservation guarantees must exclude the fields the app itself owns and edits.
- Hash/encoding sizes are computed, not guessed (2^64 needs 13 base-36 digits, not 12).
- Every task carries an `execution` mode (loop | interactive-principal | human); `blockedOnHuman` only on human tasks. A flag never carries two meanings.
- A macro task has one canonical expanded acceptance, and the expanded graph is validated by a script before Lock.
- An identity guarantee is never claimed for states that are observationally identical; say what happens instead.
- An optional feature phase never sits on the release's critical path; the release gate accepts it disabled.
- Any task needing a remote (push, release, cross-repo) is split into an agent part and a human push part.
- CLI syntax that enters a task is verified against the vendor's docs, not a blog post.
- Every remote assertion has an owner, an exact SHA, a workflow name, an evidence-fetch step and a downstream dependency: tasks that need CI carry `needsCI` and expand into a human CI gate; agent acceptance stops at "validated locally".
- Phase closing is in the task graph: review → fix → re-review → merge to main → next branch, each an explicit state; a phase cannot close with an open blocking finding.
- The RC a human approves is packaged after the last fix, and the tag is created on the exact main SHA that shipped.
- Four audit rounds in a row found contradictions introduced by the previous round's fixes: re-audit after every structural revision, and when the orchestration outgrows a PRD section, move it into one canonical protocol document (RUNNER-SPEC.md) with explicit state, and let the PRD point at it.
- Distinguish implementation, reconciliation and close SHAs; never require a metadata commit to equal the snapshot that preceded it, and never write a SHA into the commit it names.
- Mutable orchestration state lives outside the versioned task specification.
- Read-only (reviewer) and human tasks have explicit completion protocols that produce evidence files, not commits; a runner task lands the evidence.
- Optional parallel phases get an explicit branch-creation and merge-order policy; a release phase ends at its close task and later work is a separately closed post-release phase.
- A tag points at the commit containing the version it names; the RC a human approves is built from the SHA that carries the version bump.
- After changing evidence or review architecture, re-run every exact prompt and path reference.
- A bootstrap task never depends on infrastructure it creates; its prerequisites are a preflight checklist outside the graph.
- A lock protects the resource being mutated; when two phases could touch one state file, run phases sequentially with one lock rather than designing a lock hierarchy.
- Every task names its target ref once ids stop mapping one-to-one to branches.
- Final publication evidence is evidence-only; nothing is committed after the push it records.
- Nothing commits between a phase's verification and its review, so the tested SHA is the reviewed SHA (assert it).
- Dynamic task generation requires an atomic runtime-state migration (sync-state).
- Every failure status has a documented recovery transition.
- Release tag, internal version, workflow, artifacts and tested SHA form one invariant, asserted at close; a version task precedes every tag.
- Conditional release paths must be reachable in the graph, or removed.
- A product assembled from separately tested branches is verified and reviewed on the combined SHA before tagging.
- Fifth audit lesson: when a protocol keeps failing review, remove the hard parts (concurrency) rather than specifying them further.
- Every gate has a success transition and a failure/rejection transition; rejection appends fresh attempts and never mutates passed tasks.
- Any code change after verification invalidates it; every review attempt has its own verifier and CI evidence.
- Test a candidate completely before moving canonical refs; move main and its tag in one ref transaction; write evidence afterwards.
- Evidence cannot be required before the action that creates it: split release invariants into close-time and publication-time.
- Anything the runner must select (target ref, next task, verdict, external verify command, replan destination) is a validated field, never prose.
- A release SHA is the exact combined SHA that was verified and reviewed; closes are fast-forward-only.
- Generated tasks must satisfy the same validator as hand-written ones.
- CI runs on immutable per-gate refs, never on a branch that can move underneath the gate.
- A gate that cannot commit cannot create tasks: it raises a request; a principal planning commit answers it.
- Gate outcomes live in runtime state; a dependency is satisfied only by passed + ACCEPT; observation gates always accept when complete, approval gates can reject.
- Attempt numbering starts at r0 and the next attempt is always k+1; ids never collide.
- A close writes an intent record, moves every ref in one transaction (next branch and tag included, tags with zero-OID expected-old), finalises evidence after, and is safe to re-run.
- Every value a close compares against (phase base SHA, approved candidate) is a stored record resolved by rule, never a hard-coded task id.
- Every tag, RC tags included, is preceded by a version task; the final-package gate builds installers at the exact SHA that will be tagged.
- A failure after a final tag opens a hotfix mini-phase with a new version; nothing ever re-plans a shipped tag.
- The runner ends at the phase close; publishing a tag is a manual, documented procedure (PUBLISH.md) outside the graph, and the next phase starts at the close.
- Phase order is explicit metadata on each close (nextPhase/nextBranch), never arithmetic on phase numbers.
- Anything the runner mutates has an id, a state and a recovery transition — plan requests included.
- Execution attempts (rerun the same task against the same SHA) and graph revisions (new tasks, new ids) are different namespaces.
- Evidence consumers read an accepted-attempt manifest, never a bare directory.
- A release candidate is resolved from the attempt that passed review and must equal its verified SHA; say exactly what a candidate proves about the tagged commit.
- Anything that can go wrong after the final tag is resolved by a planned phase from the generic template, never by a special path.
- The runner ships with a conformance suite against fixture repos covering every transition the spec names; the first review targets it.
- Answers the owner gives are recorded in DECISIONS the same turn; a PRD never carries answered questions.
- Every validator rule has a fixture drawn from the declared graph; a rule that rejects the project's own tasks is a bug in the rule or the tasks, found before Lock.
- Release candidates are packaged from immutable refs as artifacts; the only tag a project ever creates is the final release tag at close, so nothing needs repointing.
- Repairs before review (`g<n>`) and review attempts (`r<n>`) are different namespaces.
- A new phase's branch is created by the runner before the planning commit that defines the phase, so the specification lives on the branch that runs it.
- Every state-holding object (tasks, plan requests, phases) has a transition table with the same failure and recovery states.
- "No agent on the host" is never absolute; list the exact host exceptions.
- A v1 runner has no patch/hotfix/publication machinery: a broken release is fixed by hand per PUBLISH.md, a broken workflow file ships its fix in the next phase (the workflow lives in the tagged tree, so it cannot be re-run for an existing tag), and corrections ship in the next phase. Eleven audits showed the repair paths generate more contradictions than the happy path ever did.
- Crash safety in a v1 runner is detection plus explicit repair, not journaling: no intent files; a `candidate/<id>` tag before every ref move, `run.json` before every remote wait, a read-only `doctor` that names one `admin` command per finding, and `run` refusing to start until `doctor` is clean. Intents needed re-entry rules per step and audit #11 found holes in three of them; doctor + admin has one rule.
- Attempts with remote side effects are resumed or explicitly abandoned, never rolled back or discarded.
- Gates never commit; every input a workflow needs is committed by the producer task, so `integrated_sha == the SHA CI ran` has no exceptions.
- Every CI manifest carries the run id and per-artifact digests, and every consumer verifies the digests it reads.
- A rerun exists only for a transient failure against the same SHA; any code or workflow change is a new task with a new id.
- Planning has a budget: after the agreed number of audit rounds, a blocker is resolved by cutting the feature it lives in to a manual procedure (with a v1.1 backlog line), never by adding machinery. State the budget and the rule before round one.
- A workflow can only consume what exists on the runner: artifacts from another run are fetched by run id with hashes committed on the pushed ref, never assumed from host paths.

## 2. Repo layout that every project gets

```
docs/PRD.md  RUNNER-SPEC.md  PREFLIGHT.md  DECISIONS.md  progress.md (generated at reconciliation)  progress/journal-*.md  lessons.md  V1.1-BACKLOG.md  reviews/  RETRO.md
ralph/PROMPT.md  tasks.json (immutable spec)  EXPECTED_COUNT  generate-tasks.mjs  validate-tasks.mjs  bootstrap.sh  sync-state.sh  ralph.sh (run | retry | resume | resolve-conflict | abandon | close)  stop-check.sh
docker/Dockerfile  compose.yml  versions.env  entrypoints/
.evidence/       (host-owned, gitignored, mounted as /logs: state/ tasks/ ci/ reviews/<phase>/r<k>/ human/ closes/ external/)
scripts/promote-lessons.ts  fetch-ci-logs.sh  gate.sh
CLAUDE.md  AGENTS.md   (identical below the title; a cmp script then a test enforce it)
.gitattributes        docs/lessons.md merge=union (only purely append-only files)
```

## 3. Agent runtime

Default: one Docker image per project on OrbStack, Debian base, toolchain baked in, versions pinned in `docker/versions.env` (CI reads the same file), `--dangerously-skip-permissions` (Claude) / `--full-auto` (Codex) / `grok -p` (Grok Build). Repo bind-mounted at `/work`; every agent works in its own `git worktree` under `/work/.wt/<task-id>` on its own `task/<id>` branch cut from the phase head (git refuses one branch in two worktrees). Model credentials mounted read-only (`~/.claude`, `~/.codex`, Grok login state); no API keys and **no git credentials** in the image — the loop integrates locally, Michael pushes exact SHAs from the host via `scripts/gate.sh` and fetches CI logs into `.evidence/ci/<id>/` for reviewers. Claude billed to the subscription, never `ANTHROPIC_API_KEY`. The host checkout is never an agent's working copy. Transcripts tee'd to `/logs/tasks/<id>/`, never inside a worktree. `.claude/settings.local.json` gitignored. Reviewers get the snapshot read-only, a throwaway scratch copy for running tests (must be clean at exit), and one writable report path.
Override: none for unattended runs. Interactive sessions with Michael watching may run on the host.
Platform note: the container is Linux. macOS/Windows verification happens only in CI; agents must not claim cross-platform pass from inside the container.

## 4. Execution workflow

Decision order (workflow-selection): done is machine-verifiable? task list complete? → Ralph loop per phase, phases strictly sequential, one lock. Architectural judgement still open? → interactive Opus session or manager + sub-agents for that piece only. Spikes → a normal task plus an ephemeral CI ref and a principal decision task. Task 0.0 is the single bootstrap exception, run on the host after PREFLIGHT.md.
Ralph defaults: `--max-turns 50` (implementation) / 30 (setup), 15 iterations per run, watch the first 3 transcripts. Kill triggers: same task fails 3×, no progress entry, no commit in 2 iterations. Parallel streams only when the PRD says the streams are disjoint; otherwise sequential.
PROMPT.md: under 2,000 tokens; orientation order CLAUDE.md → /logs/state/summary.md → the task's entry in ralph/tasks.json → lessons.md; the runner hands the agent one task id (the agent never selects); verify; append a journal entry (no commit SHA); `wip(<id>)` commit; `<promise>DONE <id></promise>` when acceptance is met; clean-break protocol after 5 debugging tool calls. State, selection, integration, gates and closes are the runner's job per RUNNER-SPEC.md.

## 5. Compound engineering

- Journals: agents append `[<task-id>] <ISO>` entries (task, status, files, tests, attempt number, first-attempt pass, notes — never their own commit SHA) to `docs/progress/journal-<stream>.md`. `/logs/state/summary.md` (outside git) is regenerated after every integration for orientation; `docs/progress.md` (tracked) is regenerated only in reconciliation commits.
- `lessons.md`: append-only, `[<task-id>] LESSON: <root cause> → <do instead>`. Reviewer class-level findings enter as `[review-N]`. `promote-lessons` flags recurrence ≥ 2 → becomes a CLAUDE.md/AGENTS.md rule, lesson marked PROMOTED. Rules untriggered for a phase demote back.
- Concurrency: none for implementation (one task at a time, one lock); the only parallel work is the three reviewers of a review set. One append-only journal; union merge only on `lessons.md`; nobody edits old lines; mutable status lives in `.evidence/state/`, never in a tracked file.
- Integration: per-phase `flock`; candidate commit built without moving the branch; tested in a detached worktree; compare-and-swap `git update-ref` with the expected-old SHA; state flips only after the ref update (RUNNER-SPEC §4).
- Reviews: `N.verify` last before the review set, no commits in between, so verification SHA = `implementation_sha` (asserted); three parallel read-only reviewer worktrees, reports outside the repo until reconciliation copies them in; failed reconciliation → fix tasks + attempt `<id>.rN`; the reconciliation commit is `reconciliation_sha` and is followed by `sync-state`; close records live in `.evidence/closes/`.
- Human gates: `scripts/gate.sh <id>` writes evidence; the phase reconciliation copies it into DECISIONS under `recordTarget`; CI gates execute a validated `ci` object.
- Pre-loop hygiene every iteration, in this order: `git status` → commit any dirty tree as `wip(<id>): recovery` → rebase the task branch onto the phase head (a pull/rebase before recovery fails exactly when recovery is needed). (Evidence: quote-engine PROMPT.md Step 0, corrected by Sol audit #2.)
- Commit model: any number of `wip(<id>)` commits on the task branch; the loop script squashes to one `task(<id>)` acceptance commit at integration, re-runs the suite on the phase branch, keeps `wip/<id>` tags for forensics. Phase branches are linear and never rewritten.
- Close-out: no task ends a phase in an ambiguous state — passes, blocked-with-reason, or deferred-with-reason (Evidence: takeoff-engine port-status ledger).
- Every bug → regression test + lesson + (if from review or Michael) an acceptance-criteria pattern added to §1 of this file.
- Trajectory engineering: iteration-level via clean-break (next iteration starts with the fix, never sees the failure); task-level by writing the fix, lesson and amended acceptance criterion in the originating task's terms; phase-level replay only as an explicit decision by Michael.
- Pre-mortem: 5-line watch-outs at the top of each phase's PROMPT.md, drawn from lessons and the previous phase's reviews.
- Metrics per task/phase (§10.4 of the PRD). First-attempt pass rate should rise; review blockers should fall.
- Retrospective task at the end of every project proposes a diff to this file with one line of evidence per change; Michael accepts line by line; version bump.

## 6. Reviews

When: at the PRD (before code), at the end of the foundation phase (scoped to the core package, not scaffolding), at every phase gate after that, and risk-triggered (a task the loop failed twice; anything touching the project's named fragile areas) gets a single Claude Opus review before its gate. Never per commit: commits are atomic, the phase is the smallest unit worth three models' time. Every review set includes a fresh-clone cold build in a temp dir (Evidence: takeoff-engine final gate).
Per phase: Claude Opus and Sol (in container, may run anything non-mutating) and Grok (read-only unless Grok Build proves reliable in the container) with the same inputs: PRD, lessons, `git diff main...phase/N`, test logs, the gate row. Output per `docs/reviews/TEMPLATE.md`. Claude reconciles (two-of-three agreement acts; reproducible evidence wins disagreements); disagreements are logged as reviewer-blind-spot data.
Review prompt (paste into Codex, or use `codex-review`):

> You are the independent reviewer for phase N. Your worktree is checked out read-only at the implementation SHA recorded in /logs/reviews/N/implementation_sha; the phase base SHA is in /logs/reviews/N/phase_base_sha. Read docs/PRD.md (§7 gate row for phase N, §8 tasks for phase N), docs/RUNNER-SPEC.md, docs/lessons.md, then `git diff <phase_base_sha>...<implementation_sha>`, /logs/ci/N.verify/ and the other /logs/ci/<id>/ and /logs/tasks/<id>/ directories for this phase. In your scratch copy (/scratch/<you>) do a fresh-clone cold build of the implementation SHA and run `pnpm lint`, `pnpm test`, `cargo test` and any read-only command you need; leave the scratch copy clean. Write only to /logs/reviews/N/<you>/. Try to falsify every gate criterion. Report using docs/reviews/TEMPLATE.md: gate table with evidence, test counts, coverage delta, ≤ 20 findings (severity blocker/should-fix/nit, file:line, concrete fix), three riskiest things, class-level lessons. No praise, no summary of the code. (Grok: read-only tree and logs only; cite the CI cold-build log instead of running one.)

## 7. Git

One branch per phase (`phase/N`), one `task/<id>` branch per task, one squashed `task(<id>): <desc>` commit per task on the phase branch with acceptance criteria and `Depends-on:` closure in the body. Reverting a task means reverting it with its transitive dependents in reverse integration order; that combined revert leaves tests green. Phase close moves `main`; a release phase ends at its close and tag, and later work is a separately closed post-release phase. The container never pushes. Merge to `main` only after the phase's reviews reconcile to pass. Commit before switching machines or pathways (Evidence: an all-day session left both machines uncommitted).

## 8. Shell and environment gotchas

- zsh on macOS: pasted blocks must not contain `#` comment lines (`interactive_comments` is off by default and they execute).
- Mini home is `/Users/mlsavage`, MacBook Pro home is `/Users/mls`; never hard-code a home path in scripts; use `$HOME`.
- iCloud is full: never rely on iCloud for sync paths; Syncthing or git.
- Repos are pushed from more than one machine: expect divergent-branch reconciliation; `git pull --rebase` default.
- `.claude/settings.local.json` records approved shell commands, including any sensitive paths in them, into the working tree → gitignore it in every repo (Evidence: takeoff-engine R0).
- Leak scans cover the whole working tree and all history, not tracked files at HEAD; a clean HEAD with dirty history forced quote-engine into a fresh-root republish. Decide the data law at task 0.0.
- Freeze dependencies for the last task before any gate; new deps go in early (Evidence: takeoff-engine R4 zero-new-deps decision).

## 9. Testing defaults by target

- TS units: Vitest + coverage-v8, per-file thresholds where the PRD says 100%.
- Web-only routes: Playwright against Vite.
- Tauri shell: WebdriverIO + `@wdio/tauri-service`; Linux/Windows via `tauri-driver`, macOS via the WDIO plugin's provider; Playwright cannot drive Tauri (Evidence: Essay Down PRD review).
- Rust: `cargo test`, `ErrorKind` assertions not string matches (Windows error strings differ).
- Desktop shells: a plugin's permission scope protects only that plugin's commands; every custom path-taking command enforces a canonical workspace root with traversal, symlink and junction tests (Evidence: Sol audit #2 on Essay Down).
- Export outputs: named validators (`html-validate`, `epubcheck` with a JDK in CI, `pdfimages`/`pdftotext`).
- Cross-OS visual tests: per-OS baselines, never a cross-OS pixel delta.
- Anything served to a browser/webview is verified in a real browser/webview; in-process harnesses (fastify inject, jsdom) miss module-loading and MIME failures (Evidence: takeoff-engine R4).
- Assert relationships and shape (total = sum of parts; both summands present; presence AND absence cases), never magnitudes copied from one dataset (Evidence: quote-engine, takeoff-engine R2.1/R3.1).
- Pure functions with injected config/state; no module-level config imports (Evidence: takeoff-engine R2 sensitivity tests).
- Exported artifacts are validated by an external reader, not the generator's own model.
- Record each compiler-forced behavior decision in the commit body rather than silencing it.

## 10. Things that are always out of scope unless the PRD says otherwise

Code signing / notarization in v1; telemetry; accounts; plugin systems; mobile; features not named in a task ("while I'm here" is banned).

## 11. Retro log

- 1.0.0 — seeded from Essay Down PRD v3 and the tooling lessons already on file.
- 1.1.0 — Sol PRD-review class lessons (§1); takeoff-engine and quote-engine process lessons (§5, §8, §9); three-reviewer subscription-only protocol (§0, §6).
- 1.2.0 — Sol audit #2 lessons: execution modes, task branches and integration, wip/acceptance commit model, container never pushes, plugin scopes vs custom commands, optional phases off the critical path (§1, §3, §5, §7, §9).
- 1.3.0 — Sol audit #3 lessons: CI gates with owners, phase-close in the graph, evidence mount, review snapshot isolation, severity rule, integration mutex, journals + generated summary, rc-after-fixes (§1, §2, §3, §5).
- 1.4.0 — Sol audit #4 lessons: RUNNER-SPEC.md as the canonical protocol; three SHAs; immutable spec + external state; reviewer/human/runner/loop-external modes; N.verify CI gates; post-release phase; context-only CLI coach sandbox (§1, §2, §3, §4, §5, §6, §7).
- 1.5.0 — Sol joint audit #5 lessons: RUNNER-SPEC 1.1 (sequential phases, one lock, bootstrap + PREFLIGHT, evidence-only gates, review attempts, sync-state, recovery, ci objects, release invariant); remove hard parts rather than specify them (§1, §2, §4, §5).
- 1.6.0 — Sol joint audit #6 lessons: RUNNER-SPEC 1.2 (transactional close, per-attempt verifiers, verdicts, immutable CI refs, gate outcomes, split invariant, sequential implementation) (§1, §5).
- 1.11.0 — Sol joint audit #11 lessons, resolved by cuts: RUNNER-SPEC 1.7 (publication manual, doctor + admin instead of intents, gates never commit, digests in manifests, transient-only reruns, planning budget rule) (§1).
- 1.10.0 — Sol joint audit #10 lessons: RUNNER-SPEC 1.6 (no patch machinery, trailing publication, intents, verifier grammar, producer-run artifacts) (§1).
- 1.9.0 — Sol joint audit #9 lessons: RUNNER-SPEC 1.5 (no RC tags, g/r namespaces, patch phases on runner-created branches, plan-request table, close re-entry, evidence schemas, scoped host rule) (§1).
- 1.8.0 — Sol joint audit #8 lessons: RUNNER-SPEC 1.4 (nextPhase metadata, plan requests, attempts vs revisions, accepted manifests, candidate by verifier, hotfix as planned phase, close-record schema, conformance suite) (§1).
- 1.7.0 — Sol joint audit #7 lessons: RUNNER-SPEC 1.3 (plan-gate, outcomes in state, r0 attempts, idempotent close, base records, candidate resolution, final-package gates, hotfix mini-phase, gateKind, ref templates) (§1). First real retrospective: Essay Down tasks post.1–post.4 (Phase 5), with RETRO-CARRYFORWARD applied at the next project's step 0.
