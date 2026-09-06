// conformance.test.mjs — RUNNER-SPEC §12 scenarios against disposable fixture repositories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeFixture, phaseTasks, prdFor, writeSpec, ralph, gate, control, ciScenario, fakeRuns, fakeRefs, state, plans, phasesJson, principalCommit, runPhaseGreen, cleanup } from "./harness.mjs";
import { git, gitOut, revParse, refOid } from "../lib/util.mjs";
import { Ctx } from "../lib/state.mjs";
import { readAcceptedCi } from "../lib/gate.mjs";

const ok = (r, msg) => assert.equal(r.status, 0, `${msg ?? "command"} failed:\n${r.out}`);
const versionFiles = (v) => ({ "package.json": `{"name":"fixture","version":"${v}"}\n`, "apps/desktop/src-tauri/Cargo.toml": `[package]\nname = "fixture"\nversion = "${v}"\n`, "apps/desktop/src-tauri/tauri.conf.json": `{"version":"${v}"}\n` });
const approval = { id: "0.5v", model: "opus", execution: "human", description: "approval gate", acceptance: "x", dependencies: ["0.1"], blockedOnHuman: true, gateKind: "approval", recordTarget: "008-visual", outcomes: { ACCEPT: "continue", REJECT: "plan-gate" }, beforeVerify: true };
const onePhase = (opts = {}) => [{ n: "0", tasks: phaseTasks("0", { next: "1", ...opts }) }];

test("integration transaction: candidate without moving the branch, CAS mismatch restarts, detached failure leaves the branch", async (t) => {
  const f = makeFixture({ phases: onePhase() });
  await t.test("crash after candidate tag: target untouched, doctor names admin retry, run refuses, wrong admin refused", () => {
    const before = revParse(f.root, "phase/0");
    const r = ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_CRASH_AFTER: "candidate-tag" } });
    assert.equal(r.status, 99, r.out);
    assert.equal(revParse(f.root, "phase/0"), before, "branch moved");
    assert.ok(refOid(f.root, "refs/tags/candidate/0.1"), "candidate tag missing");
    assert.ok(refOid(f.root, "refs/heads/task/0.1"), "task branch gone");
    const d = ralph(f.root, ["doctor"]);
    assert.equal(d.status, 3);
    const lines = d.out.trim().split("\n").filter((l) => /→/.test(l));
    assert.equal(lines.length, 1, d.out);
    assert.match(lines[0], /unfinished-integration 0\.1 \(target == expected-old\) → ralph\.sh admin retry 0\.1/);
    assert.match(ralph(f.root, ["run", "--phase", "0"]).out, /DOCTOR 1 findings/);
    const wrong = ralph(f.root, ["admin", "mark-integrated", "0.1"]);
    assert.notEqual(wrong.status, 0); assert.match(wrong.out, /refused/);
    ok(ralph(f.root, ["admin", "retry", "0.1"]), "admin retry");
    assert.equal(refOid(f.root, "refs/tags/candidate/0.1"), null);
    assert.match(ralph(f.root, ["doctor"]).out, /clean/);
  });
  await t.test("re-run integrates from the rebase (CAS restart) and the branch moves exactly once", () => {
    const before = revParse(f.root, "phase/0");
    const r = ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_MAX_ITERATIONS: "1" } });
    const s = state(f.root);
    assert.equal(s["0.1"].status, "passed", r.out);
    assert.equal(revParse(f.root, "phase/0"), s["0.1"].integrated_sha);
    assert.equal(gitOut(f.root, ["rev-parse", "phase/0^"]), before, "candidate parent must be the expected-old");
    assert.match(gitOut(f.root, ["log", "-1", "--format=%s", "phase/0"]), /^task\(0\.1\): /);
    assert.ok(refOid(f.root, "refs/tags/wip/0.1"), "wip tag for forensics");
    assert.equal(refOid(f.root, "refs/heads/task/0.1"), null, "task branch removed");
  });
  await t.test("crash after update-ref: doctor names admin mark-integrated; admin retry refused; mark-integrated completes", () => {
    control(f.root, "0.verify", { done: true });
    const r = ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_CRASH_AFTER: "update-ref" } });
    assert.equal(r.status, 99, r.out);
    const d = ralph(f.root, ["doctor"]).out;
    assert.match(d, /unfinished-integration 0\.verify \(target == candidate\) → ralph\.sh admin mark-integrated 0\.verify/);
    assert.equal(d.trim().split("\n").filter((l) => /→/.test(l)).length, 1);
    const wrong = ralph(f.root, ["admin", "retry", "0.verify"]);
    assert.notEqual(wrong.status, 0); assert.match(wrong.out, /refused/);
    ok(ralph(f.root, ["admin", "mark-integrated", "0.verify"]));
    assert.match(ralph(f.root, ["doctor"]).out, /clean/);
    assert.equal(state(f.root)["0.verify"].status, "passed");
    assert.equal(state(f.root)["0.verify"].integrated_sha, revParse(f.root, "phase/0"));
  });
  await t.test("target moved to neither: doctor names a manual repair; both admin commands refused", () => {
    const f2 = makeFixture({ phases: onePhase() });
    ralph(f2.root, ["run", "--phase", "0"], { env: { RALPH_CRASH_AFTER: "candidate-tag" } });
    git(f2.root, ["worktree", "add", "-q", "--detach", join(f2.root, ".wt/tmp"), "phase/0"]);
    writeFileSync(join(f2.root, ".wt/tmp/other.txt"), "x"); git(f2.root, ["-C", join(f2.root, ".wt/tmp"), "add", "-A"]); git(f2.root, ["-C", join(f2.root, ".wt/tmp"), "commit", "-q", "-m", "someone else"]);
    git(f2.root, ["update-ref", "refs/heads/phase/0", gitOut(f2.root, ["-C", join(f2.root, ".wt/tmp"), "rev-parse", "HEAD"])]);
    assert.match(ralph(f2.root, ["doctor"]).out, /\(target == neither\) → manual repair: DECISIONS\.md#repair-0\.1/);
    assert.notEqual(ralph(f2.root, ["admin", "retry", "0.1"]).status, 0);
    assert.notEqual(ralph(f2.root, ["admin", "mark-integrated", "0.1"]).status, 0);
    cleanup(f2.root);
  });
  await t.test("detached-test failure: integration-failed, wip/<id>-<n> tag, branch untouched; retry re-queues", () => {
    const f3 = makeFixture({ phases: onePhase() });
    control(f3.root, "0.1", { failCandidate: true });
    const before = revParse(f3.root, "phase/0");
    const r = ralph(f3.root, ["run", "--phase", "0"]);
    assert.match(r.out, /INTEGRATION-FAILED 0\.1/);
    assert.equal(state(f3.root)["0.1"].status, "integration-failed");
    assert.equal(revParse(f3.root, "phase/0"), before);
    assert.ok(refOid(f3.root, "refs/tags/wip/0.1-1"));
    assert.ok(refOid(f3.root, "refs/heads/task/0.1"), "branch kept");
    ok(ralph(f3.root, ["retry", "0.1"]));
    assert.equal(state(f3.root)["0.1"].status, "pending");
    control(f3.root, "0.1", { rm: ["FAIL_CANDIDATE"] });
    ralph(f3.root, ["run", "--phase", "0"]);
    assert.equal(state(f3.root)["0.1"].status, "passed");
    cleanup(f3.root);
  });
  cleanup(f.root);
});

