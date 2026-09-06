// doctor.mjs — `ralph.sh doctor` (read-only drift detection, RUNNER-SPEC §4.6), `admin` repairs,
// recovery commands (§4.5), plan-request commands (§2), sync-state (§6).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RalphError, withLock, git, gitOut, revParse, refOid, isAncestor, rmrf, now, readJson, ZERO } from "./util.mjs";
import { emit, ciAttemptStatus } from "./gate.mjs";
import { repoOf, targetRefOf, finishIntegration, setPlan, startTask } from "./integrate.mjs";
import { syncState } from "./state.mjs";
import { writeSummary } from "./summary.mjs";
import { refDrifted } from "./close.mjs";

function expectedOldOf(repo, candidate) {
  const m = /^Expected-old: ([0-9a-f]{40})/m.exec(gitOut(repo, ["log", "-1", "--format=%B", candidate]));
  return m ? m[1] : null;
}

/** Returns [{line, admin}] — each line names the one admin command that fixes it. */
export function doctor(ctx) {
  ctx.requireInit();
  const out = [];
  const add = (line, admin) => out.push({ line: `${line} → ${admin}`, admin });
  const s = ctx.state();
  for (const t of ctx.spec()) {
    const r = s[t.id];
    if (!r) { add(`no-record ${t.id}`, "ralph.sh sync-state"); continue; }
    const repo = repoOf(ctx, t);
    const commitTask = ["loop", "replan", "interactive-principal", "loop-external"].includes(t.execution);
    if (commitTask && (r.status === "running" || r.status === "principal-pending") && !existsSync(ctx.worktree(t.id))) add(`running-no-worktree ${t.id}`, `ralph.sh retry ${t.id}`);
    const cand = refOid(repo, `refs/tags/candidate/${t.id}`);
    if (cand && r.status !== "passed") {
      const target = targetRefOf(ctx, t);
      const cur = refOid(repo, target);
      const old = expectedOldOf(repo, cand);
      const where = cur === cand ? "target == candidate" : cur === old ? "target == expected-old" : "target == neither";
      add(`unfinished-integration ${t.id} (${where})`, cur === cand ? `ralph.sh admin mark-integrated ${t.id}` : cur === old ? `ralph.sh admin retry ${t.id}` : `manual repair: DECISIONS.md#repair-${t.id}`);
    }
    if (r.status === "passed" && r.integrated_sha && commitTask) {
      const target = targetRefOf(ctx, t);
      const cur = refOid(repo, target);
      if (!cur || !isAncestor(repo, r.integrated_sha, cur)) add(`passed-not-on-target ${t.id} (${r.integrated_sha.slice(0, 7)} not an ancestor of ${target})`, `manual repair: DECISIONS.md#repair-${t.id}`);
    }
    if (t.execution === "human" && t.gateKind === "ci") {
      for (const n of ctx.attempts(t.id)) {
        const st = ciAttemptStatus(ctx, t.id, n);
        const recorded = (r.status === "passed" && r.accepted_gate_attempt === n) || (["blocked", "superseded"].includes(r.status) && r.attempts >= n) || st === "abandoned";
        if (st === "incomplete" && !recorded) add(`incomplete ${t.id} a${n}`, `scripts/gate.sh ${t.id} --resume a${n}`);
        if (st === "accepted-unrecorded" && !recorded) add(`incomplete ${t.id} a${n} (workflow succeeded, state not transitioned)`, `scripts/gate.sh ${t.id} --resume a${n}`);
        if (st === "rejected" && !recorded && r.status !== "superseded") add(`incomplete ${t.id} a${n} (workflow failed, state not transitioned)`, `scripts/gate.sh ${t.id} --resume a${n}`);
      }
    }
    if (t.execution === "human" && t.gateKind !== "ci") {
      const dir = ctx.humanDir(t.id);
      for (const n of ctx.attempts(t.id)) {
        const recorded = r.attempts >= n && ["passed", "blocked", "superseded"].includes(r.status);
        if (!recorded && existsSync(join(dir, `a${n}.md`))) add(`incomplete ${t.id} a${n} (record on disk, no state transition)`, `scripts/gate.sh ${t.id} --resume a${n}`);
      }
    }
  }
  for (const p of ctx.plans()) {
    if (p.status === "running" && !refOid(ctx.root, `refs/heads/${p.branch}`)) add(`plan-running-no-branch ${p.id}`, `ralph.sh admin resolve-request ${p.id} --state pending`);
    const cand = refOid(ctx.root, `refs/tags/candidate/${p.id}`);
    if (cand && p.status !== "resolved") {
      const cur = refOid(ctx.root, `refs/heads/${p.target_branch}`), old = expectedOldOf(ctx.root, cand);
      add(`unfinished-integration ${p.id} (${cur === cand ? "target == candidate" : cur === old ? "target == expected-old" : "target == neither"})`, cur === cand ? `ralph.sh admin mark-integrated ${p.id}` : cur === old ? `ralph.sh admin retry ${p.id}` : `manual repair: DECISIONS.md#repair-${p.id}`);
    }
  }
  // checkouts on runner-moved branches with staged changes (a stale index after update-ref looks exactly like this)
  for (const block of gitOut(ctx.root, ["worktree", "list", "--porcelain"]).split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const br = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (!path || !br || !/^(main|phase\/\d+)$/.test(br) || !existsSync(path)) continue;
    if (git(ctx.root, ["-C", path, "diff", "--cached", "--quiet"], { check: false }).status !== 0) add(`stale-checkout ${path} (staged changes on ${br}; if they are not yours the index is stale)`, `git -C ${path} stash && git -C ${path} reset --hard ${br} && git -C ${path} stash pop`);
  }
  // external repos
  const ext = join(ctx.evidence, "external");
  if (existsSync(ext)) for (const id of readdirSync(ext)) {
    const st = readJson(join(ext, id, "state.json"), null);
    if (!st) continue;
    const t = ctx.spec().find((x) => x.externalRepoId === id);
    if (!t) continue;
    const repo = repoOf(ctx, t);
    const cur = refOid(repo, st.target_ref);
    const want = st.head_sha ?? st.base_sha;
    if (cur !== want) add(`external-drift ${id} (${st.target_ref} ${cur?.slice(0, 7)} != recorded ${want?.slice(0, 7)})`, `manual repair: DECISIONS.md#repair-external-${id}`);
  }
  // close records
  const closes = join(ctx.evidence, "closes");
  if (existsSync(closes)) for (const f of readdirSync(closes)) {
    if (!/^\d+\.json$/.test(f)) continue;
    const rec = readJson(join(closes, f));
    for (const r of rec.refs) if (refDrifted(ctx, rec, r)) add(`close-drift ${rec.phase} (${r.ref} != ${r.intended_oid.slice(0, 7)})`, `manual repair: DECISIONS.md#repair-${rec.phase}.close`);
  }
  return out;
}

