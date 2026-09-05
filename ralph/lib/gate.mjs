// gate.mjs — scripts/gate.sh: human gates and CI gates (RUNNER-SPEC §2, §3). Gates never commit.
// Fixed order under the lock: (1) attempt record on disk with its remote identity, (2) evidence +
// accepted.json on ACCEPT, (3) outcome + status, (4) exactly one plan request when demanded.
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { RalphError, withLock, now, ensureDir, writeJsonAtomic, readJson, digestDir, symlinkForce, git, revParse } from "./util.mjs";
import { ciAdapter } from "./ci.mjs";

export function emit(signal) { process.stdout.write(`${signal}\n`); }

/** Create the plan request for a gate outcome (step 4). Returns the request id. */
export function raisePlanRequest(ctx, gateId, attempt, outcome, evidencePath, reason) {
  const plans = ctx.plans();
  const t = ctx.task(gateId);
  const n = plans.filter((p) => p.gate === gateId).length;
  const id = `plan.${gateId}.r${n}`;
  const rec = ctx.rec(gateId);
  const producer = t.gateFor ? ctx.rec(t.gateFor) : null;
  plans.push({
    id, kind: "gate-repair", gate: gateId, phase: t.phase, target_branch: t.targetBranch,
    trigger_attempt: `a${attempt}`, trigger_outcome: outcome, trigger_sha: producer?.integrated_sha ?? rec.integrated_sha ?? null,
    evidence_path: evidencePath, reason, status: "pending", branch: `plan/${gateId}/r${n}`, attempts: 0, planning_sha: null,
    created_at: now(), resolved_at: null,
  });
  ctx.savePlans(plans);
  ctx.audit("plan-request", `${id} gate=${gateId} attempt=a${attempt} outcome=${outcome} sha=${producer?.integrated_sha ?? "-"}`);
  return id;
}

function attemptStatus(ctx, id, n) {
  const dir = join(ctx.ciDir(id), `a${n}`);
  if (existsSync(join(dir, "abandoned.json"))) return "abandoned";
  const acc = join(ctx.ciDir(id), "accepted.json");
  if (existsSync(acc) && readJson(acc).attempt === n) return "accepted";
  const res = join(dir, "result.json");
  if (existsSync(res)) return readJson(res).conclusion === "success" ? "accepted-unrecorded" : "rejected";
  return "incomplete";
}

export function ciAttemptStatus(ctx, id, n) { return attemptStatus(ctx, id, n); }

/** scripts/gate.sh <id> [--resume a<n>] [--outcome ..] [--payload k=v]... [--note ..] [--file path] */
export function runGate(ctx, id, opts) {
  ctx.requireInit();
  const t = ctx.task(id);
  if (t.execution !== "human") throw new RalphError(`${id} is not a human gate (execution ${t.execution})`);
  return withLock(ctx.root, () => (t.gateKind === "ci" ? ciGate(ctx, t, opts) : humanGate(ctx, t, opts)));
}

function requireEligible(ctx, t) {
  const r = ctx.rec(t.id);
  if (!["pending", "human-pending", "blocked"].includes(r.status)) throw new RalphError(`${t.id} is ${r.status}; a gate runs only from pending/human-pending (or blocked for a transient rerun)`);
  if (!ctx.satisfied(t.id)) throw new RalphError(`${t.id}: dependencies not satisfied`);
}