test("stop-check: STUCK after 3 attempts without DONE; retry resets; NO-JOURNAL stops the run", () => {
  const f = makeFixture({ phases: onePhase() });
  control(f.root, "0.1", { done: false });
  for (let i = 1; i <= 3; i++) ralph(f.root, ["run", "--phase", "0"]);
  const s = state(f.root)["0.1"];
  assert.equal(s.status, "blocked"); assert.equal(s.attempts, 3);
  assert.ok(existsSync(join(f.root, ".evidence/tasks/0.1/3.log")), "transcripts per attempt");
  ok(ralph(f.root, ["retry", "0.1"]));
  control(f.root, "0.1", { done: true, journal: false });
  assert.match(ralph(f.root, ["run", "--phase", "0"]).out, /NO-JOURNAL 0\.1/);
  assert.equal(state(f.root)["0.1"].status, "running");
  ralph(f.root, ["run", "--phase", "0"]);
  assert.match(ralph(f.root, ["run", "--phase", "0"]).out, /STUCK 0\.1 \(no journal entry\)/, "third journal-less attempt is STUCK");
  assert.equal(state(f.root)["0.1"].status, "blocked");
  ok(ralph(f.root, ["retry", "0.1"]));
  control(f.root, "0.1", { done: true });
  ralph(f.root, ["run", "--phase", "0"]);
  assert.equal(state(f.root)["0.1"].status, "passed");
  cleanup(f.root);
});

test("approval rejection → plan request → planning commit → dependents rewired → superseded gate", () => {
  const f = makeFixture({ phases: onePhase({ extra: [approval] }) });
  let r = runPhaseGreen(f.root, "0", { until: "HUMAN_GATE 0.5v" });
  assert.equal(r.stopped, "HUMAN_GATE 0.5v", r.error);
  r = gate(f.root, ["0.5v", "--outcome", "REJECT", "--note", "baselines wrong on windows"]);
  assert.match(r.out, /PLAN-GATE plan\.0\.5v\.r0/);
  assert.equal(state(f.root)["0.5v"].status, "blocked"); assert.equal(state(f.root)["0.5v"].outcome, "REJECT");
  assert.ok(existsSync(join(f.root, ".evidence/human/0.5v/a1.md")));
  assert.ok(!existsSync(join(f.root, ".evidence/human/0.5v/accepted.json")));
  const p = plans(f.root)[0];
  assert.equal(p.status, "pending"); assert.equal(p.trigger_outcome, "REJECT"); assert.equal(p.gate, "0.5v");
  assert.match(ralph(f.root, ["run", "--phase", "0"]).out, /STUCK/); // nothing runnable: 0.verify waits on 0.5v
  ok(ralph(f.root, ["plan", "plan.0.5v.r0"]));
  assert.equal(plans(f.root)[0].status, "running");
  assert.ok(refOid(f.root, "refs/heads/plan/0.5v/r0"));
  // planning commit (rewrite rule b): fix task 0.6 + approval 0.5v.r1 replacing 0.5v in every dependent
  const tasks = phaseTasks("0", { next: "1", extra: [approval,
    { id: "0.6", model: "sonnet", description: "fix baselines", acceptance: "x", dependencies: ["0.1"] },
    { ...approval, id: "0.5v.r1", dependencies: ["0.6"] }] });
  tasks.find((x) => x.id === "0.verify").dependencies = ["0.1", "0.5v.r1"];
  principalCommit(f.root, join(f.root, ".wt/plan.0.5v.r0"), "plan.0.5v.r0", { prdText: prdFor([{ n: "0", tasks }]) });
  r = ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_MAX_ITERATIONS: "1" } });
  assert.equal(plans(f.root)[0].status, "resolved", r.out);
  assert.ok(plans(f.root)[0].planning_sha);
  assert.match(gitOut(f.root, ["log", "--format=%s", "phase/0"]), /^plan\(plan\.0\.5v\.r0\)/m);
  const s = state(f.root);
  assert.equal(s["0.5v"].status, "superseded");
  assert.equal(s["0.6"].status, "pending"); assert.equal(s["0.5v.r1"].status, "pending");
  const ctx = new Ctx(f.root);
  assert.deepEqual(ctx.task("0.verify").dependencies, ["0.1", "0.5v.r1"]);
  const done = runPhaseGreen(f.root, "0");
  assert.ok(done.done, done.stopped ?? done.error);
  assert.equal(state(f.root)["0.5v.r1"].outcome, "ACCEPT");
  cleanup(f.root);
});