// ---------- admin (§4.6) ----------
export function adminMarkIntegrated(ctx, id) {
  return withLock(ctx.root, () => {
    const plan = ctx.plans().find((p) => p.id === id) ?? null;
    const t = plan ? null : ctx.task(id);
    const repo = plan ? ctx.root : repoOf(ctx, t);
    const cand = refOid(repo, `refs/tags/candidate/${id}`);
    if (!cand) throw new RalphError(`admin mark-integrated ${id}: no candidate/${id} tag`);
    const target = plan ? `refs/heads/${plan.target_branch}` : targetRefOf(ctx, t);
    if (refOid(repo, target) !== cand) throw new RalphError(`admin mark-integrated ${id} refused: ${target} != candidate/${id} (use admin retry if it equals expected-old)`);
    const finding = doctor(ctx).find((f) => f.line.startsWith(`unfinished-integration ${id} `));
    ctx.audit(`admin mark-integrated ${id}`, finding ? finding.line : "(no doctor line)");
    finishIntegration(ctx, id, { plan, candidate: cand });
    if (plan) { syncState(ctx, { ref: cand, allowSupersede: [plan.gate] }); ctx.set(plan.gate, { status: "superseded", notes: `superseded by ${plan.id}` }, "plan resolved (admin)"); }
    else if (t.reviewSet && /d$/.test(t.id)) { const { afterIntegration } = importRunLazily(); afterIntegration(ctx, t, cand); }
    return { id, sha: cand };
  });
}

