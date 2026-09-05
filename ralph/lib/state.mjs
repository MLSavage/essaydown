// state.mjs — immutable spec (ralph/tasks.json) and mutable runtime state (.evidence/state/*, RUNNER-SPEC §1).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { RalphError, readJson, writeJsonAtomic, appendLine, now, ensureDir, git, gitOut, revParse } from "./util.mjs";
import { extractRawTasks, expand, serialize } from "../generate-tasks.mjs";

export const STATUSES = ["pending", "running", "passed", "integration-failed", "blocked", "human-pending", "principal-pending", "superseded", "abandoned"];
export const PLAN_STATUSES = ["pending", "running", "blocked", "integration-failed", "resolved", "abandoned"];

export class Ctx {
  constructor(root) {
    this.root = resolve(root);
    this.evidence = resolve(this.root, process.env.RALPH_EVIDENCE_DIR ?? ".evidence");
    this.stateDir = resolve(this.evidence, "state");
    this.wt = resolve(this.root, ".wt");
    this.paths = {
      tasks: resolve(this.stateDir, "tasks.json"),
      spec: resolve(this.stateDir, "spec.json"),
      phases: resolve(this.stateDir, "phases.json"),
      plans: resolve(this.stateDir, "plan-requests.json"),
      audit: resolve(this.stateDir, "audit.log"),
      summary: resolve(this.stateDir, "summary.md"),
    };
    this._spec = null;
  }
  get initialised() { return existsSync(this.paths.tasks) && existsSync(this.paths.spec) && existsSync(this.paths.phases); }
  requireInit() { if (!this.initialised) throw new RalphError(`runtime state not initialised under ${this.stateDir} (run ralph/bootstrap.sh)`); }

  /** The spec the runner works from: the snapshot written by bootstrap/sync-state. */
  spec() { if (!this._spec) { this.requireInit(); this._spec = readJson(this.paths.spec); } return this._spec; }
  task(id) { const t = this.spec().find((x) => x.id === id); if (!t) throw new RalphError(`unknown task ${id}`); return t; }
  hasTask(id) { return this.spec().some((x) => x.id === id); }
  dependents(id) { return this.spec().filter((t) => t.dependencies.includes(id)); }

  state() { this.requireInit(); return readJson(this.paths.tasks); }
  phases() { this.requireInit(); return readJson(this.paths.phases); }
  plans() { return readJson(this.paths.plans, []); }
  saveState(s) { writeJsonAtomic(this.paths.tasks, s); }
  savePhases(p) { writeJsonAtomic(this.paths.phases, p); }
  savePlans(p) { writeJsonAtomic(this.paths.plans, p); }
  audit(cmd, detail = "") { appendLine(this.paths.audit, `${now()} ${cmd}${detail ? " " + detail : ""}`); }

  rec(id) { const s = this.state(); if (!s[id]) throw new RalphError(`no runtime record for ${id}`); return s[id]; }
  /** Transition under the caller's lock; returns the new record. */
  set(id, patch, why) {
    const s = this.state();
    if (!s[id]) throw new RalphError(`no runtime record for ${id}`);
    const before = s[id].status;
    s[id] = { ...s[id], ...patch };
    if (patch.status && !STATUSES.includes(patch.status)) throw new RalphError(`illegal status ${patch.status}`);
    this.saveState(s);
    this.audit(`transition ${id}`, `${before} -> ${s[id].status}${why ? " (" + why + ")" : ""}${patch.outcome ? " outcome=" + patch.outcome : ""}`);
    return s[id];
  }

  /** Dependency satisfied = passed (+ ACCEPT for human tasks). */
  satisfied(id, s = this.state()) {
    const t = this.task(id);
    return t.dependencies.every((d) => {
      const r = s[d];
      if (r && r.status === "superseded") return true; // replaced by a planning commit; only that commit's fix tasks still name it
      if (!r || r.status !== "passed") return false;
      if (this.task(d).execution === "human") return r.outcome === "ACCEPT";
      return true;
    });
  }

  freshRecord() { return { status: "pending", outcome: null, attempts: 0, task_branch: null, integrated_sha: null, accepted_gate_attempt: null, started_at: null, finished_at: null, notes: "" }; }