test("CI gates: code-failed gate → .g1 repair; transient rerun a2; resume after crash; rerun refused after workflow change; gc scope; digest mismatch", async (t) => {
  await t.test("transient rerun: a2 against the same SHA, accepted.json points at a2, plan request withdrawn", () => {
    const f = makeFixture({ phases: onePhase() });
    ciScenario(f.root, "ci/0.verify/a1", { conclusion: "cancelled" });
    let r = runPhaseGreen(f.root, "0", { until: "HUMAN_GATE 0.verifyh" });
    r = gate(f.root, ["0.verifyh"]);
    assert.match(r.out, /GATE-FAILED 0\.verifyh a1/); assert.match(r.out, /PLAN-GATE plan\.0\.verifyh\.r0/);
    assert.equal(plans(f.root).length, 1);
    r = gate(f.root, ["rerun", "0.verifyh"]);
    assert.match(r.out, /ACCEPT 0\.verifyh a2/, r.out);
    const acc = JSON.parse(readFileSync(join(f.root, ".evidence/ci/0.verifyh/accepted.json"), "utf8"));
    assert.equal(acc.attempt, 2);
    assert.equal(acc.sha, state(f.root)["0.verify"].integrated_sha);
    assert.equal(JSON.parse(readFileSync(join(f.root, ".evidence/ci/0.verifyh/a1/run.json"), "utf8")).sha, acc.sha);
    assert.equal(readFileSync(join(f.root, ".evidence/ci/0.verifyh/accepted/run.json"), "utf8").includes(`"run_id": "${acc.run_id}"`), true);
    assert.equal(plans(f.root)[0].status, "abandoned");
    assert.ok(acc.artifacts[0].sha256.length === 64);
    cleanup(f.root);
  });
  await t.test("crash after run.json: doctor reports incomplete; --resume completes with the same run_id and no new run", () => {
    const f = makeFixture({ phases: onePhase() });
    runPhaseGreen(f.root, "0", { until: "HUMAN_GATE 0.verifyh" });
    const r = gate(f.root, ["0.verifyh"], { env: { RALPH_CRASH_AFTER: "run.json" } });
    assert.equal(r.status, 99, r.out);
    const runJson = JSON.parse(readFileSync(join(f.root, ".evidence/ci/0.verifyh/a1/run.json"), "utf8"));
    assert.ok(runJson.run_id);
    const d = ralph(f.root, ["doctor"]).out;
    assert.match(d, /incomplete 0\.verifyh a1 → scripts\/gate\.sh 0\.verifyh --resume a1/);
    assert.match(ralph(f.root, ["run", "--phase", "0"]).out, /DOCTOR/);
    const runsBefore = Object.keys(fakeRuns(f.root)).length;
    const res = gate(f.root, ["0.verifyh", "--resume", "a1"]);
    assert.match(res.out, /ACCEPT 0\.verifyh a1/, res.out);
    assert.equal(Object.keys(fakeRuns(f.root)).length, runsBefore, "no new workflow run");
    assert.equal(JSON.parse(readFileSync(join(f.root, ".evidence/ci/0.verifyh/accepted.json"), "utf8")).run_id, runJson.run_id);
    assert.match(ralph(f.root, ["doctor"]).out, /clean/);
    cleanup(f.root);
  });
  await t.test("rerun refused after a workflow-file change (SHA changed: use a .g<n> repair)", () => {
    const f = makeFixture({ phases: onePhase() });
    ciScenario(f.root, "ci/0.verify/a1", { conclusion: "failure" });
    runPhaseGreen(f.root, "0", { until: "HUMAN_GATE 0.verifyh" });
    gate(f.root, ["0.verifyh"]);
    // a later commit on phase/0 changes the workflow file
    const wt = join(f.root, ".wt/tmp"); git(f.root, ["worktree", "add", "-q", wt, "phase/0"]);
    mkdirSync(join(wt, ".github/workflows"), { recursive: true }); writeFileSync(join(wt, ".github/workflows/ci.yml"), "fixed: true\n");
    git(f.root, ["-C", wt, "add", "-A"]); git(f.root, ["-C", wt, "commit", "-q", "-m", "workflow fix"]);
    const r = gate(f.root, ["rerun", "0.verifyh"]);
    assert.notEqual(r.status, 0); assert.match(r.out, /SHA changed: use a \.g<n> repair/);
    cleanup(f.root);
  });
  await t.test("gc deletes only refs of accepted/rejected/abandoned attempts", () => {
    const f = makeFixture({ phases: onePhase() });
    ciScenario(f.root, "ci/0.verify/a1", { conclusion: "failure" });
    runPhaseGreen(f.root, "0", { until: "HUMAN_GATE 0.verifyh" });
    gate(f.root, ["0.verifyh"]); // a1 rejected, ref stays
    gate(f.root, ["rerun", "0.verifyh"], { env: { RALPH_CRASH_AFTER: "run.json" } }); // a2 incomplete
    assert.deepEqual(Object.keys(fakeRefs(f.root)).sort(), ["ci/0.verify/a1", "ci/0.verify/a2"]);
    let r = gate(f.root, ["gc"]);
    assert.match(r.out, /deleted ci\/0\.verify\/a1 \(rejected\)/); assert.match(r.out, /kept +ci\/0\.verify\/a2 \(incomplete\)/);
    assert.deepEqual(Object.keys(fakeRefs(f.root)), ["ci/0.verify/a2"]);
    ok(gate(f.root, ["abandon", "0.verifyh", "a2", "--reason", "runner outage"]));
    assert.ok(existsSync(join(f.root, ".evidence/ci/0.verifyh/a2/abandoned.json")));
    r = gate(f.root, ["gc"]);
    assert.match(r.out, /deleted ci\/0\.verify\/a2 \(abandoned\)/);
    assert.deepEqual(Object.keys(fakeRefs(f.root)), []);
    assert.match(ralph(f.root, ["doctor"]).out, /clean/);
    cleanup(f.root);
  });
  await t.test("code-failed CI gate → plan request → 0.verify.g1 replaces 0.verifyh in every dependent; verifier_id records g1; release close resolves the candidate from 0.verify.g1h", () => {
    const f = makeFixture({ phases: [{ n: "0", tasks: phaseTasks("0", { next: "1", release: "0.1.0" }) }], versionFiles: versionFiles("0.1.0") });
    ciScenario(f.root, "ci/0.verify/a1", { conclusion: "failure" });
    runPhaseGreen(f.root, "0", { until: "HUMAN_GATE 0.verifyh" });
    let r = gate(f.root, ["0.verifyh"]);
    assert.match(r.out, /PLAN-GATE plan\.0\.verifyh\.r0/);
    ok(ralph(f.root, ["plan", "plan.0.verifyh.r0"]));
    // rewrite rule (a): fix task 0.2 after 0.verify, replacement producer 0.verify.g1 (needsCI), dependents → 0.verify.g1h
    const tasks = phaseTasks("0", { next: "1", release: "0.1.0" });
    const verify = tasks.find((x) => x.id === "0.verify");
    tasks.splice(tasks.indexOf(verify) + 1, 0,
      { id: "0.2", model: "sonnet", description: "fix the ci failure", acceptance: "x", dependencies: ["0.verify"] },
      { ...verify, id: "0.verify.g1", dependencies: ["0.2"], ci: { ...verify.ci, refTemplate: "ci/0.verify.g1/a{n}" } });
    tasks.find((x) => x.id === "0.9").dependencies = ["0.verify.g1"];
    principalCommit(f.root, join(f.root, ".wt/plan.0.verifyh.r0"), "plan.0.verifyh.r0", { prdText: prdFor([{ n: "0", tasks }]) });
    r = ralph(f.root, ["run", "--phase", "0"]);
    assert.equal(plans(f.root)[0].status, "resolved", r.out);
    assert.equal(state(f.root)["0.verifyh"].status, "superseded");
    const ctx = new Ctx(f.root);
    assert.deepEqual(ctx.task("0.9.r0a").dependencies, ["0.verify.g1h"]);
    const done = runPhaseGreen(f.root, "0");
    assert.ok(done.done, done.stopped ?? done.error ?? done.log.slice(-1)[0]);
    assert.equal(readFileSync(join(f.root, ".evidence/reviews/0/r0/verifier_id"), "utf8").trim(), "0.verify.g1");
    const rec = JSON.parse(readFileSync(join(f.root, ".evidence/closes/0.json"), "utf8"));
    assert.equal(rec.verifier_id, "0.verify.g1"); assert.equal(rec.candidate_gate_id, "0.verify.g1h");
    assert.equal(rec.candidate_sha, rec.verification_sha); assert.equal(rec.tag.name, "v0.1.0");
    assert.equal(refOid(f.root, "refs/tags/v0.1.0"), rec.tag.tag_object_oid);
    assert.equal(gitOut(f.root, ["rev-parse", "v0.1.0^{commit}"]), rec.main_sha);
    cleanup(f.root);
  });
  await t.test("a gate accepted.json whose artifact digests disagree with the files on disk is rejected by every consumer (close, §8.3)", () => {
    const f = makeFixture({ phases: [{ n: "0", tasks: phaseTasks("0", { next: "1", release: "0.1.0" }) }], versionFiles: versionFiles("0.1.0") });
    runPhaseGreen(f.root, "0", { until: "PRINCIPAL 0.9.r0d" });
    writeFileSync(join(f.root, ".evidence/ci/0.verifyh/a1/test-logs/test-logs.txt"), "tampered\n");
    assert.throws(() => readAcceptedCi(new Ctx(f.root), "0.verifyh"), /digest mismatch/);
    principalCommit(f.root, join(f.root, ".wt/0.9.r0d"), "0.9.r0d", { verdict: "PASS", phase: "0", attempt: "r0" });
    const r = ralph(f.root, ["run", "--phase", "0"]);
    assert.match(r.out, /digest mismatch/);
    assert.equal(state(f.root)["0.close"].status, "pending");
    assert.equal(refOid(f.root, "refs/tags/v0.1.0"), null);
    cleanup(f.root);
  });
});