// ---------- CI gates ----------
function ciGate(ctx, t, { resume = null, rerun = false } = {}) {
  const ci = ciAdapter(ctx);
  const producer = ctx.rec(t.gateFor);
  if (producer.status !== "passed" || !producer.integrated_sha) throw new RalphError(`${t.gateFor} is not passed; nothing to test`);
  const sha = producer.integrated_sha;
  const dir = ctx.ciDir(t.id);
  let n;
  if (resume) {
    n = Number(/^a(\d+)$/.exec(resume)?.[1]);
    if (!n || !existsSync(join(dir, `a${n}`, "run.json"))) throw new RalphError(`${t.id}: no attempt ${resume} with run.json to resume`);
  } else {
    requireEligible(ctx, t);
    const prev = ctx.attempts(t.id);
    n = (prev[prev.length - 1] ?? 0) + 1;
    if (prev.length && !rerun) throw new RalphError(`${t.id}: attempt a${prev[prev.length - 1]} exists; use gate.sh rerun ${t.id} (transient failure) or --resume a<n>`);
    if (rerun) rerunChecks(ctx, t, sha, prev);
  }
  const attemptDir = ensureDir(join(dir, `a${n}`));
  const ref = t.ci.refTemplate.replace("{n}", String(n));
  const runJsonPath = join(attemptDir, "run.json");
  let run;
  if (existsSync(runJsonPath)) {
    run = readJson(runJsonPath);
    if (run.sha !== sha) throw new RalphError(`${t.id} a${n}: run.json sha ${run.sha} != integrated_sha ${sha}`);
    ctx.audit(`gate ${t.id}`, `resume a${n} run_id=${run.run_id} (no new workflow run)`);
  } else {
    ctx.set(t.id, { status: "human-pending", started_at: ctx.rec(t.id).started_at ?? now() }, `gate a${n} starting`);
    ci.pushRef(sha, ref);
    const found = ci.findRun(t.ci.workflow, ref, sha);
    run = { run_id: found.run_id, url: found.url, sha, workflow: t.ci.workflow, ref, started_at: now(), artifacts: [] };
    writeJsonAtomic(runJsonPath, run); // step 1: the attempt exists on disk with its remote identity before any wait
    ctx.audit(`gate ${t.id}`, `a${n} ref=${ref} run_id=${run.run_id}`);
  }
  if (process.env.RALPH_CRASH_AFTER === "run.json") throw new RalphError(`injected crash after run.json (${t.id} a${n})`, { exit: 99 });

  // step 2: evidence
  const resultPath = join(attemptDir, "result.json");
  let result = existsSync(resultPath) ? readJson(resultPath) : null;
  if (!result) {
    const w = ci.waitRun(run.run_id);
    if (w.sha && w.sha !== sha) throw new RalphError(`${t.id} a${n}: workflow ran on ${w.sha}, not ${sha}`);
    result = { conclusion: w.conclusion, run_id: run.run_id, finished_at: now() };
    writeJsonAtomic(resultPath, result);
  }
  if (!existsSync(join(attemptDir, "workflow.log"))) ci.fetchLog(run.run_id, join(attemptDir, "workflow.log"));
  const artifacts = [];
  let missing = [];
  if (result.conclusion === "success") {
    for (const name of t.ci.artifactNames) {
      const dest = join(attemptDir, name);
      if (!existsSync(dest) || readdirSync(dest).length === 0) { try { ci.downloadArtifact(run.run_id, name, dest); } catch (e) { missing.push(`${name}: ${e.message}`); continue; } }
      const d = digestDir(dest);
      artifacts.push({ name, sha256: d.sha256, bytes: d.bytes });
    }
  }
  run = { ...run, artifacts, conclusion: result.conclusion };
  writeJsonAtomic(runJsonPath, run);
  const accepted = result.conclusion === "success" && missing.length === 0;
  const evidencePath = relative(ctx.root, attemptDir);
  if (accepted) {
    writeJsonAtomic(join(dir, "accepted.json"), { attempt: n, run_id: run.run_id, ref, sha, run_url: run.url, workflow: t.ci.workflow, artifacts, recorded_at: now() });
    symlinkForce(`a${n}`, join(dir, "accepted"));
    if (t.ci.cleanupRef) ci.deleteRef(ref);
  }
  if (process.env.RALPH_CRASH_AFTER === "evidence") throw new RalphError(`injected crash after evidence (${t.id} a${n})`, { exit: 99 });
  // step 3: outcome + status
  if (accepted) {
    ctx.set(t.id, { status: "passed", outcome: "ACCEPT", accepted_gate_attempt: n, attempts: n, finished_at: now(), notes: `run ${run.run_id}` }, `a${n} ACCEPT`);
    emit(`ACCEPT ${t.id} a${n} run ${run.run_id}`);
    return { outcome: "ACCEPT", attempt: n, run_id: run.run_id };
  }
  const reason = result.conclusion !== "success" ? `workflow ${t.ci.workflow} concluded ${result.conclusion}` : `artifacts missing: ${missing.join("; ")}`;
  ctx.set(t.id, { status: "blocked", outcome: "GATE-FAILED", attempts: n, finished_at: now(), notes: reason }, `a${n} GATE-FAILED`);
  // step 4: exactly one plan request
  const reqId = raisePlanRequest(ctx, t.id, n, "GATE-FAILED", evidencePath, reason);
  emit(`GATE-FAILED ${t.id} a${n}: ${reason}`);
  emit(`PLAN-GATE ${reqId}`);
  return { outcome: "GATE-FAILED", attempt: n, request: reqId };
}