export function adminRetry(ctx, id) {
  return withLock(ctx.root, () => {
    const plan = ctx.plans().find((p) => p.id === id) ?? null;
    const t = plan ? null : ctx.task(id);
    const repo = plan ? ctx.root : repoOf(ctx, t);
    const cand = refOid(repo, `refs/tags/candidate/${id}`);
    if (!cand) throw new RalphError(`admin retry ${id}: no candidate/${id} tag`);
    const target = plan ? `refs/heads/${plan.target_branch}` : targetRefOf(ctx, t);
    const old = expectedOldOf(repo, cand);
    if (refOid(repo, target) !== old) throw new RalphError(`admin retry ${id} refused: ${target} != expected-old ${old?.slice(0, 7)} (use admin mark-integrated if it equals the candidate)`);
    const finding = doctor(ctx).find((f) => f.line.startsWith(`unfinished-integration ${id} `));
    ctx.audit(`admin retry ${id}`, finding ? finding.line : "(no doctor line)");
    git(repo, ["tag", "-d", `candidate/${id}`]);
    if (plan) setPlan(ctx, id, { status: "running" }, "admin retry: re-queued from the rebase");
    else ctx.set(id, { status: t.execution === "interactive-principal" ? "principal-pending" : "running", notes: "admin retry: re-queued from the rebase" }, "admin retry");
    return { id };
  });
}

export function adminResolveRequest(ctx, id, state) {
  const allowed = ["pending", "running", "blocked", "integration-failed", "resolved", "abandoned"];
  if (!allowed.includes(state)) throw new RalphError(`--state must be one of ${allowed.join("|")}`);
  return withLock(ctx.root, () => { ctx.audit(`admin resolve-request ${id}`, `--state ${state}`); return setPlan(ctx, id, { status: state, ...(state === "resolved" || state === "abandoned" ? { resolved_at: now() } : {}) }, "admin resolve-request"); });
}

// ---------- recovery (§4.5) ----------
export function retry(ctx, id) {
  return withLock(ctx.root, () => {
    const r = ctx.rec(id);
    if (!["blocked", "integration-failed"].includes(r.status)) throw new RalphError(`retry ${id}: status is ${r.status}, not blocked/integration-failed`);
    const t = ctx.task(id);
    if (t.execution === "human") throw new RalphError(`retry ${id}: a gate is re-run with scripts/gate.sh rerun ${id}`);
    ctx.set(id, { status: "pending", attempts: 0, no_commit_streak: 0, outcome: null, notes: `retry (was ${r.status})` }, "retry");
    return { id };
  });
}
export function resume(ctx, id) {
  return withLock(ctx.root, () => {
    const r = ctx.rec(id);
    if (r.status !== "blocked") throw new RalphError(`resume ${id}: status is ${r.status}, not blocked`);
    const t = ctx.task(id);
    ctx.set(id, { status: t.execution === "interactive-principal" ? "principal-pending" : "running", notes: "resumed after a manual fix" }, "resume");
    return { id };
  });
}
export function resolveConflict(ctx, id) {
  return withLock(ctx.root, () => {
    const r = ctx.rec(id);
    if (r.status !== "blocked") throw new RalphError(`resolve-conflict ${id}: status is ${r.status}`);
    const t = ctx.task(id);
    const repo = repoOf(ctx, t), wt = ctx.worktree(id);
    if (!existsSync(wt)) throw new RalphError(`resolve-conflict ${id}: worktree ${wt} missing`);
    if (gitOut(repo, ["-C", wt, "status", "--porcelain"])) throw new RalphError(`resolve-conflict ${id}: worktree still dirty; commit the resolution first`);
    ctx.set(id, { status: t.execution === "interactive-principal" ? "principal-pending" : "running", notes: "conflict resolved by hand" }, "resolve-conflict");
    return { id };
  });
}
export function abandon(ctx, id, reason) {
  if (!reason) throw new RalphError("--reason required");
  return withLock(ctx.root, () => {
    const t = ctx.task(id);
    const repo = repoOf(ctx, t);
    const r = ctx.rec(id);
    if (r.status === "passed") throw new RalphError(`abandon ${id}: passed tasks are never edited`);
    const wt = ctx.worktree(id);
    if (existsSync(wt)) { git(repo, ["worktree", "remove", "--force", wt], { check: false }); rmrf(wt); }
    if (refOid(repo, `refs/heads/task/${id}`)) git(repo, ["branch", "-m", `task/${id}`, `abandoned/${id}`]);
    ctx.set(id, { status: "abandoned", notes: reason }, "abandon");
    return { id };
  });
}