test("reviews: failed r0 → 0.verify.r1 + r1 set; close depends on r1d and resolves the candidate from 0.verify.r1h; then r1 CI fails → 0.verify.r1.g1 (no id collision, verifier_id correct at each step)", () => {
  const f = makeFixture({ phases: [{ n: "0", tasks: phaseTasks("0", { next: "1", release: "0.1.0" }) }], versionFiles: versionFiles("0.1.0") });
  let r = runPhaseGreen(f.root, "0", { until: "PRINCIPAL 0.9.r0d" });
  assert.equal(r.stopped, "PRINCIPAL 0.9.r0d");
  assert.equal(readFileSync(join(f.root, ".evidence/reviews/0/r0/verifier_id"), "utf8").trim(), "0.verify");
  assert.equal(readFileSync(join(f.root, ".evidence/reviews/0/r0/verification_sha"), "utf8").trim(), readFileSync(join(f.root, ".evidence/reviews/0/r0/implementation_sha"), "utf8").trim());
  for (const who of ["claude", "sol", "grok"]) assert.ok(existsSync(join(f.root, `.evidence/reviews/0/r0/${who}/report.md`)), who);
  // reconciliation FAIL: fix task 0.3, 0.verify.r1, 0.9.r1a/b/c/d; close → 0.9.r1d
  const reviewSet = (k, deps) => [
    ...["a", "b", "c"].map((s, i) => ({ id: `0.9.r${k}${s}`, model: ["claude-opus", "sol", "grok"][i], execution: "reviewer", reviewer: ["claude", "sol", "grok"][i], reviewSet: "0.9", reviewAttempt: `r${k}`, description: `review r${k}`, acceptance: "x", dependencies: deps })),
    { id: `0.9.r${k}d`, model: "opus", execution: "interactive-principal", reviewSet: "0.9", reviewAttempt: `r${k}`, description: `reconcile r${k}`, acceptance: "x", dependencies: ["a", "b", "c"].map((s) => `0.9.r${k}${s}`) },
  ];
  let tasks = phaseTasks("0", { next: "1", release: "0.1.0" });
  const verify = tasks.find((x) => x.id === "0.verify");
  const close = tasks.find((x) => x.id === "0.close");
  tasks.splice(tasks.indexOf(close), 0,
    { id: "0.3", model: "sonnet", description: "fix from review", acceptance: "x", dependencies: ["0.9.r0d"] },
    { ...verify, id: "0.verify.r1", dependencies: ["0.3"], ci: { ...verify.ci, refTemplate: "ci/0.verify.r1/a{n}" } },
    ...reviewSet(1, ["0.verify.r1"]));
  close.dependencies = ["0.9.r1d"];
  principalCommit(f.root, join(f.root, ".wt/0.9.r0d"), "0.9.r0d", { verdict: "FAIL", phase: "0", attempt: "r0", prdText: prdFor([{ n: "0", tasks }]) });
  r = ralph(f.root, ["run", "--phase", "0"]);
  assert.equal(readFileSync(join(f.root, ".evidence/reviews/0/r0/verdict"), "utf8").trim(), "FAIL");
  assert.equal(state(f.root)["0.9.r0d"].status, "passed", "reconciliation integrates regardless of verdict");
  assert.equal(state(f.root)["0.3"].status, "passed", r.out);
  // r1's verifier CI fails (code) → plan → 0.verify.r1.g1 → r1 reviewers rewired
  ciScenario(f.root, "ci/0.verify.r1/a1", { conclusion: "failure" });
  r = runPhaseGreen(f.root, "0", { until: "HUMAN_GATE 0.verify.r1h" });
  r = gate(f.root, ["0.verify.r1h"]);
  assert.match(r.out, /PLAN-GATE plan\.0\.verify\.r1h\.r0/);
  ok(ralph(f.root, ["plan", "plan.0.verify.r1h.r0"]));
  const v1 = tasks.find((x) => x.id === "0.verify.r1");
  tasks.splice(tasks.indexOf(v1) + 1, 0,
    { id: "0.4", model: "sonnet", description: "fix ci", acceptance: "x", dependencies: ["0.verify.r1"] },
    { ...v1, id: "0.verify.r1.g1", dependencies: ["0.4"], ci: { ...v1.ci, refTemplate: "ci/0.verify.r1.g1/a{n}" } });
  for (const s of ["a", "b", "c"]) tasks.find((x) => x.id === `0.9.r1${s}`).dependencies = ["0.verify.r1.g1"];
  principalCommit(f.root, join(f.root, ".wt/plan.0.verify.r1h.r0"), "plan.0.verify.r1h.r0", { prdText: prdFor([{ n: "0", tasks }]) });
  r = ralph(f.root, ["run", "--phase", "0"]);
  assert.equal(plans(f.root)[0].status, "resolved", r.out);
  const done = runPhaseGreen(f.root, "0");
  assert.ok(done.done, done.stopped ?? done.error);
  assert.equal(readFileSync(join(f.root, ".evidence/reviews/0/r1/verifier_id"), "utf8").trim(), "0.verify.r1.g1");
  assert.equal(readFileSync(join(f.root, ".evidence/reviews/0/r1/verdict"), "utf8").trim(), "PASS");
  const rec = JSON.parse(readFileSync(join(f.root, ".evidence/closes/0.json"), "utf8"));
  assert.equal(rec.review_attempt, "r1"); assert.equal(rec.verifier_id, "0.verify.r1.g1"); assert.equal(rec.candidate_gate_id, "0.verify.r1.g1h");
  assert.equal(rec.candidate_sha, readFileSync(join(f.root, ".evidence/reviews/0/r1/verification_sha"), "utf8").trim());
  const ids = new Ctx(f.root).spec().map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "no id collision");
  cleanup(f.root);
});