function rerunChecks(ctx, t, sha, prev) {
  const last = prev[prev.length - 1];
  const lastDir = join(ctx.ciDir(t.id), `a${last}`);
  const st = attemptStatus(ctx, t.id, last);
  if (st === "accepted") throw new RalphError(`${t.id}: a${last} is accepted; nothing to rerun`);
  if (st === "incomplete") throw new RalphError(`${t.id}: a${last} is incomplete; use gate.sh ${t.id} --resume a${last} or abandon it`);
  const run = readJson(join(lastDir, "run.json"));
  if (run.sha !== sha) throw new RalphError(`SHA changed: use a .g<n> repair (a${last} ran on ${run.sha}, producer now at ${sha})`);
  const wf = `.github/workflows/${t.ci.workflow}`;
  const head = ctx.targetHead(t.id);
  const changed = git(ctx.root, ["diff", "--quiet", sha, head, "--", wf], { check: false }).status !== 0;
  if (changed) throw new RalphError(`SHA changed: use a .g<n> repair (${wf} differs between ${sha.slice(0, 7)} and ${t.targetBranch} ${head.slice(0, 7)})`);
  const rec = ctx.rec(t.id);
  if (rec.status === "blocked") {
    // the pending plan request for this gate is withdrawn only if it is still pending
    const plans = ctx.plans();
    const open = plans.find((p) => p.gate === t.id && p.status === "pending");
    if (open) { open.status = "abandoned"; open.resolved_at = now(); open.reason += " (withdrawn: transient rerun)"; ctx.savePlans(plans); ctx.audit("plan-abandon", `${open.id} withdrawn by rerun`); }
  }
  ctx.audit(`gate ${t.id}`, `rerun a${last + 1} against ${sha} (transient)`);
}

export function rerunGate(ctx, id) { return runGate(ctx, id, { rerun: true }); }

export function abandonAttempt(ctx, id, attempt, reason) {
  ctx.requireInit();
  const t = ctx.task(id);
  const n = Number(/^a(\d+)$/.exec(attempt)?.[1]);
  const dir = join(ctx.ciDir(id), `a${n}`);
  if (!n || !existsSync(dir)) throw new RalphError(`${id}: no attempt ${attempt}`);
  if (!reason) throw new RalphError("--reason required");
  return withLock(ctx.root, () => {
    writeJsonAtomic(join(dir, "abandoned.json"), { attempt: n, reason, abandoned_at: now() });
    const r = ctx.rec(id);
    if (r.status === "human-pending") ctx.set(id, { status: "blocked", notes: `a${n} abandoned: ${reason}` }, "attempt abandoned");
    ctx.audit(`gate ${id}`, `abandon a${n}: ${reason}`);
    if (t.gateKind === "ci") emit(`ABANDONED ${id} a${n}`);
    return { abandoned: n };
  });
}

