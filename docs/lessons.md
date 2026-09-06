# lessons.md — Essay Down

Append-only. One line per lesson: `[<task-id or review-N>] <ISO timestamp> LESSON: <root cause> → <what to do instead>`. Never edit an old line; add a new one. Lines marked `PROMOTED` have become rules in CLAUDE.md/AGENTS.md. Union-merged in git (.gitattributes).

## Seeded before task 0.0 (from the PRD reviews and prior projects)

- [prd-review-1] 2026-09-03 LESSON: Playwright was specified for Tauri e2e but cannot drive WebKitGTK/WebView2/WKWebView → name the runner per target in every acceptance criterion (WebdriverIO + tauri-driver for the shell).
- [prd-review-1] 2026-09-03 LESSON: acceptance criteria referenced golden files and index.json fields that no task created → the task that first asserts against a golden creates and commits it.
- [prd-review-1] 2026-09-03 LESSON: a decision-gate task existed but later tasks did not depend on it, so it could be mooted → every gate/spike is a dependency of the tasks it decides.
- [prd-review-1] 2026-09-03 LESSON: relative image `src` does not resolve under Tauri's asset protocol → assetProtocol scope + persisted-scope + CSP img-src + convertFileSrc(absolute) at render time.
- [prd-review-1] 2026-09-03 LESSON: remark-gfm parses footnotes into real nodes, so "unsupported syntax passes through opaque" was false → enable GFM extensions individually; opaque set is html + yaml only.
- [prd-review-1] 2026-09-03 LESSON: sha1 in a pure-TS package is async (Web Crypto) → sync FNV-1a in core; ids are contentIds, recomputed on parse.
- [prd-review-1] 2026-09-03 LESSON: pandoc ships no macOS universal binary; Tauri sidecars need `<name>-<triple>` → 8 archives, lipo two pairs, own task.
- [prd-review-1] 2026-09-03 LESSON: "manual review of 40 outputs" hidden inside an agent task → human judgement is its own blockedOnHuman task.
- [prd-review-1] 2026-09-03 LESSON: cross-OS pixel-delta thresholds on text-heavy pages are unachievable → per-OS baselines + layout parity assertions.
- [tooling] 2026-09-03 LESSON: zsh executes `#` comment lines in pasted blocks → no comment lines in shell blocks meant for pasting.
- [tooling] 2026-09-03 LESSON: home dirs differ across Michael's machines (/Users/mlsavage vs /Users/mls) → `$HOME`, never literal paths.
- [tooling] 2026-09-03 LESSON: an all-day session ended with two machines uncommitted → commit before switching machines or pathways; the loop commits every iteration.

## Mined from ~/Developer/takeoff-engine and ~/Developer/quote-engine (2026-09-03)