test("close: crash before and after the ref transaction; completed close re-entered (no-op) and after drift (loud)", async (t) => {
  const f = makeFixture({ phases: onePhase() });
  runPhaseGreen(f.root, "0", { until: "PRINCIPAL 0.9.r0d" });
  principalCommit(f.root, join(f.root, ".wt/0.9.r0d"), "0.9.r0d", { verdict: "PASS", phase: "0", attempt: "r0" });
  ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_MAX_ITERATIONS: "1" } }); // integrates the reconciliation only
  assert.equal(state(f.root)["0.9.r0d"].status, "passed");
  const mainBefore = revParse(f.root, "main");
  await t.test("crash after intent, before refs: nothing moved; re-run is a clean run", () => {
    const r = ralph(f.root, ["close", "0"], { env: { RALPH_CRASH_AFTER: "close-intent" } });
    assert.equal(r.status, 99, r.out);
    assert.ok(existsSync(join(f.root, ".evidence/closes/0.intent.json")));
    assert.equal(revParse(f.root, "main"), mainBefore); assert.equal(refOid(f.root, "refs/heads/phase/1"), null);
    ok(ralph(f.root, ["close", "0"]));
    assert.ok(existsSync(join(f.root, ".evidence/closes/0.json")));
    assert.ok(!existsSync(join(f.root, ".evidence/closes/0.intent.json")));
    assert.equal(revParse(f.root, "main"), revParse(f.root, "phase/0"));
    assert.equal(revParse(f.root, "phase/1"), revParse(f.root, "main"));
    assert.equal(phasesJson(f.root)["1"].created_by, "0.close");
    assert.equal(state(f.root)["0.close"].status, "passed");
  });
  await t.test("completed close re-entered is a no-op; after ref drift it fails loudly", () => {
    const r = ralph(f.root, ["close", "0"]);
    assert.match(r.out, /CLOSED 0 \(no-op/);
    git(f.root, ["update-ref", "refs/heads/phase/1", gitOut(f.root, ["rev-parse", "main^"])]);
    const d = ralph(f.root, ["close", "0"]);
    assert.notEqual(d.status, 0); assert.match(d.out, /CLOSE-DRIFT 0/);
    assert.match(ralph(f.root, ["doctor"]).out, /close-drift 0/);
  });
  await t.test("crash after refs, before finalise: retry only finalises (no second transaction)", () => {
    const f2 = makeFixture({ phases: onePhase() });
    runPhaseGreen(f2.root, "0", { until: "PRINCIPAL 0.9.r0d" });
    principalCommit(f2.root, join(f2.root, ".wt/0.9.r0d"), "0.9.r0d", { verdict: "PASS", phase: "0", attempt: "r0" });
    ralph(f2.root, ["run", "--phase", "0"], { env: { RALPH_MAX_ITERATIONS: "1" } });
    const r = ralph(f2.root, ["close", "0"], { env: { RALPH_CRASH_AFTER: "close-refs" } });
    assert.equal(r.status, 99, r.out);
    assert.equal(revParse(f2.root, "main"), revParse(f2.root, "phase/0"));
    assert.ok(existsSync(join(f2.root, ".evidence/closes/0.intent.json")));
    assert.ok(!phasesJson(f2.root)["1"]);
    ok(ralph(f2.root, ["close", "0"]));
    assert.ok(existsSync(join(f2.root, ".evidence/closes/0.json")));
    assert.equal(phasesJson(f2.root)["1"].base_main_sha, revParse(f2.root, "main"));
    assert.match(ralph(f2.root, ["close", "0"]).out, /no-op/);
    cleanup(f2.root);
  });
  cleanup(f.root);
});

