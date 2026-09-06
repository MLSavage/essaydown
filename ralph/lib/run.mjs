// run.mjs — `ralph.sh run [--phase N]`: selection, one Ralph iteration per attempt, stop-check, reviews,
// principal hand-offs, human gates, closes (RUNNER-SPEC §4, §5, §11). Sequential; one lock per mutation.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { RalphError, withLock, revParse, refOid, git, gitOut, rmrf, now, shell, writeAtomic, ensureDir, readJson, writeJsonAtomic } from "./util.mjs";
import { emit, isVerifyGate } from "./gate.mjs";
import { startTask, integrate, journalCount, transcriptHasDone, branchHasDone, runSuite, repoOf, setPlan } from "./integrate.mjs";
import { doctor } from "./doctor.mjs";
import { closePhase } from "./close.mjs";
import { syncState } from "./state.mjs";
import { writeSummary } from "./summary.mjs";

const MAX_ITER = Number(process.env.RALPH_MAX_ITERATIONS ?? 15);
const MAX_ATTEMPTS = 3;
const SETUP_TASKS = (process.env.RALPH_SETUP_TASKS ?? "").split(/\s+/).filter(Boolean); // no Phase 0 task is "setup" (lessons 0.1)

/** First eligible unit of work in spec order (RUNNER-SPEC design rule: strictly sequential). */
export function selectNext(ctx, phase = null) {
  const spec = ctx.spec(), s = ctx.state();
  // in-flight first: running loop tasks, principal hand-offs, plan requests
  for (const t of spec) {
    const r = s[t.id];
    if (phase !== null && t.phase !== String(phase)) continue;
    if (!r) continue;
    if (r.status === "running" || r.status === "principal-pending") return { kind: "task", task: t, rec: r };
  }
  for (const p of ctx.plans()) if (p.status === "running" && (phase === null || p.phase === String(phase))) return { kind: "plan", plan: p };
  for (const t of spec) {
    const r = s[t.id];
    if (phase !== null && t.phase !== String(phase)) continue;
    if (!r || r.status !== "pending") continue;
    if (!ctx.satisfied(t.id, s)) continue;
    return { kind: "task", task: t, rec: r };
  }
  const pendingGates = spec.filter((t) => (phase === null || t.phase === String(phase)) && s[t.id]?.status === "human-pending");
  if (pendingGates.length) return { kind: "gate", task: pendingGates[0] };
  const left = spec.filter((t) => (phase === null || t.phase === String(phase)) && s[t.id] && !["passed", "superseded", "abandoned"].includes(s[t.id].status));
  return left.length ? { kind: "stuck", tasks: left } : { kind: "complete" };
}

export function dryRun(ctx, phase = null) {
  const sel = selectNext(ctx, phase);
  if (sel.kind === "task") {
    const t = sel.task;
    const branch = t.execution === "human" ? "(no branch: human gate)" : t.execution === "reviewer" ? `(snapshot worktree .wt/review-${t.reviewer})` : t.execution === "runner" ? "(no branch: runner close)" : `task/${t.id}`;
    return `next: ${t.id} (${t.execution}, ${t.model}) on ${branch} from ${t.targetBranch}`;
  }
  if (sel.kind === "plan") return `next: plan request ${sel.plan.id} on ${sel.plan.branch}`;
  if (sel.kind === "gate") return `waiting: HUMAN_GATE ${sel.task.id} (scripts/gate.sh ${sel.task.id})`;
  if (sel.kind === "stuck") return `stuck: ${sel.tasks.map((t) => `${t.id}:${ctx.state()[t.id].status}`).join(", ")}`;
  return "complete";
}

/** HUMAN_GATE, plus ROTATE-PRINCIPAL at a phase's verify gate: the principal session rotates there (PRINCIPAL.md, DECISIONS #015). */
function emitHumanGate(id) {
  emit(`HUMAN_GATE ${id}`);
  if (isVerifyGate(id)) emit("ROTATE-PRINCIPAL");
}

