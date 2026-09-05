// close.mjs — N.close (RUNNER-SPEC §8): transactional, idempotent phase close. Runner mode, no model.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { RalphError, withLock, git, gitOut, revParse, refOid, isAncestor, rmrf, now, writeJsonAtomic, readJson, ZERO, ensureDir } from "./util.mjs";
import { emit, readAcceptedCi } from "./gate.mjs";
import { runSuite } from "./integrate.mjs";
import { writeSummary } from "./summary.mjs";

const ALLOWLIST = [/^docs\//, /^DECISIONS\.md$/, /^ralph\/tasks\.json$/, /^ralph\/EXPECTED_COUNT$/];
const VERSION_FILES = ["package.json", "apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/Cargo.toml"];

function newestAttempt(ctx, phase) {
  const ds = ctx.spec().filter((t) => t.phase === String(phase) && t.reviewSet && /d$/.test(t.id)).map((t) => ({ t, k: Number(/\.r(\d+)d$/.exec(t.id)[1]) })).sort((a, b) => b.k - a.k);
  if (!ds.length) throw new RalphError(`phase ${phase}: no review attempt`);
  return ds[0].t;
}

export function versionFields(ctx, sha) {
  const out = [];
  for (const f of VERSION_FILES) {
    const r = git(ctx.root, ["show", `${sha}:${f}`], { check: false });
    if (r.status !== 0) continue;
    const m = f.endsWith(".toml") ? /^version\s*=\s*"([^"]+)"/m.exec(r.stdout) : /"version"\s*:\s*"([^"]+)"/.exec(r.stdout);
    if (m) out.push({ file: f, version: m[1] });
  }
  return out;
}

export function closePhase(ctx, phase) {
  ctx.requireInit();
  const closeTask = ctx.task(`${phase}.close`);
  const closes = ctx.closesDir();
  const finalPath = join(closes, `${phase}.json`);
  const intentPath = join(closes, `${phase}.intent.json`);
  return withLock(ctx.root, () => {
    // 0. re-entry
    if (existsSync(finalPath)) {
      const rec = readJson(finalPath);
      validateRecord(rec);
      const drift = rec.refs.filter((r) => (refOid(ctx.root, r.ref) ?? ZERO) !== r.intended_oid);
      if (drift.length) { emit(`CLOSE-DRIFT ${phase}: ${drift.map((d) => `${d.ref}=${(refOid(ctx.root, d.ref) ?? "absent").slice(0, 7)}≠${d.intended_oid.slice(0, 7)}`).join(", ")}`); return { signal: "CLOSE-DRIFT" }; }
      if (ctx.rec(closeTask.id).status !== "passed") ctx.set(closeTask.id, { status: "passed", integrated_sha: rec.main_sha, finished_at: now() }, "close re-entered (no-op)");
      emit(`CLOSED ${phase} (no-op: ${rec.main_sha.slice(0, 7)})`);
      return { ok: true, noop: true, record: rec };
    }
    if (existsSync(intentPath)) {
      const rec = readJson(intentPath);
      validateRecord(rec);
      const moved = rec.refs.filter((r) => refOid(ctx.root, r.ref) === r.intended_oid);
      if (moved.length === rec.refs.length) return finalise(ctx, phase, closeTask, rec, intentPath, finalPath);
      if (moved.length === 0) { rmrf(intentPath); ctx.audit(`close ${phase}`, "stale intent with no ref moved: re-running from preconditions"); }
      else throw new RalphError(`close ${phase}: partial ref state (${moved.length}/${rec.refs.length} moved) — impossible after an atomic transaction; repair by hand (DECISIONS.md#repair-${phase}.close)`);
    }
    // 1. preconditions
    const d = newestAttempt(ctx, phase);
    const dir = ctx.reviewDir(phase, d.reviewAttempt);
    const read = (f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : null);
    const verdict = read("verdict"), reconciliation = read("reconciliation_sha"), implementation = read("implementation_sha"), verification = read("verification_sha"), verifierId = read("verifier_id");
    if (verdict !== "PASS") throw new RalphError(`close ${phase}: newest attempt ${d.reviewAttempt} verdict is ${verdict ?? "missing"}, not PASS`);
    if (ctx.rec(d.id).status !== "passed") throw new RalphError(`close ${phase}: ${d.id} is ${ctx.rec(d.id).status}`);
    const source = closeTask.sourceBranches[0];
    const head = revParse(ctx.root, source);
    if (head !== reconciliation) throw new RalphError(`close ${phase}: ${source} head ${head?.slice(0, 7)} != reconciliation_sha ${reconciliation?.slice(0, 7)}`);
    const changed = gitOut(ctx.root, ["diff", "--name-only", implementation, reconciliation]).split("\n").filter(Boolean);
    const bad = changed.filter((f) => !ALLOWLIST.some((re) => re.test(f)));
    if (bad.length) throw new RalphError(`close ${phase}: product files changed between implementation and reconciliation: ${bad.join(", ")}`);
    const phases = ctx.phases();
    const base = phases[String(phase)]?.base_main_sha;
    if (!base) throw new RalphError(`close ${phase}: phases.json has no record for phase ${phase}`);
    const mainHead = revParse(ctx.root, "main");
    if (mainHead !== base) throw new RalphError(`close ${phase}: main ${mainHead?.slice(0, 7)} != base_main_sha ${base.slice(0, 7)} (fast-forward-only)`);
    if (!isAncestor(ctx.root, base, reconciliation)) throw new RalphError(`close ${phase}: main is not an ancestor of the proposed commit`);
    // 2. candidate: suite in a detached worktree
    const proposed = reconciliation;
    const cwt = ctx.worktree(`close-${phase}`);
    rmrf(cwt); git(ctx.root, ["worktree", "prune"]);
    git(ctx.root, ["worktree", "add", "--quiet", "--detach", cwt, proposed]);
    let green;
    try { green = runSuite(ctx, cwt); } finally { git(ctx.root, ["worktree", "remove", "--force", cwt], { check: false }); rmrf(cwt); }
    if (!green) throw new RalphError(`close ${phase}: suite failed on the proposed commit ${proposed.slice(0, 7)}`);
    // 3. release checks
    const rec = { schema: 1, close_id: closeTask.id, phase: String(phase), review_attempt: d.reviewAttempt, verifier_id: verifierId, verification_sha: verification, implementation_sha: implementation, reconciliation_sha: reconciliation, base_main_sha: base, main_sha: proposed, refs: [], written_at: null };
    if (closeTask.releaseVersion) {
      const v = closeTask.releaseVersion;
      const fields = versionFields(ctx, proposed);
      if (!fields.length) throw new RalphError(`close ${phase}: no version fields found in ${VERSION_FILES.join(", ")}`);
      const wrong = fields.filter((f) => f.version !== v);
      if (wrong.length) throw new RalphError(`close ${phase}: version fields != ${v}: ${wrong.map((f) => `${f.file}=${f.version}`).join(", ")}`);
      const gateId = `${verifierId}h`;
      const acc = readAcceptedCi(ctx, gateId);
      if (acc.sha !== verification) throw new RalphError(`close ${phase}: candidate gate ${gateId} accepted sha ${acc.sha.slice(0, 7)} != verification_sha ${verification.slice(0, 7)}`);
      if (!isAncestor(ctx.root, acc.sha, proposed)) throw new RalphError(`close ${phase}: candidate sha is not an ancestor of the proposed commit`);
      const tagName = `v${v}`;
      if (refOid(ctx.root, `refs/tags/${tagName}`)) throw new RalphError(`close ${phase}: tag ${tagName} already exists`);
      const tagger = `essaydown-runner <runner@essaydown.invalid> ${Math.floor(Date.now() / 1000)} +0000`;
      const tagObj = gitOut(ctx.root, ["mktag"], { input: `object ${proposed}\ntype commit\ntag ${tagName}\ntagger ${tagger}\n\nEssay Down ${tagName} (${closeTask.id}; candidate gate ${gateId} attempt a${acc.attempt}, run ${acc.run_id})\n` });
      rec.release_version = v; rec.candidate_gate_id = gateId; rec.candidate_attempt = acc.attempt; rec.candidate_sha = acc.sha;
      rec.tag = { name: tagName, tag_object_oid: tagObj, tag_target_sha: proposed };
      rec.refs.push({ ref: `refs/tags/${tagName}`, expected_old_oid: ZERO, intended_oid: tagObj });
    }
    rec.refs.unshift({ ref: "refs/heads/main", expected_old_oid: base, intended_oid: proposed });
    if (closeTask.nextPhase) {
      rec.next_phase = String(closeTask.nextPhase); rec.next_branch = closeTask.nextBranch;
      if (refOid(ctx.root, `refs/heads/${closeTask.nextBranch}`)) throw new RalphError(`close ${phase}: ${closeTask.nextBranch} already exists`);
      rec.refs.push({ ref: `refs/heads/${closeTask.nextBranch}`, expected_old_oid: ZERO, intended_oid: proposed });
    }
    // 4. intent
    rec.written_at = now();
    writeJsonAtomic(intentPath, rec);
    if (process.env.RALPH_CRASH_AFTER === "close-intent") throw new RalphError(`injected crash after close intent (${phase})`, { exit: 99 });
    // 5. one ref transaction
    const stdin = ["start", ...rec.refs.map((r) => `update ${r.ref} ${r.intended_oid} ${r.expected_old_oid}`), "prepare", "commit", ""].join("\n");
    const tx = git(ctx.root, ["update-ref", "--stdin"], { input: stdin, check: false });
    if (tx.status !== 0) throw new RalphError(`close ${phase}: ref transaction failed, nothing moved: ${tx.stderr.trim()}`);
    if (process.env.RALPH_CRASH_AFTER === "close-refs") throw new RalphError(`injected crash after close ref transaction (${phase})`, { exit: 99 });
    return finalise(ctx, phase, closeTask, rec, intentPath, finalPath);
  });
}

function finalise(ctx, phase, closeTask, rec, intentPath, finalPath) {
  if (rec.next_phase) {
    const phases = ctx.phases();
    if (!phases[rec.next_phase]) { phases[rec.next_phase] = { phase: rec.next_phase, branch: rec.next_branch, base_main_sha: rec.main_sha, created_by: closeTask.id, created_at: now() }; ctx.savePhases(phases); }
  }
  renameSync(intentPath, finalPath);
  ctx.set(closeTask.id, { status: "passed", integrated_sha: rec.main_sha, finished_at: now() }, `closed; main ${rec.main_sha.slice(0, 7)}`);
  ctx.audit(`close ${phase}`, `main=${rec.main_sha} refs=${rec.refs.map((r) => r.ref).join(",")}`);
  writeSummary(ctx);
  emit(`CLOSED ${phase} main ${rec.main_sha.slice(0, 7)}${rec.tag ? " tag " + rec.tag.name : ""}${rec.next_branch ? " next " + rec.next_branch : ""}`);
  return { ok: true, record: rec };
}

function validateRecord(rec) {
  for (const f of ["schema", "close_id", "phase", "review_attempt", "verifier_id", "verification_sha", "implementation_sha", "reconciliation_sha", "base_main_sha", "main_sha", "refs", "written_at"]) if (rec[f] === undefined) throw new RalphError(`close record lacks ${f}`);
  if (rec.schema !== 1) throw new RalphError(`close record schema ${rec.schema} unsupported`);
  if (!Array.isArray(rec.refs) || !rec.refs.length) throw new RalphError("close record has no refs");
  for (const r of rec.refs) for (const f of ["ref", "expected_old_oid", "intended_oid"]) if (typeof r[f] !== "string") throw new RalphError(`close record ref lacks ${f}`);
}