test("phase records for the 4 → 6 → 5 → terminal order, release tags v0.1.0 and v0.2.0, terminal close writes no phase record", () => {
  const phases = [
    { n: "4", tasks: phaseTasks("4", { next: "6" }) },
    { n: "6", tasks: phaseTasks("6", { next: "5", release: "0.1.0", first: "4.close" }) },
    { n: "5", tasks: phaseTasks("5", { release: "0.2.0", first: "6.close" }) },
  ];
  const f = makeFixture({ phases, currentPhase: "4", versionFiles: versionFiles("0.1.0") });
  control(f.root, "5.1", { files: versionFiles("0.2.0") });
  for (const n of ["4", "6", "5"]) { const r = runPhaseGreen(f.root, n); assert.ok(r.done, `phase ${n}: ${r.stopped ?? r.error}`); }
  const p = phasesJson(f.root);
  assert.equal(p["6"].created_by, "4.close"); assert.equal(p["5"].created_by, "6.close");
  assert.deepEqual(Object.keys(p).sort(), ["4", "5", "6"]);
  const c6 = JSON.parse(readFileSync(join(f.root, ".evidence/closes/6.json"), "utf8"));
  const c5 = JSON.parse(readFileSync(join(f.root, ".evidence/closes/5.json"), "utf8"));
  assert.equal(c6.next_phase, "5"); assert.equal(c6.tag.name, "v0.1.0");
  assert.equal(c5.next_phase, undefined); assert.equal(c5.tag.name, "v0.2.0");
  assert.equal(gitOut(f.root, ["rev-parse", "v0.2.0^{commit}"]), revParse(f.root, "main"));
  assert.equal(gitOut(f.root, ["rev-parse", "v0.1.0^{commit}"]), c6.main_sha);
  assert.equal(p["5"].base_main_sha, c6.main_sha);
  assert.match(ralph(f.root, ["run"]).out, /<promise>COMPLETE<\/promise>/);
  assert.match(ralph(f.root, ["doctor"]).out, /clean/);
  cleanup(f.root);
});