export function run(ctx, { phase = null } = {}) {
  const findings = doctor(ctx);
  if (findings.length) { for (const f of findings) console.log(f.line); emit(`DOCTOR ${findings.length} findings`); return { signal: "DOCTOR" }; }
  for (let i = 0; i < MAX_ITER; i++) {
    const sel = selectNext(ctx, phase);
    if (sel.kind === "complete") { emit("<promise>COMPLETE</promise>"); return { signal: "COMPLETE" }; }
    if (sel.kind === "gate") { emitHumanGate(sel.task.id); return { signal: "HUMAN_GATE", id: sel.task.id }; }
    if (sel.kind === "stuck") { const l = sel.tasks.map((t) => `${t.id}:${ctx.state()[t.id].status}`).join(", "); emit(`STUCK ${l}`); return { signal: "STUCK" }; }
    const res = sel.kind === "plan" ? stepPlan(ctx, sel.plan) : step(ctx, sel.task);
    if (res.signal) return res;
  }
  emit(`ITERATIONS ${MAX_ITER} reached`);
  return { signal: "ITERATIONS" };
}

function step(ctx, t) {
  const r = ctx.rec(t.id);
  switch (t.execution) {
    case "human":
      withLock(ctx.root, () => ctx.set(t.id, { status: "human-pending", started_at: now() }, "waiting for gate.sh"));
      writeSummary(ctx);
      emitHumanGate(t.id);
      return { signal: "HUMAN_GATE", id: t.id };
    case "runner":
      return stepClose(ctx, t);
    case "reviewer":
      return stepReview(ctx, t);
    case "interactive-principal":
      return stepPrincipal(ctx, t, r);
    case "loop": case "replan": case "loop-external":
      return stepLoop(ctx, t, r);
    case "bootstrap":
      throw new RalphError("0.0 runs only through ralph/bootstrap.sh");
    default:
      throw new RalphError(`${t.id}: unknown execution ${t.execution}`);
  }
}