  /** Regenerate the spec from the PRD at a git ref (or the working tree) and return {json, expanded}. */
  regenerateAt(ref) {
    const prd = ref ? gitOut(this.root, ["show", `${ref}:docs/PRD.md`]) : readFileSync(resolve(this.root, "docs/PRD.md"), "utf8");
    const { tasks } = extractRawTasks(prd);
    const expanded = expand(tasks);
    return { json: serialize(expanded), expanded };
  }
  committedTasksAt(ref) { return ref ? gitOut(this.root, ["show", `${ref}:ralph/tasks.json`]) + "\n" : readFileSync(resolve(this.root, "ralph/tasks.json"), "utf8"); }

  /** Evidence paths. */
  ciDir(id) { return resolve(this.evidence, "ci", id); }
  humanDir(id) { return resolve(this.evidence, "human", id); }
  reviewDir(phase, attempt) { return resolve(this.evidence, "reviews", String(phase), attempt); }
  closesDir() { return ensureDir(resolve(this.evidence, "closes")); }
  taskLogDir(id) { return ensureDir(resolve(this.evidence, "tasks", id)); }
  externalDir(id) { return ensureDir(resolve(this.evidence, "external", id)); }
  worktree(id) { return resolve(this.wt, id); }

  /** Existing execution attempts a<n> for a gate. */
  attempts(id) {
    const dir = this.task(id).gateKind === "ci" ? this.ciDir(id) : this.humanDir(id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((n) => /^a(\d+)(\.md)?$/.exec(n)).filter(Boolean).map((m) => Number(m[1])).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  }

  /** Current head of a task's target branch. */
  targetHead(id) { const t = this.task(id); const sha = revParse(this.root, t.targetBranch); if (!sha) throw new RalphError(`target branch ${t.targetBranch} does not exist`); return sha; }
}

/** sync-state (RUNNER-SPEC §6): merge a (possibly grown) spec into runtime state. Caller holds the lock. */
export function syncState(ctx, { ref, allowSupersede = [] } = {}) {
  const { json, expanded } = ctx.regenerateAt(ref);
  const committed = ctx.committedTasksAt(ref);
  if (committed.trimEnd() !== json.trimEnd()) throw new RalphError(`sync-state: ralph/tasks.json at ${ref ?? "worktree"} is not byte-identical to the regeneration from PRD §8`);
  const old = ctx.spec();
  const s = ctx.state();
  const oldById = new Map(old.map((t) => [t.id, t]));
  const newById = new Map(expanded.map((t) => [t.id, t]));
  const MUTABLE_OK = new Set(["pending", "superseded"]);
  const fingerprint = (t) => JSON.stringify({ d: t.description, a: t.acceptance, deps: t.dependencies, e: t.execution, m: t.model, tb: t.targetBranch, ci: t.ci ?? null, gk: t.gateKind ?? null });
  for (const [id, t] of oldById) {
    const r = s[id];
    if (!newById.has(id)) {
      if (r && !MUTABLE_OK.has(r.status)) throw new RalphError(`sync-state: task ${id} (${r.status}) was deleted by the planning commit`);
      continue;
    }
    if (r && !MUTABLE_OK.has(r.status) && !allowSupersede.includes(id) && fingerprint(t) !== fingerprint(newById.get(id))) {
      throw new RalphError(`sync-state: task ${id} (${r.status}) was mutated by the planning commit`);
    }
  }
  let added = 0;
  for (const t of expanded) if (!s[t.id]) { s[t.id] = ctx.freshRecord(); added++; }
  for (const id of Object.keys(s)) if (!newById.has(id) && s[id].status === "pending") delete s[id];
  writeJsonAtomic(ctx.paths.spec, expanded);
  ctx._spec = expanded;
  ctx.saveState(s);
  ctx.audit("sync-state", `${expanded.length} tasks, ${added} added, ref=${ref ?? "worktree"}`);
  return { added, total: expanded.length };
}

/** Initialise runtime state (bootstrap, RUNNER-SPEC §2 bootstrap row; also the conformance fixtures). */
export function initState(ctx, { spec, phaseRecords, passed = {} }) {
  ensureDir(ctx.stateDir);
  const s = {};
  for (const t of spec) {
    s[t.id] = ctx.freshRecord();
    if (passed[t.id]) s[t.id] = { ...s[t.id], status: "passed", integrated_sha: passed[t.id], started_at: now(), finished_at: now(), attempts: 1, notes: "bootstrap" };
  }
  writeJsonAtomic(ctx.paths.spec, spec);
  ctx._spec = spec;
  ctx.saveState(s);
  ctx.savePhases(phaseRecords);
  ctx.savePlans([]);
  ctx.audit("init", `${spec.length} tasks, ${Object.keys(passed).length} passed, phases ${Object.keys(phaseRecords).join(",")}`);
  return s;
}