test("planning commit: crash around candidate tag / update-ref (doctor + admin), and a failed detached test → integration-failed → plan-retry", async (t) => {
  const f = makeFixture({ phases: onePhase({ extra: [approval] }) });
  runPhaseGreen(f.root, "0", { until: "HUMAN_GATE 0.5v" });
  gate(f.root, ["0.5v", "--outcome", "REJECT", "--note", "no"]);
  ok(ralph(f.root, ["plan", "plan.0.5v.r0"]));
  const tasks = phaseTasks("0", { next: "1", extra: [approval, { id: "0.6", model: "sonnet", description: "fix", acceptance: "x", dependencies: ["0.1"] }, { ...approval, id: "0.5v.r1", dependencies: ["0.6"] }] });
  tasks.find((x) => x.id === "0.verify").dependencies = ["0.1", "0.5v.r1"];
  const wt = join(f.root, ".wt/plan.0.5v.r0");
  await t.test("detached test failure → integration-failed → plan-retry → resolved", () => {
    principalCommit(f.root, wt, "plan.0.5v.r0", { prdText: prdFor([{ n: "0", tasks }]), files: { FAIL_CANDIDATE: "" } });
    let r = ralph(f.root, ["run", "--phase", "0"]);
    assert.match(r.out, /INTEGRATION-FAILED plan\.0\.5v\.r0/);
    assert.equal(plans(f.root)[0].status, "integration-failed");
    assert.notEqual(ralph(f.root, ["plan", "plan.0.5v.r0"]).status, 0, "plan needs pending");
    ok(ralph(f.root, ["plan-retry", "plan.0.5v.r0"]));
    assert.equal(plans(f.root)[0].status, "pending"); assert.equal(plans(f.root)[0].attempts, 0);
    ok(ralph(f.root, ["plan", "plan.0.5v.r0"]));
    git(f.root, ["-C", wt, "rm", "-q", "FAIL_CANDIDATE"]); git(f.root, ["-C", wt, "commit", "-q", "-m", `wip(plan.0.5v.r0): fix\n\n<promise>DONE plan.0.5v.r0</promise>`]);
    r = ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_CRASH_AFTER: "candidate-tag" } });
    assert.equal(r.status, 99, r.out);
    const d = ralph(f.root, ["doctor"]).out;
    assert.match(d, /unfinished-integration plan\.0\.5v\.r0 \(target == expected-old\) → ralph\.sh admin retry plan\.0\.5v\.r0/);
    assert.equal(d.split("\n").filter((l) => /→/.test(l)).length, 1);
    assert.notEqual(ralph(f.root, ["admin", "mark-integrated", "plan.0.5v.r0"]).status, 0);
    ok(ralph(f.root, ["admin", "retry", "plan.0.5v.r0"]));
    r = ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_CRASH_AFTER: "update-ref" } });
    assert.equal(r.status, 99, r.out);
    assert.match(ralph(f.root, ["doctor"]).out, /unfinished-integration plan\.0\.5v\.r0 \(target == candidate\) → ralph\.sh admin mark-integrated plan\.0\.5v\.r0/);
    assert.notEqual(ralph(f.root, ["admin", "retry", "plan.0.5v.r0"]).status, 0);
    ok(ralph(f.root, ["admin", "mark-integrated", "plan.0.5v.r0"]));
    assert.match(ralph(f.root, ["doctor"]).out, /clean/);
    assert.equal(plans(f.root)[0].status, "resolved");
    assert.equal(state(f.root)["0.5v"].status, "superseded");
    assert.ok(state(f.root)["0.5v.r1"], "new tasks entered runtime state");
  });
  cleanup(f.root);
});

test("external task (loop-external): integration in the external repo; crash around candidate tag / update-ref; doctor + admin; external state recorded", async (t) => {
  const ext = { id: "post.3", phase: "0", model: "sonnet", execution: "loop-external", description: "apply hunks", acceptance: "x", dependencies: ["0.1"], targetBranch: "phase/0", externalRepoId: "build-defaults", externalRepoPath: "/work/.ext/build-defaults", externalTargetRef: "refs/heads/main", externalVerify: "node scripts/validate-defaults.mjs", beforeVerify: true };
  const f = makeFixture({ phases: onePhase({ extra: [ext] }), external: true });
  ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_MAX_ITERATIONS: "1" } }); // 0.1
  const extMain = revParse(f.ext, "main");
  await t.test("crash after candidate tag in the external repo → admin retry; crash after update-ref → admin mark-integrated", () => {
    let r = ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_CRASH_AFTER: "candidate-tag", RALPH_MAX_ITERATIONS: "1" } });
    assert.equal(r.status, 99, r.out);
    assert.equal(revParse(f.ext, "main"), extMain);
    assert.ok(refOid(f.ext, "refs/tags/candidate/post.3"));
    let d = ralph(f.root, ["doctor"]).out;
    assert.match(d, /unfinished-integration post\.3 \(target == expected-old\) → ralph\.sh admin retry post\.3/);
    assert.equal(d.split("\n").filter((l) => /→/.test(l)).length, 1);
    assert.notEqual(ralph(f.root, ["admin", "mark-integrated", "post.3"]).status, 0);
    ok(ralph(f.root, ["admin", "retry", "post.3"]));
    r = ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_CRASH_AFTER: "update-ref", RALPH_MAX_ITERATIONS: "1" } });
    assert.equal(r.status, 99, r.out);
    d = ralph(f.root, ["doctor"]).out;
    assert.match(d, /unfinished-integration post\.3 \(target == candidate\) → ralph\.sh admin mark-integrated post\.3/);
    assert.notEqual(ralph(f.root, ["admin", "retry", "post.3"]).status, 0);
    ok(ralph(f.root, ["admin", "mark-integrated", "post.3"]));
    assert.match(ralph(f.root, ["doctor"]).out, /clean/);
    const s = state(f.root)["post.3"];
    assert.equal(s.status, "passed"); assert.equal(s.integrated_sha, revParse(f.ext, "main"));
    assert.match(gitOut(f.ext, ["log", "-1", "--format=%s"]), /^task\(post\.3\)/);
    const st = JSON.parse(readFileSync(join(f.root, ".evidence/external/build-defaults/state.json"), "utf8"));
    assert.equal(st.head_sha, revParse(f.ext, "main")); assert.equal(st.base_sha, extMain);
    assert.equal(revParse(f.root, "phase/0"), state(f.root)["0.1"].integrated_sha, "no Essay Down commit for an external task");
  });
  cleanup(f.root);
});