/** One Ralph iteration (§4.2) then the stop-check (§4.3). */
function stepLoop(ctx, t, r) {
  const { branch, wt, base } = withLock(ctx.root, () => startTask(ctx, t.id));
  const repo = repoOf(ctx, t);
  const attempt = ctx.rec(t.id).attempts + 1;
  const before = { journal: journalCount(wt, t.id), head: revParse(repo, branch) };
  const logPath = join(ctx.taskLogDir(t.id), `${attempt}.log`);
  // recovery: a dirty tree from a crashed iteration is committed first
  if (gitOut(repo, ["-C", wt, "status", "--porcelain"])) { git(repo, ["-C", wt, "add", "-A"]); git(repo, ["-C", wt, "commit", "-q", "-m", `wip(${t.id}): recovery of uncommitted changes`]); }
  const maxTurns = SETUP_TASKS.includes(t.id) ? 30 : 50;
  const cmd = process.env.RALPH_ITERATION_CMD ?? `docker compose run --rm claude-task`;
  const env = { ESSAYDOWN_ROOT: ctx.root, RALPH_ATTEMPT: String(attempt), RALPH_MODEL: t.model, RALPH_MAX_TURNS: String(maxTurns), RALPH_TASK_ID: t.id, RALPH_WORKTREE: wt, RALPH_LOG: logPath };
  console.log(`[ralph] ${t.id} attempt ${attempt} (${t.execution}, ${t.model}, max-turns ${maxTurns}) in ${wt}`);
  shell(`${cmd} ${t.id}`, { cwd: ctx.root, env, check: false });
  // stop-check
  const journalOk = journalCount(wt, t.id) > before.journal;
  const head = revParse(repo, branch);
  const commitOk = head !== base;
  const newCommit = head !== before.head || gitOut(repo, ["-C", wt, "status", "--porcelain"]) !== "";
  const done = transcriptHasDone(logPath, t.id);
  if (gitOut(repo, ["-C", wt, "status", "--porcelain"])) { git(repo, ["-C", wt, "add", "-A"]); git(repo, ["-C", wt, "commit", "-q", "-m", `wip(${t.id}): recovery of uncommitted changes`]); }
  // an attempt that ends without a journal entry or without a commit still counts toward the three attempts (§4.3)
  const stuckOr = (signal, patch, why) => withLock(ctx.root, () => {
    if (attempt >= MAX_ATTEMPTS) { ctx.set(t.id, { ...patch, status: "blocked", attempts: attempt, notes: `${why} after ${attempt} attempts` }, "STUCK"); emit(`STUCK ${t.id} (${why})`); return { signal: "STUCK", id: t.id }; }
    ctx.set(t.id, { ...patch, attempts: attempt }, why);
    emit(`${signal} ${t.id}`);
    return { signal, id: t.id };
  });
  if (!journalOk) return stuckOr("NO-JOURNAL", { notes: "iteration ended without a journal entry" }, "no journal entry");
  const noCommitStreak = newCommit ? 0 : (Number(ctx.rec(t.id).no_commit_streak ?? 0) + 1);
  if (noCommitStreak >= 2) return stuckOr("NO-COMMIT", { no_commit_streak: noCommitStreak, notes: "no wip commit in two iterations" }, "no commit");
  let green = false;
  if (done && commitOk) green = t.execution === "loop-external" ? runSuite(ctx, wt, { external: t.externalVerify }) : runSuite(ctx, wt);
  if (done && commitOk && green) {
    return withLock(ctx.root, () => {
      ctx.set(t.id, { attempts: attempt, no_commit_streak: 0 }, "stop-check passed");
      const res = integrate(ctx, t.id);
      if (!res.ok) return { signal: res.signal, id: t.id };
      afterIntegration(ctx, t, res.sha);
      return {};
    });
  }
  const reason = !commitOk ? "no wip commit" : !done ? "no DONE promise" : "suite not green";
  return withLock(ctx.root, () => {
    if (attempt >= MAX_ATTEMPTS) {
      ctx.set(t.id, { status: "blocked", attempts: attempt, no_commit_streak: noCommitStreak, notes: `${reason} after ${attempt} attempts` }, "STUCK");
      emit(`STUCK ${t.id}`);
      return { signal: "STUCK", id: t.id };
    }
    ctx.set(t.id, { attempts: attempt, no_commit_streak: noCommitStreak, notes: reason }, `attempt ${attempt}: ${reason}`);
    return {};
  });
}

/** Steps after a successful integration that depend on the task kind. */
export function afterIntegration(ctx, t, sha) {
  if (t.execution === "replan" && t.replanTarget) {
    startTask(ctx, t.replanTarget, { status: "principal-pending" });
    emit(`REPLAN ${t.replanTarget}`);
  }
  if (t.reviewSet && /d$/.test(t.id)) {
    // reconciliation: record reconciliation_sha + verdict, then sync-state (planning commit)
    const dir = ctx.reviewDir(t.phase, t.reviewAttempt);
    writeAtomic(join(dir, "reconciliation_sha"), sha + "\n");
    const verdict = verdictFromDecisions(ctx, sha, t.phase, t.reviewAttempt);
    writeAtomic(join(dir, "verdict"), verdict + "\n");
    ctx.audit(`review ${t.phase} ${t.reviewAttempt}`, `reconciliation ${sha} verdict ${verdict}`);
    syncState(ctx, { ref: sha });
  }
}