/** gate.sh gc — delete remote ci refs whose attempt directory is accepted, rejected or abandoned. */
export function gc(ctx) {
  ctx.requireInit();
  const ci = ciAdapter(ctx);
  const refs = ci.listRefs("ci/");
  const deleted = [], kept = [];
  for (const ref of refs) {
    const m = /^ci\/(.+)\/a(\d+)$/.exec(ref);
    if (!m || !ctx.hasTask(`${m[1]}h`)) { kept.push(`${ref} (unknown)`); continue; }
    const st = attemptStatus(ctx, `${m[1]}h`, Number(m[2]));
    if (["accepted", "rejected", "abandoned"].includes(st)) { ci.deleteRef(ref); deleted.push(`${ref} (${st})`); } else kept.push(`${ref} (${st})`);
  }
  for (const d of deleted) console.log(`deleted ${d}`);
  for (const k of kept) console.log(`kept    ${k}`);
  ctx.audit("gate gc", `deleted=${deleted.length} kept=${kept.length}`);
  return { deleted, kept };
}

// ---------- human gates (observation / approval) ----------
function humanGate(ctx, t, { outcome, payload = {}, note = "", file = null } = {}) {
  requireEligible(ctx, t);
  const allowed = t.gateKind === "approval" ? ["ACCEPT", "REJECT"] : ["ACCEPT"];
  if (!outcome) throw new RalphError(`--outcome ${allowed.join("|")} required for ${t.id} (${t.gateKind})`);
  if (!allowed.includes(outcome)) throw new RalphError(`${t.id} (${t.gateKind}) accepts outcomes ${allowed.join("|")}, not ${outcome}`);
  const prev = ctx.attempts(t.id);
  const n = (prev[prev.length - 1] ?? 0) + 1;
  const dir = ensureDir(ctx.humanDir(t.id));
  const body = file ? readFileSync(file, "utf8") : note;
  if (!body.trim()) throw new RalphError("a human record needs --note text or --file path");
  const md = `# ${t.id} — attempt a${n}\n\nrecordTarget: ${t.recordTarget ?? "(evidence-only)"}\ngateKind: ${t.gateKind}\noutcome: ${outcome}\nrecorded_at: ${now()}\nsha: ${ctx.targetHead(t.id)}\npayload: ${JSON.stringify(payload)}\n\n## Record\n\n${body.trim()}\n`;
  const mdPath = join(dir, `a${n}.md`);
  writeFileSync(mdPath, md); // step 1
  const evidencePath = relative(ctx.root, mdPath);
  if (outcome === "ACCEPT") writeJsonAtomic(join(dir, "accepted.json"), { attempt: n, evidence_path: evidencePath, outcome, payload, recorded_at: now() }); // step 2
  if (outcome === "ACCEPT") {
    ctx.set(t.id, { status: "passed", outcome, accepted_gate_attempt: n, attempts: n, finished_at: now() }, `a${n} ACCEPT`);
    emit(`ACCEPT ${t.id} a${n}`);
    return { outcome, attempt: n };
  }
  ctx.set(t.id, { status: "blocked", outcome, attempts: n, finished_at: now(), notes: `REJECT: ${body.trim().slice(0, 120)}` }, `a${n} REJECT`);
  const reqId = raisePlanRequest(ctx, t.id, n, "REJECT", evidencePath, body.trim().slice(0, 200));
  emit(`REJECT ${t.id} a${n}`);
  emit(`PLAN-GATE ${reqId}`);
  return { outcome, attempt: n, request: reqId };
}

/** Read an accepted CI manifest and verify every artifact digest against the files on disk (consumers, §1). */
export function readAcceptedCi(ctx, gateId) {
  const dir = ctx.ciDir(gateId);
  const acc = readJson(join(dir, "accepted.json"));
  const attemptDir = join(dir, `a${acc.attempt}`);
  for (const a of acc.artifacts) {
    const p = join(attemptDir, a.name);
    if (!existsSync(p)) throw new RalphError(`${gateId}: accepted artifact ${a.name} missing on disk`);
    const d = digestDir(p);
    if (d.sha256 !== a.sha256) throw new RalphError(`${gateId}: digest mismatch for ${a.name} (accepted.json ${a.sha256.slice(0, 12)}, disk ${d.sha256.slice(0, 12)})`);
  }
  return acc;
}
