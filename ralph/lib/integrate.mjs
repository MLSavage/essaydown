// integrate.mjs — task start, the integration transaction (RUNNER-SPEC §4.1, §4.4) and the external variant (§7).
// The only way a target branch moves. candidate/<id> is tagged before the CAS update-ref (crash safety, §4.6).
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { RalphError, git, gitOut, revParse, refOid, refExists, rmrf, now, firstLine, shell, writeJsonAtomic, readJson, ensureDir, ZERO } from "./util.mjs";
import { emit } from "./gate.mjs";
import { writeSummary } from "./summary.mjs";

/** Repo a task's commits live in: the external repo for loop-external, else the project root. */
export function repoOf(ctx, t) { return t.execution === "loop-external" ? resolve(ctx.root, t.externalRepoPath.replace(/^\/work\//, "")) : ctx.root; }
export function targetRefOf(ctx, t) { return t.execution === "loop-external" ? t.externalTargetRef : `refs/heads/${t.targetBranch}`; }

function branchOf(t, plan) { return plan ? plan.branch : `task/${t.id}`; }

/** §4.1 Start: branch + worktree from the target head; state running. Idempotent when both exist. */
export function startTask(ctx, id, { plan = null, status = "running" } = {}) {
  const t = plan ? null : ctx.task(id);
  const repo = plan ? ctx.root : repoOf(ctx, t);
  const branch = plan ? plan.branch : `task/${id}`;
  const wt = ctx.worktree(plan ? plan.id : id);
  let baseRef;
  if (plan) baseRef = `refs/heads/${plan.target_branch}`;
  else if (t.execution === "loop-external") { baseRef = t.externalTargetRef; }
  else baseRef = `refs/heads/${t.targetBranch}`;
  const base = refOid(repo, baseRef);
  if (!base) throw new RalphError(`${baseRef} does not exist in ${repo}`);
  if (!refExists(repo, `refs/heads/${branch}`)) git(repo, ["branch", branch, base]);
  if (!existsSync(wt)) { ensureDir(ctx.wt); git(repo, ["worktree", "add", "--quiet", wt, branch]); }
  if (!plan) ctx.set(id, { status, task_branch: branch, started_at: ctx.rec(id).started_at ?? now() }, "start");
  return { branch, wt, base };
}

/** Transitive dependency closure of a task, spec order. */
export function closure(ctx, id) {
  const seen = new Set();
  const visit = (x) => { for (const d of ctx.task(x).dependencies) if (!seen.has(d)) { seen.add(d); visit(d); } };
  visit(id);
  return ctx.spec().map((t) => t.id).filter((x) => seen.has(x));
}

/** Suite on a tree (host side: RALPH_SUITE_CMD <path>; default runs ralph/stop-check.sh in the container). */
export function runSuite(ctx, treePath, { external = null } = {}) {
  if (external) { const r = shell(external, { cwd: treePath, check: false }); return r.status === 0; }
  const cmd = process.env.RALPH_SUITE_CMD ?? `docker compose run --rm --entrypoint /work/ralph/stop-check.sh claude-task`;
  const rel = `/work/${resolve(treePath).slice(ctx.root.length + 1)}`;
  const r = shell(`${cmd} ${JSON.stringify(process.env.RALPH_SUITE_CMD ? treePath : rel)}`, { cwd: ctx.root, check: false, env: { ESSAYDOWN_ROOT: ctx.root } });
  return r.status === 0;
}

/**
 * §4.4 Integration transaction for a task (loop / interactive-principal / replan / loop-external) or a plan request.
 * Returns {ok, sha} or throws with a stop signal recorded in state.
 */
export function integrate(ctx, id, { plan = null } = {}) {
  const t = plan ? null : ctx.task(id);
  const repo = plan ? ctx.root : repoOf(ctx, t);
  const branch = branchOf(t, plan);
  const targetRef = plan ? `refs/heads/${plan.target_branch}` : targetRefOf(ctx, t);
  const wt = ctx.worktree(plan ? plan.id : id);
  const label = plan ? plan.id : id;
  const rec = plan ? null : ctx.rec(id);
  const external = t?.execution === "loop-external";

  const expectedOld = refOid(repo, targetRef);
  if (!expectedOld) throw new RalphError(`${targetRef} missing`);
  // rebase the branch onto the target head (the only rebase in the lifecycle)
  const rb = git(repo, ["-C", wt, "rebase", "--quiet", expectedOld], { check: false });
  if (rb.status !== 0) {
    git(repo, ["-C", wt, "rebase", "--abort"], { check: false });
    if (plan) setPlan(ctx, plan.id, { status: "blocked" }, "rebase conflict");
    else ctx.set(id, { status: "blocked", notes: `rebase conflict onto ${expectedOld.slice(0, 7)}` }, "CONFLICT");
    emit(`CONFLICT ${label}`);
    return { ok: false, signal: "CONFLICT" };
  }
  const branchHead = revParse(repo, branch);
  if (branchHead === expectedOld) throw new RalphError(`${label}: branch ${branch} has no commits beyond ${targetRef}`);
  // squashed candidate without moving anything
  const tree = gitOut(repo, ["rev-parse", `${branchHead}^{tree}`]);
  const msg = plan
    ? `plan(${plan.id}): planning commit for ${plan.gate} (${plan.trigger_outcome} at ${plan.trigger_attempt})\n\nTrigger-sha: ${plan.trigger_sha}\nEvidence: ${plan.evidence_path}\nReason: ${plan.reason}\n\nExpected-old: ${expectedOld}\n`
    : `task(${id}): ${firstLine(t.description)}\n\n${t.acceptance}\n\nDepends-on: ${closure(ctx, id).join(", ") || "none"}\nExpected-old: ${expectedOld}\n`;
  const candidate = gitOut(repo, ["commit-tree", tree, "-p", expectedOld, "-m", msg]);
  // detached test of the candidate
  const cwt = ctx.worktree(`candidate-${label}`);
  rmrf(cwt); git(repo, ["worktree", "prune"]);
  git(repo, ["worktree", "add", "--quiet", "--detach", cwt, candidate]);
  const suiteNeeded = plan ? true : (external || id !== "0.0");
  let green = true;
  try { if (suiteNeeded) green = runSuite(ctx, cwt, { external: external ? t.externalVerify : null }); }
  finally { git(repo, ["worktree", "remove", "--force", cwt], { check: false }); rmrf(cwt); }
  const attempts = plan ? plan.attempts : rec.attempts;
  if (!green) {
    git(repo, ["tag", "-f", `wip/${label}-${attempts}`, branchHead]);
    if (plan) setPlan(ctx, plan.id, { status: "integration-failed" }, "detached test failed");
    else ctx.set(id, { status: "integration-failed", notes: `candidate ${candidate.slice(0, 7)} failed the suite` }, "INTEGRATION-FAILED");
    emit(`INTEGRATION-FAILED ${label}`);
    return { ok: false, signal: "INTEGRATION-FAILED" };
  }
  // candidate tag before the ref move
  git(repo, ["tag", "-f", `candidate/${label}`, candidate]);
  ctx.audit(`integrate ${label}`, `candidate ${candidate} expected_old ${expectedOld} target ${targetRef}`);
  if (process.env.RALPH_CRASH_AFTER === "candidate-tag") throw new RalphError(`injected crash after candidate tag (${label})`, { exit: 99 });
  const upd = git(repo, ["update-ref", targetRef, candidate, expectedOld], { check: false });
  if (upd.status !== 0) throw new RalphError(`${label}: CAS update-ref failed (${targetRef} moved from ${expectedOld.slice(0, 7)}); candidate/${label} kept, run ralph.sh doctor`);
  if (process.env.RALPH_CRASH_AFTER === "update-ref") throw new RalphError(`injected crash after update-ref (${label})`, { exit: 99 });
  finishIntegration(ctx, id, { plan, candidate, branchHead, repo, branch, wt });
  return { ok: true, sha: candidate };
}

/** Post-ref steps (also what `admin mark-integrated` completes): state, summary, wip tag, cleanup. */
export function finishIntegration(ctx, id, { plan = null, candidate, branchHead = null, repo = null, branch = null, wt = null }) {
  const t = plan ? null : ctx.task(id);
  repo ??= plan ? ctx.root : repoOf(ctx, t);
  branch ??= branchOf(t, plan);
  wt ??= ctx.worktree(plan ? plan.id : id);
  branchHead ??= revParse(repo, branch);
  const label = plan ? plan.id : id;
  if (plan) {
    setPlan(ctx, plan.id, { status: "resolved", planning_sha: candidate, resolved_at: now() }, `planning commit ${candidate.slice(0, 7)}`);
  } else {
    ctx.set(id, { status: "passed", integrated_sha: candidate, finished_at: now() }, `integrated ${candidate.slice(0, 7)}`);
    if (t.execution === "loop-external") {
      const p = join(ctx.externalDir(t.externalRepoId), "state.json");
      const st = readJson(p, { target_ref: t.externalTargetRef, base_sha: null });
      writeJsonAtomic(p, { ...st, integrated: { ...(st.integrated ?? {}), [id]: candidate }, head_sha: candidate, updated_at: now() });
    }
  }
  if (branchHead) git(repo, ["tag", "-f", `wip/${label}`, branchHead], { check: false });
  git(repo, ["tag", "-d", `candidate/${label}`], { check: false });
  if (existsSync(wt)) git(repo, ["worktree", "remove", "--force", wt], { check: false });
  rmrf(wt);
  git(repo, ["worktree", "prune"], { check: false });
  git(repo, ["branch", "-D", branch], { check: false });
  writeSummary(ctx);
  ctx.audit(`integrated ${label}`, candidate);
}

export function setPlan(ctx, id, patch, why) {
  const plans = ctx.plans();
  const p = plans.find((x) => x.id === id);
  if (!p) throw new RalphError(`unknown plan request ${id}`);
  const before = p.status;
  Object.assign(p, patch);
  ctx.savePlans(plans);
  ctx.audit(`plan ${id}`, `${before} -> ${p.status}${why ? " (" + why + ")" : ""}`);
  return p;
}

/** Journal entry count for a task in a tree (PRD entry template: "- [<id>] <ISO> ..."). */
export function journalCount(tree, id) {
  const p = join(tree, "docs/progress/journal-main.md");
  if (!existsSync(p)) return 0;
  const re = new RegExp(`^- \\[${id.replace(/[.]/g, "\\.")}\\] `);
  return readFileSync(p, "utf8").split("\n").filter((l) => re.test(l)).length;
}

export function transcriptHasDone(logPath, id) {
  if (!existsSync(logPath)) return false;
  return readFileSync(logPath, "utf8").includes(`<promise>DONE ${id}</promise>`);
}

export function branchHasDone(repo, base, branch, id) {
  const r = git(repo, ["log", "--format=%B", `${base}..${branch}`], { check: false });
  return r.status === 0 && r.stdout.includes(`<promise>DONE ${id}</promise>`);
}