- [takeoff-R4] LESSON: fastify inject() tests passed while the real browser failed (non-segment-aware `/api` prefix guard broke ESM loading with no console error) → served-UI requirements need a real webview/browser drive, not an in-process harness. (Already reflected: WebdriverIO against the real Tauri webview.)
- [takeoff-R4] LESSON: browser module cache kept a broken import graph across hash-route changes → after a serving fix, force a full document reload in e2e before asserting.
- [takeoff-R4] LESSON: taking zero new dependencies right before a gate kept the fresh-clone cold build robust → freeze dependencies for the last task before every gate; new deps go in early tasks.
- [takeoff-R4] LESSON: structural asserts on a PDF did not prove a real reader accepts it; `file` and macOS Quartz did → validate exported artifacts with an external tool, not only the generator's own model. (Already reflected: epubcheck, pdfimages, html-validate.)
- [takeoff-R3.1] LESSON: a dropped `if` branch and a deleted `push` are invisible to constant scans and marker gates → when porting or refactoring an emitter, count branches and line items before/after and assert both presence and ABSENCE cases.
- [takeoff-R2.1] LESSON: a two-term sum whose terms happen to be equal was "deduplicated" into one term, halving the result → when a formula sums things that look equal, port the sum; assert the SHAPE (both summands present) not just the number.
- [takeoff-R2] LESSON: business constants hide in string filters and comments, not just numeric literals → constant sweeps must include strings and comments.
- [takeoff-R2] LESSON: speculative generic config shapes did not survive a real engine → don't pre-design generic shapes; let the schema grow from the first real case.
- [takeoff-R2] LESSON: engine takes config as a parameter (no module-level import) made sensitivity tests trivial → pure functions with injected config/state everywhere (already the core-package rule).
- [takeoff-R1] LESSON: stricter compiler flags (noUncheckedIndexedAccess) forced small behavior decisions → record each forced decision in the commit body rather than silencing with `!`.
- [takeoff-R1] LESSON: when a task instruction conflicts with the repo's laws (AGENTS.md), the law wins and the agent ports the contract, not the code → CLAUDE.md/AGENTS.md outrank task text; agents stop and note conflicts.
- [takeoff-R0] LESSON: `.claude/settings.local.json` persisted approved shell commands containing sensitive paths into the working tree → gitignore `.claude/settings.local.json` and scan the whole working tree, not just tracked files, for leaks.
- [takeoff-R0] LESSON: whole-word grep misses terms glued into identifiers → the gate is a backstop, invented data is the real defense.
- [takeoff-R0] LESSON: JSON config cannot carry comments → allow `_note` string fields in validated schemas.
- [quote-engine] LESSON: tests that hardcoded expected dollar amounts pinned the suite to one price book → assert relationships (total = sum of parts, x = base × rate), never magnitudes; data-pinning tests live next to the data.
- [quote-engine] LESSON: `@testing-library/jest-dom` calls expect at import time and there is no auto-cleanup → plain vitest asserts + explicit cleanup() in beforeEach.
- [quote-engine] LESSON: two parallel loops (engine, ui) each kept their OWN progress/lessons files (progress-engine.md, lessons-engine.md …) → this was the earlier answer to concurrent writers; Essay Down uses union-merge on shared files for ≤ 2 parallel streams and switches to per-stream files if more are ever run.
- [quote-engine] LESSON: a predecessor repo's history leaked client material even though HEAD was clean, forcing a fresh-root republish → decide the repo's identity and data law at task 0.0; history is forever.
- [both] LESSON: the "final gate" was a fresh clone in a temp dir + cold `npm ci` + build + test + scans, recorded verbatim → every phase gate for Essay Down includes a fresh-clone cold build in the container (added to stop-check for review tasks).
- [both] LESSON: a provenance/status ledger (port-status.md) with no bare `pending` rows at close-out was what made the audit trail trustworthy → tasks.json must end each phase with no task in an ambiguous state: passes, blocked-with-reason, or deferred-with-reason.

## From Sol PRD audit #2 (2026-09-03)

