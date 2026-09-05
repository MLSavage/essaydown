// harness.mjs — disposable fixture repositories for the conformance suite (RUNNER-SPEC §12).
// A fixture is a git repo with a tiny docs/PRD.md §8, generated ralph/tasks.json, runtime state
// initialised like bootstrap does, and fake iteration / suite / reviewer commands wired through env.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Ctx, initState } from "../lib/state.mjs";
import { extractRawTasks, expand, serialize } from "../generate-tasks.mjs";
import { git, revParse, ensureDir } from "../lib/util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_ITERATION = join(HERE, "fake-iteration.sh");
export const FAKE_SUITE = join(HERE, "fake-suite.sh");
export const FAKE_REVIEW = join(HERE, "fake-review.sh");

/** Standard tasks for one phase: N.1 (loop), N.verify (needsCI), N.9 (review-set), N.close. `extra` are raw tasks merged in. */
export function phaseTasks(n, { next = null, release = null, extra = [], first = null } = {}) {
  const ci = (id, wf = "ci.yml") => ({ needsCI: true, ci: { refType: "ci", refTemplate: `ci/${id}/a{n}`, workflow: wf, trigger: "push", artifactNames: ["test-logs"], cleanupRef: true }, ciAcceptance: `${wf} green` });
  const tasks = [
    { id: `${n}.1`, model: "sonnet", description: `Task ${n}.1: fake work`, acceptance: `work/${n}.1.txt exists`, dependencies: first ? [first] : [] },
    ...extra,
    { id: `${n}.verify`, model: "sonnet", description: `Phase ${n} verification`, acceptance: "suite green", dependencies: [`${n}.1`, ...extra.filter((t) => t.beforeVerify).map((t) => t.needsCI ? `${t.id}` : t.id)], ...ci(`${n}.verify`) },
    { id: `${n}.9`, model: "review-set", description: `Review set for Phase ${n}`, acceptance: "Canonical review-set acceptance", dependencies: [`${n}.verify`] },
    { id: `${n}.close`, model: "opus", execution: "runner", description: `Phase close ${n}`, acceptance: "main moved", dependencies: [`${n}.9`], ...(next ? { nextPhase: String(next), nextBranch: `phase/${next}` } : {}), ...(release ? { releaseVersion: release } : {}) },
  ];
  return tasks.map((t) => { const { beforeVerify, ...rest } = t; return rest; });
}

export function prdFor(phases) {
  let s = "# Fixture PRD\n\n## 7. Phases\n\nfixture\n\n## 8. Task list\n\nConventions: fixture.\n\n";
  for (const p of phases) s += `### Phase ${p.n} — fixture\n\n\`\`\`json\n${JSON.stringify(p.tasks, null, 1)}\n\`\`\`\n\n`;
  s += "## 9. Rules\n\nnone\n";
  return s;
}

export function writeSpec(root, prdText) {
  const { tasks } = extractRawTasks(prdText);
  const expanded = expand(tasks);
  ensureDir(join(root, "ralph"));
  writeFileSync(join(root, "docs/PRD.md"), prdText);
  writeFileSync(join(root, "ralph/tasks.json"), serialize(expanded));
  writeFileSync(join(root, "ralph/EXPECTED_COUNT"), `${expanded.length}\n`);
  return expanded;
}

/**
 * Create a fixture: main with the seed commit, phase branches for every phase in `phases`
 * (all at the seed unless `branchAt` says otherwise), state initialised with `passed` ids.
 */
export function makeFixture({ phases, currentPhase, passed = [], versionFiles = null, external = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ralph-fixture-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "fixture"]); git(root, ["config", "user.email", "fixture@essaydown.invalid"]);
  mkdirSync(join(root, "docs/progress"), { recursive: true });
  writeFileSync(join(root, "docs/progress/journal-main.md"), "# journal\n\n");
  writeFileSync(join(root, "docs/DECISIONS.md"), "# DECISIONS\n\n");
  writeFileSync(join(root, "docs/lessons.md"), "# lessons\n\n");
  writeFileSync(join(root, ".gitignore"), ".evidence/\n.wt/\n.locks/\n.fake/\n.ci-fake/\n.ext/\n");
  if (versionFiles) for (const [f, c] of Object.entries(versionFiles)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), c); }
  const expanded = writeSpec(root, prdFor(phases));
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "seed"]);
  const seed = revParse(root, "main");
  const phaseRecords = {};
  const cur = String(currentPhase ?? phases[0].n);
  git(root, ["branch", `phase/${cur}`, seed]);
  phaseRecords[cur] = { phase: cur, branch: `phase/${cur}`, base_main_sha: seed, created_by: "fixture", created_at: new Date().toISOString() };
  const ctx = new Ctx(root);
  const passedMap = {};
  for (const id of passed) passedMap[id] = seed;
  initState(ctx, { spec: expanded, phaseRecords, passed: passedMap });
  mkdirSync(join(root, ".fake"), { recursive: true });
  mkdirSync(join(root, ".ci-fake"), { recursive: true });
  let ext = null;
  if (external) {
    // an external repo like MLSavage/build-defaults, at <root>/.ext/build-defaults (gitignored)
    ext = join(root, ".ext/build-defaults");
    mkdirSync(join(ext, "scripts"), { recursive: true });
    git(ext, ["init", "-q", "-b", "main"]);
    git(ext, ["config", "user.name", "fixture"]); git(ext, ["config", "user.email", "fixture@essaydown.invalid"]);
    writeFileSync(join(ext, "BUILD-DEFAULTS.md"), "# BUILD-DEFAULTS\n\nVersion: 1.0.0\n");
    writeFileSync(join(ext, "scripts/validate-defaults.mjs"), 'import { existsSync } from "node:fs"; if (existsSync("FAIL_SUITE")) { console.error("red"); process.exit(1); } console.log("validate-defaults: OK");\n');
    git(ext, ["add", "-A"]); git(ext, ["commit", "-q", "-m", "seed"]);
    const base = revParse(ext, "main");
    ensureDir(join(root, ".evidence/external/build-defaults"));
    writeFileSync(join(root, ".evidence/external/build-defaults/state.json"), JSON.stringify({ target_ref: "refs/heads/main", base_sha: base, initialised_at: new Date().toISOString() }, null, 2));
  }
  return { root, ctx, seed, ext };
}

