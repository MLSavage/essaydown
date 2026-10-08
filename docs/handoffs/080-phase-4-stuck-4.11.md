# Handoff 080: Phase 4, plan.4.2h.r0 integrated → `STUCK 4.11` on an acceptance defect

Written 2026-10-08 by the principal, the Opus 5.5 session that continued from 079. Fable planned the 4.2h repair and Michael answered its three questions. The plan integrated, and 4.11 then stopped correctly three times on a defect in its own acceptance text. This handoff supersedes `079-phase-4-4.2h-gate-failed-plan-gate.md`.

This handoff is committed on `handoff/080`, cut from `phase/4` at `1449568`. Read it with `git show handoff/080:docs/handoffs/080-phase-4-stuck-4.11.md`. The content of `handoff/077`–`handoff/079` is already in `phase/4`: the planning commit cherry-picked it, and `git diff phase/4 handoff/079 -- docs/handoffs` is empty. The refs are not ancestors only because cherry-picks have new SHAs, so they need no further cherry-pick; delete them after `4.close`. The next handoff is `081-*.md`.

## Current State

- **Branches.**
  - `main` is at `8aba511`, the same as origin.
  - `phase/4` is at `1449568` (`plan(plan.4.2h.r0)`), the same as `origin/phase/4` (Michael pushed `7be39d4..1449568`).
- **Status:** `Phase 4, idle; last passed 4.2; gates open: none; plan requests: none; blocked: 4.11:blocked`. `doctor` is clean.
- **Runner:** stopped after `STUCK 4.11`. Pane `essaydown:runner` (pid 8940) is at `zsh`, and no runner process or lock exists.
  - Restart line, only after the planning commit, `sync-state` and a dry run that names the replacement task: `tmux send-keys -t essaydown:runner 'ralph/ralph.sh run --phase 4 2>&1 | tee -a .evidence/runner.log' Enter`.
- **4.11 (opus), 3 attempts, `blocked`.** Branch `task/4.11`, tip `9cc240b`, worktree `.wt/4.11`, transcripts `.evidence/tasks/4.11/{1,2,3}.log`.
  - Every deliverable except acceptance (5) is committed and green (lint, test 80 files / 7883 tests, cargo 87). Every guard is a named test; attempt 1's journal names each one.
  - The code is in one commit, `6147620`: both scripts, both test files, and `tests/fixtures/sidecars/member.{tar.gz,tar.xz,zip}`.
  - Lessons: `437b5f9` (attempt 1), `51a2ba3` (attempt 2), `9cc240b` (attempt 3). The other commits are journal stubs and completions.
- **Watcher:** stopped at rotation. Re-arm it as a persistent Monitor (30-minute cap) with `start=275135` and `NR<=k`. `k` is the RAW grep count at arm time; it was 22 at rotation, and the last line is `STUCK 4.11`:
  ```
  setopt nullglob; cd /Users/mlsavage/Developer/essaydown; start=275135; while true; do tail -n +"$start" .evidence/runner.log | grep -E "^(HUMAN_GATE|STUCK|NO-JOURNAL|NO-COMMIT|INTEGRATION-FAILED|CONFLICT|DOCTOR|ITERATIONS|PRINCIPAL|REPLAN|PLAN-GATE|STALE-CHECKOUT|REVIEW-SHA-MISMATCH|CLOSED|GATE-FAILED|ROTATE-PRINCIPAL|CLOSE-DRIFT|USAGE-LIMIT|WARN) |^<promise>COMPLETE|^\[ralph\] "; sleep 30; done 2>/dev/null | awk 'NR<=22 { seen[$0]=1 } !seen[$0]++ { print; fflush() }'
  ```
- **Expected next stop:** none until the replacement is planned. After that, the replacement task, 4.12 and 4.2.g1 run, and the next stop is `HUMAN_GATE 4.2.g1h`.

## The STUCK (read from the three transcripts)