- [prd-review-3] 2026-09-03 LESSON: a plugin's security scope (tauri-plugin-fs) does not protect custom commands → every custom path-taking command enforces its own workspace-root check, with traversal/symlink/junction tests.
- [prd-review-3] 2026-09-03 LESSON: claimed identity for byte-identical duplicates after an external swap, which is information-theoretically impossible → state the limit; in-app ops track identity live, external edits resolve by position.
- [prd-review-3] 2026-09-03 LESSON: one flag (blockedOnHuman) carried two meanings (Michael's gate vs my interactive session) → separate `execution` field: loop | interactive-principal | human.
- [prd-review-3] 2026-09-03 LESSON: git refuses one branch in two worktrees, so "parallel worktrees on the phase branch" could not run → task/<id> branches, integration by the loop script, tests re-run post-integration.
- [prd-review-3] 2026-09-03 LESSON: "one task one commit" contradicted wip/recovery commits and `git pull --rebase` before checking for a dirty tree would fail exactly when recovery was needed → wip commits on the task branch, one squashed acceptance commit at integration; status/recover first, rebase second.
- [prd-review-3] 2026-09-03 LESSON: a macro (review-set) had no single canonical expanded acceptance and the expanded graph was never validated → one canonical acceptance in the conventions; validator checks the expanded graph and its count.
- [prd-review-3] 2026-09-03 LESSON: an optional feature phase sat on the release's critical path → the release gate accepts the feature disabled; visibility gated on provider === null, not an empty URL.
- [prd-review-3] 2026-09-03 LESSON: tasks needed pushes, releases, and cross-repo commits but the container had no git credentials → the container never pushes; every remote-needing task is split into an agent part and a human push part.
- [prd-review-3] 2026-09-03 LESSON: I wrote `grok exec` from a blog post; the docs say `grok -p` → verify CLI syntax against the vendor's docs, not secondary sources, before it enters a task.
- [prd-review-3] 2026-09-03 LESSON: renaming a document's assets directory without rewriting its image URLs breaks every image → rename rewrites relative URLs under rollback; deletion trashes doc + sidecar + assets together.

## From Sol PRD audit #3 (2026-09-03)

- [prd-review-4] 2026-09-03 LESSON: nine tasks asserted remote CI results while the container had no credentials and no owner for the push → `needsCI` flag expands into a human CI gate (push exact SHA, wait, fetch to /logs/ci/<id>, record run URL); agent acceptance stops at "validated locally".
- [prd-review-4] 2026-09-03 LESSON: transcripts written inside task worktrees vanished with the worktree → one host-owned evidence dir mounted as /logs everywhere; worktree removal never touches it.
- [prd-review-4] 2026-09-03 LESSON: no operation ever moved a reviewed phase to main, so release tags could point at the wrong code → `N.close` runner task under the integration lock; the tag is created on the resulting main SHA.
- [prd-review-4] 2026-09-03 LESSON: sequential reviewers could read earlier reports and drift from independent judgement → one review_sha, three parallel worktrees, reports outside the repo until reconciliation.
- [prd-review-4] 2026-09-03 LESSON: a blocking review finding did not block dependents → severity rule: blocker fails reconciliation, fix tasks + replacement review set, dependents rewritten; phase cannot close with an open blocker.
- [prd-review-4] 2026-09-03 LESSON: "integrate in the order they finish" is prose, not a protocol → flock + compare-and-swap `git update-ref` with expected-old SHA.
- [prd-review-4] 2026-09-03 LESSON: the human installed an RC built before the fixes he was approving → rc2 packaged after fixes; the human gate names the RC it approves.
- [prd-review-4] 2026-09-03 LESSON: "absolute paths are rejected" and "resolved paths beneath root are allowed" contradicted → root-relative contract; absolute → InvalidPath; root itself valid only for list/watch.
- [prd-review-4] 2026-09-03 LESSON: merge=union on a file with a rewritten header region corrupts under parallel work → append-only journals per stream + a generated summary written only under the lock; union only on purely append-only files.
- [prd-review-4] 2026-09-03 LESSON: a failing `git push --dry-run` does not prove credentials are absent → inspect env, credential helpers and agent sockets, then assert the exact auth-failure reason against a controlled private remote.
- [prd-review-4] 2026-09-03 LESSON: three audits in a row each found contradictions introduced by the previous round's fixes → after any structural revision, re-run the audit before Lock; the cost of a review round is far below the cost of a loop that stalls on day one.

## From Sol PRD audit #4 (2026-09-04)

- [prd-review-5] 2026-09-04 LESSON: every phase-close asserted head == review SHA, but reconciliation commits after the review → three SHAs (implementation, reconciliation, close); close checks only docs changed between the first two; a SHA is never written into the commit it names.
- [prd-review-5] 2026-09-04 LESSON: the integration text moved the branch before testing in one paragraph and after in another → one transaction: build candidate without moving the ref, test detached, CAS update-ref, then flip state.
- [prd-review-5] 2026-09-04 LESSON: tracked tasks.json with mutable `passes` plus journal entries containing their own commit SHA made atomic integration impossible → immutable spec in git, mutable state in .evidence/state, journals carry no SHA.
- [prd-review-5] 2026-09-04 LESSON: read-only reviewers were required to commit → `reviewer` mode produces evidence files, not commits; reconciliation lands them.
- [prd-review-5] 2026-09-04 LESSON: human gates wrote DECISIONS.md with no branch or lock → gate.sh writes evidence; a generated record-<id> runner task commits it.
- [prd-review-5] 2026-09-04 LESSON: 0.0 could not be first-unblocked-0.1 without 0.0 being passed → bootstrap.sh initialises state after 0.0's checks.
- [prd-review-5] 2026-09-04 LESSON: Phase 0's three-OS evidence came from a CI run before most of the code existed → N.verify + CI gate at the implementation SHA before every review set.
- [prd-review-5] 2026-09-04 LESSON: a static graph cannot express "coach ships in v0.1 if it finishes first" → decide: coach ships in v0.2.0 via post/0.1; 4.close creates phase/5 and phase/6 together.
- [prd-review-5] 2026-09-04 LESSON: retrospective tasks ran after the release close with no path to main → post-release phase with its own close and tag.
- [prd-review-5] 2026-09-04 LESSON: the rc2 tag pointed at the commit before the version bump; release notes were written after the final review → tag the bump commit; notes before review.
- [prd-review-5] 2026-09-04 LESSON: `claude -p` in the writing-room repo could run hooks, tools and MCP servers → context-only sandbox: temp dir, copied context, --tools "", no MCP, user-only settings, mutation test.
- [prd-review-5] 2026-09-04 LESSON: rc1 screenshots were being used as goldens for post-fix builds → rc1 captures are diagnostic; candidates after fixes; human visual approval; then baselines.
- [prd-review-5] 2026-09-04 LESSON: four audits of one growing PRD section → extract the orchestration into its own canonical spec (RUNNER-SPEC.md) and let the PRD summarise it.

## From Sol joint audit #5 (2026-09-04)

- [prd-review-6] 2026-09-04 LESSON: the first gate and its record task needed scripts created by the task that depended on them → bootstrap is one explicit host-run exception after a preflight checklist outside the graph; never let a bootstrap depend on generated infrastructure.
- [prd-review-6] 2026-09-04 LESSON: per-phase locks guarded a shared state file while two phases could run at once → one lock, strictly sequential phases; a lock must protect the resource being mutated.
- [prd-review-6] 2026-09-04 LESSON: ids no longer mapped one-to-one to branches (post/, cross-branch closes, external repo) → explicit targetBranch / sourceBranches / externalRepo fields.
- [prd-review-6] 2026-09-04 LESSON: "record the push, then push the record" recursion → final publication gates are evidence-only; human evidence enters the repo at reconciliation, not as its own commit.
- [prd-review-6] 2026-09-04 LESSON: record commits between N.verify and the review meant CI never ran at the reviewed SHA → no commits between verification and review; the runner asserts verification_sha == implementation_sha.
- [prd-review-6] 2026-09-04 LESSON: "exactly one review set per phase" vs replacement review sets, and a `'` suffix in ids → review attempts `<id>.rN` in a linear chain; ids stay shell-safe.
- [prd-review-6] 2026-09-04 LESSON: dynamically appended tasks never reached runtime state → sync-state transaction after every planning commit.
- [prd-review-6] 2026-09-04 LESSON: failure states existed with no way out → retry / resume / resolve-conflict / abandon with defined transitions and an audit log.
- [prd-review-6] 2026-09-04 LESSON: CI behaviour lived in prose → a validated `ci` object per gate; gate.sh executes fields, never infers.
- [prd-review-6] 2026-09-04 LESSON: tags named versions the source did not contain, and a conditional release path was unreachable → version task before every tag, release invariant asserted at close, one deterministic release path (v0.2.0).
- [prd-review-6] 2026-09-04 LESSON: `--setting-sources user` still loads user hooks while the test only planted project hooks → disable all settings sources, inline context into the prompt, test user-level and project-level attacks and the process tree.
- [prd-review-6] 2026-09-04 LESSON: a product assembled from independently tested branches was tagged after a local suite only → every phase, including the one that adds the coach, has its own verify + review before close.
- [prd-review-6] 2026-09-04 LESSON: when the protocol keeps failing audits, remove the hard parts (concurrency) rather than specifying them further; the fifth audit's blockers were mostly consequences of allowing concurrent phases.

## From Sol joint audit #6 (2026-09-04)

- [prd-review-7] 2026-09-04 LESSON: the close checked `targetBranch` (main) against the phase's reconciliation SHA, which is false by definition → assert the source branch; the validator enforces the field.
- [prd-review-7] 2026-09-04 LESSON: close moved main, then tested → build and test the proposed commit detached, then move main and the tag in one ref transaction, then write evidence.
- [prd-review-7] 2026-09-04 LESSON: generated CI gates violated the human-task schema they were generated into → generated tasks must satisfy the same validator as hand-written ones.
- [prd-review-7] 2026-09-04 LESSON: pushing a moving phase branch cannot test an exact SHA → immutable per-gate refs `ci/<id>/r<n>`, deleted after fetch.
- [prd-review-7] 2026-09-04 LESSON: a replacement review had no new verifier, so its verification assertion could never hold → every review attempt gets its own verifier and CI gate.
- [prd-review-7] 2026-09-04 LESSON: task status and review verdict were one thing → separate machine-readable verdict; the reconciliation task passes even when the verdict fails.
- [prd-review-7] 2026-09-04 LESSON: required artifacts to match a tag before the tag existed → split the invariant into close-time (versions, ancestry) and publication-time (run, artifacts, checksums, URL).
- [prd-review-7] 2026-09-04 LESSON: a REJECT on an approval gate had no legal transition; retry only accepted failed tasks → every gate has ACCEPT and REJECT/GATE-FAILED outcomes; rejection appends a principal re-plan and fresh attempts, never mutates passed tasks.
- [prd-review-7] 2026-09-04 LESSON: a merge-commit close would tag a never-verified SHA → fast-forward-only closes; main never moves except at a close.
- [prd-review-7] 2026-09-04 LESSON: replan destination, external target ref, external verify command lived in prose → replanTarget and four external fields, validated.
- [prd-review-7] 2026-09-04 LESSON: description said `--setting-sources ""`, acceptance said `--setting-sources user` → one earlier principal task pins the exact argv against the real CLI and both cite it.
- [prd-review-7] 2026-09-04 LESSON: the retrospective ran before the project's final review → state the cutoff and carry the final review's lessons forward explicitly.

## From Sol joint audit #7 (2026-09-04)

- [prd-review-8] 2026-09-04 LESSON: a no-commit human gate was expected to append tasks to the immutable spec → runner-native `plan-gate`: the gate raises a request; the principal answers with one planning commit.
- [prd-review-8] 2026-09-04 LESSON: gate outcomes lived only in evidence files, so a REJECT would still satisfy dependencies → outcome mirrored into runtime state; dependency = passed + ACCEPT.
- [prd-review-8] 2026-09-04 LESSON: attempt numbering said both r<k> and r<k+1> → attempts start at r0, next is always k+1, ids never collide.
- [prd-review-8] 2026-09-04 LESSON: close moved refs before writing evidence and created the next branch afterwards, so a crash mid-way was unrecoverable → intent record first, all refs in one transaction, finalise after, idempotent retry.
- [prd-review-8] 2026-09-04 LESSON: the close compared main to a base SHA no record stored → phases.json with base_main_sha, written by bootstrap and by every close.
- [prd-review-8] 2026-09-04 LESSON: a hard-coded candidate task (6.3b) would validate a failed RC after a replacement → approvedCandidateGate resolved from the newest ACCEPT; the verifier's CI gate is the final-package gate at the exact SHA.
- [prd-review-8] 2026-09-04 LESSON: an RC was tagged before any task set the RC version in the source → version task before every tag, including RCs.
- [prd-review-8] 2026-09-04 LESSON: a publication failure after the final tag had no legal path → transient rerun or a hotfix mini-phase with a new version; never plan-gate a shipped tag.
- [prd-review-8] 2026-09-04 LESSON: the next phase could start while the previous publication gate was pending → next phase depends on the publication gate.
- [prd-review-8] 2026-09-04 LESSON: observation gates (an evaluation that says "coach disabled") were indistinguishable from approval rejections → gateKind; observations always ACCEPT when complete, results live in the payload.
- [prd-review-8] 2026-09-04 LESSON: a template token (`r<n>`) sat in a field the runner "executes exactly" → refTemplate with a defined ordinal source; the expanded ref is written to run.json.
- [prd-review-8] 2026-09-04 LESSON: external-repo state was consumed but never initialised → bootstrap validates and initialises it.

## From Sol joint audit #8 (2026-09-04)

- [prd-review-9] 2026-09-04 LESSON: `phases.json[N+1]` assumed numeric phase order, but the order is 4→6→5→terminal → close tasks carry explicit nextPhase/nextBranch; terminal closes write no record.
- [prd-review-9] 2026-09-04 LESSON: plan requests were prose with no identity, state or recovery → `plan.<gate>.r<n>` records with pending/running/resolved/abandoned and their own branch and integration.
- [prd-review-9] 2026-09-04 LESSON: one namespace (`a<n>`) meant both "rerun the same gate" and "new graph task" → execution attempts (`a<n>`, same id, same SHA) are separate from graph revisions (`.r<n>`, new ids).
- [prd-review-9] 2026-09-04 LESSON: consumers read `/logs/ci/<id>/` with no way to pick the accepted attempt → `accepted.json` manifest + `accepted` symlink; nobody reads a bare gate directory.
- [prd-review-9] 2026-09-04 LESSON: a hard-coded candidate gate could validate a pre-fix package after a replacement, and "ancestor" was too weak → resolve the candidate from the newest passing attempt's verifier; require sha == verification_sha.
- [prd-review-9] 2026-09-04 LESSON: "installers built at the exact SHA that will be tagged" was false (the tagged commit adds review docs) → say what is actually proven: same product tree, docs-only diff, publication gate validates the rebuilt packages.
- [prd-review-9] 2026-09-04 LESSON: a hotfix "template" in prose could not run (verify before version, no publication, dependents never unblocked) → hotfix is a planned phase using the generic template, with supersession of the failed publication gate.
- [prd-review-9] 2026-09-04 LESSON: close records omitted what authorised the release and which OIDs were intended → versioned close-record schema with refs[{ref, expected_old, intended}], tag object and target OIDs.
- [prd-review-9] 2026-09-04 LESSON: human evidence was a single mutable file per gate → attempt-scoped records with an accepted pointer.
- [prd-review-9] 2026-09-04 LESSON: initial review ids (`6.5d`) and the attempt grammar (`<id>.r<k>d`) disagreed → physical `r0` ids everywhere.
- [prd-review-9] 2026-09-04 LESSON: a promised feature (risk-triggered reviews) had no task, trigger or evidence → removed rather than specified.
- [prd-review-9] 2026-09-04 LESSON: eight audits in, the runner still had no executable conformance check → bootstrap runs a conformance suite against fixture repos covering every transition the spec names.
- [prd-review-9] 2026-09-04 LESSON: "open questions to answer before Lock" sat in the PRD after Michael had answered them → record answers in DECISIONS the turn they are given.

## From Sol joint audit #9 (2026-09-04)

- [prd-review-10] 2026-09-04 LESSON: the validator's own rule (publication ⇒ outcomes) rejected the declared tasks → every schema rule gets a fixture that exercises the declared graph, not just hypothetical inputs.
- [prd-review-10] 2026-09-04 LESSON: pre-review verifier repairs and review attempts shared the `r<n>` namespace → repairs are `g<n>`, review attempts `r<n>`; `verifier_id` is recorded from the actual dependency.
- [prd-review-10] 2026-09-04 LESSON: a hotfix planning commit landed on a branch other than the one the hotfix ran on → the runner creates the new phase branch first, then the planning commit lands on it; no `open` task.
- [prd-review-10] 2026-09-04 LESSON: plan requests could enter states their enum did not have → a transition table for plan requests mirroring the task lifecycle.
- [prd-review-10] 2026-09-04 LESSON: RC tags were immutable and therefore unrepairable → RCs are packaged from immutable ci refs as artifacts; the only tag ever created is the final release tag at close.
- [prd-review-10] 2026-09-04 LESSON: a patch after a failed publication could not create a successor branch that already existed → the patch close advances an unstarted successor branch by CAS inside its transaction.
- [prd-review-10] 2026-09-04 LESSON: a completed close had no defined re-entry → validate the record, confirm refs, return no-op or fail loudly on drift.
- [prd-review-10] 2026-09-04 LESSON: human `accepted.json` had no schema and a task read the runner outcome for a domain result → schema with payload; tasks read named payload fields.
- [prd-review-10] 2026-09-04 LESSON: "no agent on the host" contradicted bootstrap and the Grok fallback → one scoped rule listing the exact host exceptions.

## From Sol joint audit #10 (2026-09-05)

- [prd-review-11] 2026-09-05 LESSON: six of eight blockers were in patch-phase machinery that v1 will rarely if ever exercise → removed it; publication gates are trailing and a post-tag failure halts for a principal decision; corrections ship in the next phase.
- [prd-review-11] 2026-09-05 LESSON: integration moved the ref and then wrote state, so a crash between them was unrecoverable → intent record before the first side effect for integration, external integration and gate transitions; re-entry rules per intent.
- [prd-review-11] 2026-09-05 LESSON: gate repair was defined only for the r0 review → verifier grammar `N.verify[.r<k>][.g<n>]`; whichever unstarted attempt depended on the failed gate is rewired.
- [prd-review-11] 2026-09-05 LESSON: a workflow was told to "test the rc1 artifacts" that only existed on the host → the gate commits a producer manifest (run id, SHA, hashes) on the pushed ref and the workflow downloads and verifies from that run.
- [prd-review-11] 2026-09-05 LESSON: "no API keys anywhere" contradicted the product's optional coach key → scope absolute statements to the actors they cover.
- [prd-review-12] 2026-09-05 LESSON: a trailing publication gate needed terminal-transition semantics the runner could not give it (COMPLETE with a halted gate) → the runner ends at the phase close; publishing is a manual checklist (docs/PUBLISH.md) with a v1.1 backlog line, not a gate kind.
- [prd-review-12] 2026-09-05 LESSON: intent files needed a re-entry rule per step and three of them had holes (deleted before post-ref effects, discarded attempts with remote side effects) → detection over journaling: `candidate/<id>` tag before every ref move, `run.json` before every remote wait, a read-only `doctor` naming exactly one `admin` command per finding, `run` refusing until clean.
- [prd-review-12] 2026-09-05 LESSON: an attempt that already pushed a ref or started a workflow run was "rolled back" on crash → attempts with remote side effects are resumed by id or explicitly abandoned, never discarded.
- [prd-review-12] 2026-09-05 LESSON: a gate that commits (6.2's measure.json) silently broke the exact-SHA invariant every other gate relied on → gates never commit; the producer task commits every workflow input.
- [prd-review-12] 2026-09-05 LESSON: "rerun the same run after fixing the workflow" is impossible — the workflow file lives in the tree → reruns exist only for transient failures against the same SHA; any workflow change is a `.g<n>` repair.
- [prd-review-12] 2026-09-05 LESSON: a CI manifest without run_id and digests cannot be checked by its consumers → every accepted.json carries run_id and per-artifact SHA-256, and every consumer verifies them.
- [prd-review-12] 2026-09-05 LESSON: the same command list existed in two places (0.0 description, RUNNER-SPEC §11) and drifted (`plan --new-phase`, duplicates) → one list is canonical and the other says "exactly as listed in".
- [prd-review-12] 2026-09-05 LESSON: eleven planning rounds with a stated budget: rounds 1–3 fixed the product, rounds 4–11 fixed the runner, and every runner blocker after round 5 was resolved best by removing a feature → set the budget and the cut rule before round one, and cut at the budget instead of specifying further.

## From task 0.0 (2026-09-05, bootstrap on the Mac Mini)

- [0.0] 2026-09-05 LESSON: Claude Code on macOS keeps its login in the Keychain, not in `~/.claude`, so "mount `~/.claude` read-only into the container" cannot work → the container logs in once itself and keeps its state in a named volume (DECISIONS #012); check where a CLI stores credentials before planning a mount.
- [0.0] 2026-09-05 LESSON: git worktree metadata stores absolute host paths, which break under a bind mount at a different path → mount the repo at `/work` and at its host path; never rewrite `.git` files.
- [0.0] 2026-09-05 LESSON: macOS ships no `flock` binary, so a spec that says `flock` cannot run on the host → an `O_EXCL` lock file with stale-pid recovery gives the same one-lock semantics without a dependency.
- [0.0] 2026-09-05 LESSON: `corepack prepare --activate` as root leaves the non-root agent user with a runtime download prompt → install pnpm with `npm install -g` and disable corepack in agent images.
- [0.0] 2026-09-05 LESSON: under `set -e`, `out=$(cmd)` aborts the script when `cmd` fails, exactly at the step whose failure was the point → write `rc=0; out=$(cmd) || rc=$?` for expected failures.
- [0.0] 2026-09-05 LESSON: a runner test suite found three spec readings that could not run (fix tasks depending on a superseded gate; close records demanding equality for branches that legitimately advance; a `run` that stops after one task) → conformance fixtures before the first real phase, and record each reading in DECISIONS the day it is taken.
- [0.0] 2026-09-05 LESSON: `tauri-driver` has no `--version` flag → record cargo-installed tool versions with `cargo install --list`, not by invoking the binary.
- [0.1] 2026-09-05 LESSON: the "30 turns for setup" budget ended task 0.1 at turn 31 with the scaffold written but no journal entry (error_max_turns) → no Phase 0 task is "setup"; every implementation task gets 50 turns (`RALPH_SETUP_TASKS=""` on the runner, to become the default at the Phase 0 reconciliation).
- [0.1] 2026-09-06 LESSON: attempt 2 ended its turn with `pnpm install` still running in the background ("I will pick back up"), so nothing was journaled or committed → PROMPT.md rule: never end a turn while a process you started is running; installs and builds run in the foreground.
- [0.1] 2026-09-06 LESSON: attempt 3 spent ~15 turns reading vitest internals because `pnpm coverage` printed no per-file table (vitest 5 switches to a compact reporter when it detects an agent environment) and its last turns on a cold Tauri compile under xvfb → for 0.1: configure coverage reporters explicitly (`coverage.reporter: ['text', 'html']` and a plain `default` test reporter, or set the env vitest checks) instead of investigating; run `cargo build` in `apps/desktop/src-tauri` in the foreground once, then `xvfb-run -a pnpm tauri dev` with a bounded wait and `xdotool`/`xprop`-free check (the window title check can read the Tauri log line or use `wmctrl` if present); `git rm -r --cached coverage && echo coverage/ >> .gitignore` first (the recovery commit 477be2c added coverage output); lint and tests already pass on this branch — do not re-verify from scratch, run them once at the end.
- [0.1] 2026-09-06 LESSON: three attempts re-oriented from zero and re-ran install/lint/test before touching the remaining work → when a branch already has wip commits, read `git log --stat` of them and the last journal/lessons lines, then go straight to what is missing.
- [0.1] 2026-09-06 LESSON: the container has no `wmctrl`/`xdotool`/`xprop` and no root to install one, so a Tauri window title cannot be checked with those tools → compile a throwaway ~30-line Xlib program with the system `gcc`/`libX11.so` (both already present) that walks the window tree and prints `WM_NAME`/`_NET_WM_NAME`; run it against `DISPLAY=:99` after `Xvfb :99 ... &` and `DISPLAY=:99 pnpm tauri dev &`, then kill the tauri/vite/cargo processes and Xvfb. `coverage.reporter: [["text",{skipFull:false}],"html"]` plus `test.reporters: ["default"]` (not just `reporter: ["text"]`) is what actually restores the per-file table.
- [0.2] 2026-09-06 LESSON: 0.2 acceptance names `actionlint` and `act --dryrun` but the 0.0 image had neither, so three attempts ended honestly without DONE (agent finding DECISIONS #013) → both are pinned in docker/versions.env and installed in the image since fix(image) befc9b2: run `actionlint .github/workflows/ci.yml` and `act -n` (act plans jobs without a Docker socket; if it refuses, record the exact error in the journal and treat actionlint + the hand check as the local acceptance, per #013); an acceptance that names a tool is a pin the bootstrap must provide.
- [0.2] 2026-09-06 LESSON: `git update-ref` moves a branch but not the index of a checkout sitting on it, so the next commit from that checkout reverts the integrated task → the runner refreshes clean checkouts after every ref move; never commit on a checkout of a branch the runner moves without `doctor` clean first (DECISIONS #repair-phase0-checkout).