export function fakeEnv(root) {
  return { RALPH_ROOT: root, RALPH_ITERATION_CMD: FAKE_ITERATION, RALPH_SUITE_CMD: FAKE_SUITE, RALPH_REVIEW_CMD: FAKE_REVIEW, RALPH_CI_ADAPTER: "fake", RALPH_CI_FAKE_DIR: join(root, ".ci-fake") };
}

/** Run the CLI as a subprocess (so process.exit and crash injection stay contained). */
export function cli(root, args, { env = {}, tool = "ralph" } = {}) {
  const r = spawnSync("node", [join(HERE, "..", "lib", "cli.mjs"), tool, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...fakeEnv(root), ...env } });
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
export const ralph = (root, args, opts) => cli(root, args, opts);
export const gate = (root, args, opts) => cli(root, args, { ...opts, tool: "gate" });

export function control(root, id, obj) { writeFileSync(join(root, ".fake", `${id}.json`), JSON.stringify(obj)); }
export function ciScenario(root, ref, obj) { writeFileSync(join(root, ".ci-fake", `${ref.replace(/\//g, "_")}.json`), JSON.stringify(obj)); }
export function fakeRuns(root) { const p = join(root, ".ci-fake", "runs.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}; }
export function fakeRefs(root) { const p = join(root, ".ci-fake", "remote-refs.json"); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {}; }
export function state(root) { return JSON.parse(readFileSync(join(root, ".evidence/state/tasks.json"), "utf8")); }
export function plans(root) { return JSON.parse(readFileSync(join(root, ".evidence/state/plan-requests.json"), "utf8")); }
export function phasesJson(root) { return JSON.parse(readFileSync(join(root, ".evidence/state/phases.json"), "utf8")); }
export function cleanup(root) { rmSync(root, { recursive: true, force: true }); }

/** Make a principal-style commit in a worktree with the DONE promise (reconciliation / plan request / interactive task). */
export function principalCommit(root, wt, id, { files = {}, verdict = null, phase = null, attempt = null, prdText = null } = {}) {
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(wt, f)), { recursive: true }); writeFileSync(join(wt, f), c); }
  if (prdText !== null) writeSpec(wt, prdText);
  if (verdict) {
    const p = join(wt, "docs/DECISIONS.md");
    writeFileSync(p, readFileSync(p, "utf8") + `\n## #review-${phase}-${attempt}\n\nverdict: ${verdict}\n\n- fixture reconciliation\n`);
  }
  const j = join(wt, "docs/progress/journal-main.md");
  writeFileSync(j, readFileSync(j, "utf8") + `- [${id}] ${new Date().toISOString()} Task: principal work. Status: Complete.\n`);
  git(root, ["-C", wt, "add", "-A"]);
  git(root, ["-C", wt, "commit", "-q", "-m", `wip(${id}): principal work\n\n<promise>DONE ${id}</promise>`]);
  return revParse(root, "HEAD") && spawnSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

/** Drive a whole phase through gates and reviews with everything green. Returns after N.close. */
export function runPhaseGreen(root, n, { until = null } = {}) {
  const log = [];
  for (let i = 0; i < 40; i++) {
    const r = ralph(root, ["run", "--phase", String(n)]);
    log.push(r.out);
    const m = /^(HUMAN_GATE|PRINCIPAL|STUCK|CONFLICT|INTEGRATION-FAILED|DOCTOR|CLOSE-DRIFT|REPLAN|PLAN-GATE|NO-JOURNAL|NO-COMMIT|REVIEW-SHA-MISMATCH) (\S+)/m.exec(r.out);
    if (/<promise>COMPLETE<\/promise>/.test(r.out)) return { done: true, log };
    if (!m) { if (r.status !== 0) return { done: false, log, error: r.out }; continue; }
    const [, sig, id] = m;
    if (until && `${sig} ${id}`.startsWith(until)) return { done: false, log, stopped: `${sig} ${id}` };
    if (sig === "HUMAN_GATE") {
      const kind = new Ctx(root).task(id).gateKind;
      const g = gate(root, kind === "ci" ? [id] : [id, "--outcome", "ACCEPT", "--note", "fixture: accepted"]);
      log.push(g.out);
      if (/PLAN-GATE/.test(g.out)) return { done: false, log, stopped: g.out };
    } else if (sig === "PRINCIPAL") {
      const ctx = new Ctx(root);
      const t = ctx.hasTask(id) ? ctx.task(id) : null;
      const wt = join(root, ".wt", id);
      if (t && t.reviewSet) principalCommit(root, wt, id, { verdict: "PASS", phase: t.phase, attempt: t.reviewAttempt });
      else principalCommit(root, wt, id, { files: { [`work/${id}.txt`]: "principal" } });
    } else return { done: false, log, stopped: `${sig} ${id}` };
  }
  return { done: false, log, error: "too many rounds" };
}