export function verdictFromDecisions(ctx, sha, phase, attempt) {
  const r = git(ctx.root, ["show", `${sha}:docs/DECISIONS.md`], { check: false });
  if (r.status !== 0) return "FAIL";
  const m = new RegExp(`^## #review-${phase}-${attempt}\\b[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "m").exec(r.stdout);
  if (!m) return "FAIL";
  const v = /verdict:\s*(PASS|FAIL)/i.exec(m[0]);
  return v ? v[1].toUpperCase() : "FAIL";
}

/** interactive-principal: hand off, or integrate when the branch carries the DONE promise. */
function stepPrincipal(ctx, t, r) {
  const { branch, wt, base } = withLock(ctx.root, () => startTask(ctx, t.id, { status: "principal-pending" }));
  const repo = repoOf(ctx, t);
  if (!branchHasDone(repo, base, branch, t.id)) {
    writeSummary(ctx);
    emit(`PRINCIPAL ${t.id}`);
    console.log(`[ralph] ${t.id}: work in ${wt} on ${branch}; commit wip(${t.id}) with <promise>DONE ${t.id}</promise> in a commit message, then ralph.sh run again`);
    return { signal: "PRINCIPAL", id: t.id };
  }
  const attempt = r.attempts + 1;
  if (journalCount(wt, t.id) === 0) { emit(`NO-JOURNAL ${t.id}`); return { signal: "NO-JOURNAL", id: t.id }; }
  if (!runSuite(ctx, wt)) {
    return withLock(ctx.root, () => { ctx.set(t.id, { attempts: attempt, notes: "suite not green on the principal branch" }, "suite failed"); emit(`PRINCIPAL ${t.id} suite failed`); return { signal: "PRINCIPAL", id: t.id }; });
  }
  return withLock(ctx.root, () => {
    ctx.set(t.id, { attempts: attempt }, "stop-check passed");
    const res = integrate(ctx, t.id);
    if (!res.ok) return { signal: res.signal, id: t.id };
    afterIntegration(ctx, t, res.sha);
    return {};
  });
}

/** Plan request in `running`: integrate when the branch carries DONE <request-id>. */
function stepPlan(ctx, plan) {
  const { branch, wt, base } = withLock(ctx.root, () => startTask(ctx, plan.id, { plan }));
  if (!branchHasDone(ctx.root, base, branch, plan.id)) { emit(`PRINCIPAL ${plan.id}`); return { signal: "PRINCIPAL", id: plan.id }; }
  return withLock(ctx.root, () => {
    const res = integrate(ctx, plan.id, { plan });
    if (!res.ok) {
      if (res.signal === "CONFLICT" || ctx.plans().find((p) => p.id === plan.id).attempts + 1 >= MAX_ATTEMPTS) setPlan(ctx, plan.id, { status: res.signal === "CONFLICT" ? "blocked" : "integration-failed" }, res.signal);
      setPlan(ctx, plan.id, { attempts: ctx.plans().find((p) => p.id === plan.id).attempts + 1 }, "attempt");
      return { signal: res.signal, id: plan.id };
    }
    // planning commit landed: sync-state; the blocked gate → superseded (replaced by the commit's new tasks)
    const oldIds = new Set(ctx.spec().map((x) => x.id));
    syncState(ctx, { ref: res.sha, allowSupersede: [plan.gate] });
    const notRewired = ctx.dependents(plan.gate).filter((x) => oldIds.has(x.id) && ctx.state()[x.id]?.status === "pending").map((x) => x.id);
    if (notRewired.length) emit(`WARN ${plan.id}: pre-existing dependents of ${plan.gate} not rewired by the planning commit: ${notRewired.join(", ")}`);
    ctx.set(plan.gate, { status: "superseded", notes: `superseded by ${plan.id} (${res.sha.slice(0, 7)})` }, "plan resolved");
    writeSummary(ctx);
    return {};
  });
}

/** Review attempt r<k>: record metadata (§5.1), three parallel reviewers from one snapshot (§5.2). */
function stepReview(ctx, t) {
  const phase = t.phase, attempt = t.reviewAttempt, set = t.reviewSet;
  const trio = ["a", "b", "c"].map((s) => ctx.task(`${set}.${attempt}${s}`));
  const s = ctx.state();
  const todo = trio.filter((x) => ["pending", "running"].includes(s[x.id].status));
  if (!todo.length) return {};
  const dir = ensureDir(ctx.reviewDir(phase, attempt));
  const gateId = trio[0].dependencies.find((d) => /\.verify(\.r\d+)?(\.g\d+)?h$/.test(d));
  if (!gateId) throw new RalphError(`${trio[0].id}: no verifier gate among dependencies`);
  const verifierId = ctx.task(gateId).gateFor;
  const verificationSha = ctx.rec(verifierId).integrated_sha;
  const implementationSha = ctx.targetHead(trio[0].id);
  if (verificationSha !== implementationSha) { emit(`REVIEW-SHA-MISMATCH ${set}.${attempt}: verification ${verificationSha?.slice(0, 7)} != implementation ${implementationSha.slice(0, 7)}`); return { signal: "REVIEW-SHA-MISMATCH" }; }
  const baseSha = ctx.phases()[phase]?.base_main_sha ?? null;
  withLock(ctx.root, () => {
    writeAtomic(join(dir, "phase_base_sha"), `${baseSha}\n`);
    writeAtomic(join(dir, "verifier_id"), `${verifierId}\n`);
    writeAtomic(join(dir, "verification_sha"), `${verificationSha}\n`);
    writeAtomic(join(dir, "implementation_sha"), `${implementationSha}\n`);
    for (const x of todo) {
      const wt = ctx.worktree(`review-${x.reviewer}`);
      rmrf(wt); git(ctx.root, ["worktree", "prune"]);
      git(ctx.root, ["worktree", "add", "--quiet", "--detach", wt, implementationSha]);
      ensureDir(join(dir, x.reviewer));
      ctx.set(x.id, { status: "running", task_branch: null, started_at: now(), attempts: s[x.id].attempts + 1 }, "reviewer started");
    }
  });
  const svc = { claude: "claude-review", sol: "codex-review", grok: "grok-review" };
  const cmd = process.env.RALPH_REVIEW_CMD; // tests: "<script> <reviewer> <phase> <attempt>"
  // Parallel reviewers without the event loop: detached children write their exit code to a file; poll synchronously.
  for (const x of todo) {
    const line = cmd ? `${cmd} ${x.reviewer} ${phase} ${attempt}` : `docker compose run --rm ${svc[x.reviewer]} ${phase} ${attempt}`;
    const exitFile = join(dir, x.reviewer, "exit-code");
    rmrf(exitFile);
    const child = spawn("sh", ["-c", `${line}; echo $? > ${JSON.stringify(exitFile)}`], { cwd: ctx.root, detached: true, stdio: "ignore", env: { ...process.env, ESSAYDOWN_ROOT: ctx.root, REVIEW_PHASE: String(phase), REVIEW_ATTEMPT: attempt, REVIEW_DIR: dir, REVIEW_SNAPSHOT: ctx.worktree(`review-${x.reviewer}`) } });
    child.unref();
  }
  const results = [];
  for (const x of todo) {
    const exitFile = join(dir, x.reviewer, "exit-code");
    while (!existsSync(exitFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    results.push({ x, code: Number(readFileSync(exitFile, "utf8").trim()) });
  }
  return withLock(ctx.root, () => {
    let failed = 0;
    for (const { x, code } of results) {
      const ok = code === 0 && existsSync(join(dir, x.reviewer, "report.md")) && existsSync(join(dir, x.reviewer, "status.json"));
      if (ok) ctx.set(x.id, { status: "passed", finished_at: now(), integrated_sha: null }, "report ok");
      else { failed++; ctx.set(x.id, { status: "blocked", notes: `reviewer exit ${code}` }, "reviewer failed"); }
      const wt = ctx.worktree(`review-${x.reviewer}`);
      git(ctx.root, ["worktree", "remove", "--force", wt], { check: false }); rmrf(wt);
    }
    writeSummary(ctx);
    if (failed) { emit(`STUCK ${set}.${attempt} (${failed} reviewer(s) failed; ralph.sh retry <id>)`); return { signal: "STUCK" }; }
    return {};
  });
}

function stepClose(ctx, t) {
  const n = t.id.replace(/\.close$/, "");
  const res = closePhase(ctx, n);
  if (res.signal) return res;
  return {};
}
