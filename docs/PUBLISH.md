# PUBLISH.md — publishing a release tag by hand

The runner ends at `N.close` (RUNNER-SPEC §9). Everything below is done by Michael on the host, once per release tag (`v0.1.0` after `6.close`, `v0.2.0` after `5.close`). It is deliberately a checklist, not a script: v1 has no publication machinery, and this procedure is the input to a `ralph.sh publish-check` in a v1.1 runner once it has run twice.

## Before you start

1. `ralph.sh doctor` is clean and `ralph.sh status` shows `N.close` passed.
2. Open `.evidence/closes/<N>.json`. Note `main_sha`, `tag.name`, `tag.tag_target_sha` (must equal `main_sha`), `candidate_gate_id` and `candidate_sha`.
3. Open `.evidence/ci/<candidate_gate_id>/accepted.json`. Note `run_id` and the `artifacts[].sha256` list. These are the digests the final packages must reproduce.

## Publish

4. `git push origin main` and `git push origin <tag.name>` (both from the host; containers never push).
5. `release.yml` runs on the tag. Wait for it. Record the run id and URL.
6. Check the publication invariant, by hand, and write each line into `.evidence/publish/<tag>/publish.md`:
   - workflow run SHA == `tag.tag_target_sha` == `main_sha`;
   - the GitHub Release named `<tag>` exists and its assets are the 4 installers + `SHA256SUMS.txt`, names carrying the version;
   - `SHA256SUMS.txt` verifies against the downloaded assets;
   - every asset's SHA-256 equals the digest of the same-named artifact in the candidate gate's `accepted.json`. A mismatch means the release build is not reproducible from the tagged tree: stop, do not announce the release, and record the mismatch in `DECISIONS.md#publish-<tag>` for a principal decision. (Expected sources: timestamps or signing inside the bundle — investigate before accepting; a reproducibility fix ships in the next phase.)
7. Copy the run log into `.evidence/publish/<tag>/run.log` and write `.evidence/publish/<tag>/run.json {run_id, url, sha, tag, outcome, checked_at}`.
8. Append `DECISIONS.md#publish-<tag>` (tag, main SHA, run id, URL, outcome, any mismatch) in the next reconciliation or, for a terminal phase, directly on `main` as a docs-only commit.

## If it fails

- **Transient** (runner outage, upload error, GitHub incident): re-run as a **fresh** workflow run on the same tag (`gh workflow run release.yml --ref <tag>`, or re-push nothing and use the Actions UI to run the workflow on the tag — never "re-run jobs" of the failed run, which reuses its id). Record every run in `publish.md`.
- **Workflow code is broken** (`release.yml` itself): it cannot be fixed for this tag, because the workflow file is part of the tagged tree. Record the failure in `DECISIONS.md#publish-<tag>`, leave the tag unpublished or publish the assets by hand from `/logs/ci/<candidate_gate_id>/accepted/` (say so in the release notes), and ship the workflow fix in the next phase. The tag is never deleted or repointed.
- **Product is broken**: nothing here fixes it; the correction ships in the next phase or a new project cycle (RUNNER-SPEC §9).

## Never

- Never re-point, delete or re-create a tag.
- Never edit `.evidence/state/`; publication has no state in the runner.
- Never publish from a container.