- 4.11's acceptance (5) reads "`pnpm tauri build` succeeds in the container and the Linux app contains the Linux binaries". The principal copied it verbatim from 4.2's acceptance into plan.4.2h.r0 (DECISIONS #060), so the defect is the principal's text.
- `tauri.conf.json` has `"targets": "all"`, so the build makes deb, rpm and AppImage.
  - Attempt 1: the release compile (about 20 s warm), deb and AppImage fit within `timeout 540`, but the rpm step ran past 540 s twice.
  - Attempt 2: `--bundles rpm` alone also ran past 540 s (rc 124 at "Bundling Essay Down-0.1.0-1.aarch64.rpm").
  - Attempt 3: the cause is the rpm bundler's default payload compression over about 225 MB of real sidecars (pandoc 175 MB, typst 49 MB). With compression off through a CLI config override, the rpm built in one bounded call (exit 0): 244 MB, containing `./usr/bin/desktop`, `./usr/bin/pandoc` and `./usr/bin/typst`.
- Each attempt refused to count a variant as the bare command, and none would edit `tauri.conf.json` (out of scope). CLAUDE.md's rule is to stop and not decide, and that was the right call.
- 4.2's journal says "tauri build in container (deb/rpm/AppImage all built …)". It does not say whether that run was bounded. Read 4.2's transcripts (`.evidence/tasks/4.2/`, including the `*.integration-failed` ones) before trusting it.

## Corrections

- **079, Current State "Watcher … `k` … 18":** stale; it is 22.
- **079, Current State "`phase/4` … 2 commits ahead":** stale. Michael pushed, and it is even with origin.
- **079, "Delete them after `4.close`" / next-prompt "first cherry-picks `handoff/077`, `handoff/078`, `handoff/079`":** no cherry-pick is needed any more. Their content entered `phase/4` in `1449568`, so the reconciliation cherry-picks only `handoff/080` and later.
- **079, "The 4.2h failure" item 5 "`close.spec.ts:52`":** the assertion that failed is at `:73` (`'Hello\n'` on disk for `'HelloX\n'`). It is backlogged as `[plan.4.2h.r0, close.spec :73 …]`.
- **079, item 3 "Likely cause, not yet verified":** verified. The check is `import.meta.url === \`file://${process.argv[1]}\``, which is false for `C:\…`.

## Decisions

- **DECISIONS #060** (in `phase/4` via `1449568`): the 4.2h gate repair.
  - Appended 4.11 (opus), 4.12 (sonnet, url-trail `30_000`), 4.2.g1 (needsCI) and 4.2.g1h. 4.3's producer dependency became `4.2.g1`. `EXPECTED_COUNT` 380 → 384.
  - Four backlog lines `[plan.4.2h.r0, …]`: close.spec :73, `bundle_dmg.sh`, the macOS universal target, and Windows tar.xz via the host tar.
  - It records Michael's option-(A) choice and its SHA-256 condition, as the principal's report.
- **Michael's answers (2026-10-08), recorded in #060:**
  - file `bundle_dmg.sh` with a trigger (a recurrence comes back to him);
  - leave the universal target to 6.1;
  - 4.11 on opus;
  - zip via `unzip -p` off win32 and the absolute `%SystemRoot%\System32\tar.exe -xOf` on win32, with no hand-written zip reader. That was his question, the principal found no reason for a reader, and the reason is in the task text.
- **Fable (written brief, PLAN-GATE):** the split, the dev slice copies (not `--target universal-apple-darwin`), and close.spec and dmg filed rather than taken. The principal confirmed that ci.yml's `lipo -info` reads the universal files in `binaries/` and that `binaries/` is gitignored.
- **No runner deviation.**

## Gotchas

- **An acceptance sentence copied from a passed task inherits that task's environment.** 4.2's "`pnpm tauri build` succeeds" held, if bounded at all, before the replacement's bound was tested. With real sidecars, the rpm bundle runs past CLAUDE.md's 540 s bound in this arm64 container. A container build acceptance should name the bundle (`--bundles deb`, `--bundles appimage`) and what is listed from it.
- **`git merge-base --is-ancestor handoff/NNN phase/4` fails after a cherry-pick even when the content is in.** Compare content (`git diff phase/4 handoff/NNN -- docs/handoffs`) before stacking on an old ref.
- **4.11's attempts cost little:** 31, 8 and a few turns. All three stopped on the same sentence, so a retry without a text change only spends attempts.

## Next Steps

1. Run `status` (expect `blocked: 4.11:blocked`) and `doctor` (clean). Give Michael the one-line state.
2. **Fable (STUCK after three is a trigger).** Write a brief:
   - **the signal:** `STUCK 4.11`;
   - **the evidence:** "The STUCK" above, `.evidence/tasks/4.11/{1,2,3}.log`, the three `[4.11]` lessons lines on `task/4.11`, `apps/desktop/src-tauri/tauri.conf.json`, and 4.2's transcripts for whether its container build was bounded;
   - **the one question:** acceptance (5)'s replacement in the successor task:
     - (A) bounded per-bundle builds (`--bundles deb`, then `--bundles appimage`) listing `usr/bin/` from `dpkg-deb -c` and the AppDir, with the rpm named as out of the container's bound, and no config change;
     - (B) set rpm payload compression in `tauri.conf.json`, which changes the shipped Linux rpm and is Michael's call;
     - (C) other;
   - **the answer format:** decision, reasons, confidence, the successor's full task text and acceptance.

   The principal's lean is (A): it is the smallest change and keeps product config out of a gate repair (#021). The rpm packaging question would be filed with a trigger at 6.1.
3. **Michael's OK on the route** before the planning commit, as at #052–#054. If the answer is (B), the config change is his decision.
4. **The planning commit, by #052's manual procedure.**
   - `ralph/ralph.sh abandon 4.11 --reason "acceptance (5) unmeetable within the 540 s bound; replaced by 4.13 (DECISIONS #061)"`. This is destructive: `task/4.11` becomes `abandoned/4.11` (tip `9cc240b`). Read #052's reversal first.
   - On the host checkout, on `phase/4`, with the runner idle and `doctor` clean (#017), append **4.13** (opus, deps `["4.2h"]`) to PRD §8.
     - Its text is 4.11's with acceptance (5) replaced. Its first step cherry-picks `6147620` from `abandoned/4.11` (code only; its suite was green) and reruns the suite.
     - The three `[4.11]` lessons lines are carried verbatim. The `- [4.11]` journal lines stay on the abandoned branch.
   - Rewire 4.12 from `"4.11"` to `"4.13"`. 4.11's row stays byte-identical.
   - `EXPECTED_COUNT` 384 → 385. Run `generate-tasks` and `validate-tasks`, and read the deps of 4.12 and 4.13 with `node -e`.
   - Write DECISIONS #061: Fable, Michael's OK, the route and its reversal. Commit with the reversal in the message.
   - Then `ralph/ralph.sh sync-state`, `doctor`, and `ralph/ralph.sh run --phase 4 --dry-run`, which must name `4.13`. Only then restart and re-arm the watcher (`k` recounted).
5. **After that:** `HUMAN_GATE 4.2.g1h`. Run `scripts/gate.sh 4.2.g1h` in the background and read its output file. Then come 4.3, 4.4, `HUMAN_GATE 4.verifyh` and review set `4.5`. `PRINCIPAL 4.5.r0d` is run by a fresh session that first cherry-picks `handoff/080` and any later handoff not yet in `phase/4`.

## Open Questions

- **For Fable (via the brief):** acceptance (5)'s replacement, (A), (B) or (C).
- **For Michael:** the replacement route (OK needed, as at #052). If (B), whether the shipped rpm's compression changes.
- **For the principal:** whether 4.2's container `tauri build` was bounded. The answer decides whether 4.2's journal claim needs a correction line in #061.