test("sync-state refuses mutation of a started task and deletion of a passed task; accepts growth", () => {
  const f = makeFixture({ phases: onePhase() });
  ralph(f.root, ["run", "--phase", "0"], { env: { RALPH_MAX_ITERATIONS: "1" } });
  assert.equal(state(f.root)["0.1"].status, "passed");
  const wt = join(f.root, ".wt/tmp"); git(f.root, ["worktree", "add", "-q", wt, "phase/0"]);
  const tasks = phaseTasks("0", { next: "1" });
  tasks.find((x) => x.id === "0.1").description = "mutated";
  writeSpec(wt, prdFor([{ n: "0", tasks }]));
  git(f.root, ["-C", wt, "add", "-A"]); git(f.root, ["-C", wt, "commit", "-q", "-m", "mutate"]);
  let r = ralph(f.root, ["sync-state", "--ref", "phase/0"]);
  assert.notEqual(r.status, 0); assert.match(r.out, /task 0\.1 \(passed\) was mutated/);
  const tasks2 = phaseTasks("0", { next: "1" });
  tasks2.splice(0, 1);
  tasks2.find((x) => x.id === "0.verify").dependencies = [];
  writeSpec(wt, prdFor([{ n: "0", tasks: tasks2 }]));
  git(f.root, ["-C", wt, "add", "-A"]); git(f.root, ["-C", wt, "commit", "-q", "-m", "delete"]);
  r = ralph(f.root, ["sync-state", "--ref", "phase/0"]);
  assert.notEqual(r.status, 0); assert.match(r.out, /deleted by the planning commit/);
  const tasks3 = phaseTasks("0", { next: "1", extra: [{ id: "0.2", model: "sonnet", description: "new", acceptance: "x", dependencies: ["0.1"] }] });
  writeSpec(wt, prdFor([{ n: "0", tasks: tasks3 }]));
  git(f.root, ["-C", wt, "add", "-A"]); git(f.root, ["-C", wt, "commit", "-q", "-m", "grow"]);
  ok(ralph(f.root, ["sync-state", "--ref", "phase/0"]));
  assert.equal(state(f.root)["0.2"].status, "pending");
  // tasks.json not byte-identical to the PRD → refused
  writeFileSync(join(wt, "ralph/tasks.json"), "[]\n"); git(f.root, ["-C", wt, "add", "-A"]); git(f.root, ["-C", wt, "commit", "-q", "-m", "drift"]);
  r = ralph(f.root, ["sync-state", "--ref", "phase/0"]);
  assert.notEqual(r.status, 0); assert.match(r.out, /not byte-identical/);
  cleanup(f.root);
});

test("replan task: after integration the replanTarget is principal-pending and REPLAN is emitted; human observation gate payload is readable", () => {
  const extra = [
    { id: "0.6m", model: "sonnet", execution: "replan", description: "measure", acceptance: "x", dependencies: ["0.1"], replanTarget: "0.6r" },
    { id: "0.6r", model: "opus", execution: "interactive-principal", description: "re-plan", acceptance: "x", dependencies: ["0.6m"], beforeVerify: true },
    { id: "0.7", model: "opus", execution: "human", description: "observe", acceptance: "x", dependencies: ["0.1"], blockedOnHuman: true, gateKind: "observation", recordTarget: "002-outline", beforeVerify: true },
  ];
  const f = makeFixture({ phases: onePhase({ extra }) });
  let r = ralph(f.root, ["run", "--phase", "0"]);
  assert.match(r.out, /REPLAN 0\.6r/);
  assert.equal(state(f.root)["0.6m"].status, "passed"); assert.equal(state(f.root)["0.6r"].status, "principal-pending");
  r = ralph(f.root, ["run", "--phase", "0"]);
  assert.match(r.out, /PRINCIPAL 0\.6r/);
  principalCommit(f.root, join(f.root, ".wt/0.6r"), "0.6r", { files: { "docs/PLATFORM-NOTES.md": "none\n" } });
  r = ralph(f.root, ["run", "--phase", "0"]);
  assert.equal(state(f.root)["0.6r"].status, "passed", r.out);
  assert.match(r.out, /HUMAN_GATE 0\.7/);
  r = gate(f.root, ["0.7", "--outcome", "REJECT", "--note", "x"]);
  assert.notEqual(r.status, 0, "observation gates only ACCEPT");
  ok(gate(f.root, ["0.7", "--outcome", "ACCEPT", "--payload", "verdictText=keep it", "--payload", "count=3", "--note", "Outline feels right."]));
  const acc = JSON.parse(readFileSync(join(f.root, ".evidence/human/0.7/accepted.json"), "utf8"));
  assert.equal(acc.payload.verdictText, "keep it"); assert.equal(acc.payload.count, 3); assert.equal(acc.attempt, 1);
  assert.match(readFileSync(join(f.root, ".evidence/human/0.7/a1.md"), "utf8"), /recordTarget: 002-outline/);
  const done = runPhaseGreen(f.root, "0");
  assert.ok(done.done, done.stopped ?? done.error);
  cleanup(f.root);
});