// ---------- plan requests (§2) ----------
export function planStart(ctx, requestId) {
  return withLock(ctx.root, () => {
    const p = ctx.plans().find((x) => x.id === requestId);
    if (!p) throw new RalphError(`unknown plan request ${requestId}`);
    if (p.status !== "pending") throw new RalphError(`plan ${requestId}: status is ${p.status}, not pending`);
    const { wt } = startTask(ctx, requestId, { plan: p });
    setPlan(ctx, requestId, { status: "running" }, `branch ${p.branch}`);
    console.log(`[ralph] plan ${requestId}: worktree ${wt} on ${p.branch}; add fix tasks + replacements to PRD §8 and ralph/tasks.json, commit wip(${requestId}) with <promise>DONE ${requestId}</promise>, then ralph.sh run`);
    emit(`PRINCIPAL ${requestId}`);
    return p;
  });
}
export function planRetry(ctx, requestId) {
  return withLock(ctx.root, () => {
    const p = ctx.plans().find((x) => x.id === requestId);
    if (!p) throw new RalphError(`unknown plan request ${requestId}`);
    if (!["blocked", "integration-failed"].includes(p.status)) throw new RalphError(`plan-retry ${requestId}: status is ${p.status}`);
    return setPlan(ctx, requestId, { status: "pending", attempts: 0 }, "plan-retry");
  });
}
export function planAbandon(ctx, requestId, reason) {
  if (!reason) throw new RalphError("--reason required");
  return withLock(ctx.root, () => {
    const p = ctx.plans().find((x) => x.id === requestId);
    if (!p) throw new RalphError(`unknown plan request ${requestId}`);
    if (!["blocked", "integration-failed", "pending"].includes(p.status)) throw new RalphError(`plan-abandon ${requestId}: status is ${p.status}`);
    const wt = ctx.worktree(requestId);
    if (existsSync(wt)) { git(ctx.root, ["worktree", "remove", "--force", wt], { check: false }); rmrf(wt); }
    if (refOid(ctx.root, `refs/heads/${p.branch}`)) git(ctx.root, ["branch", "-m", p.branch, `abandoned/${p.branch}`]);
    return setPlan(ctx, requestId, { status: "abandoned", reason: `${p.reason} | abandoned: ${reason}`, resolved_at: now() }, "plan-abandon");
  });
}

export function syncStateCmd(ctx, ref = null) {
  return withLock(ctx.root, () => { const r = syncState(ctx, { ref }); writeSummary(ctx); return r; });
}

function importRunLazily() { return globalThis.__ralphRun; }
export function registerRun(mod) { globalThis.__ralphRun = mod; }
