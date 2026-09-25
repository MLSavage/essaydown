// validator.test.mjs — RUNNER-SPEC §3 schema rules and §12 "validator rejecting each schema violation".
import { test } from "node:test";
import assert from "node:assert/strict";
import { expand, extractRawTasks } from "../generate-tasks.mjs";
import { validate } from "../validate-tasks.mjs";
import { phaseTasks, prdFor } from "./harness.mjs";

const base = () => extractRawTasks(prdFor([{ n: "0", tasks: phaseTasks("0", { next: "1", extra: [
  { id: "0.5v", model: "opus", execution: "human", description: "approval", acceptance: "x", dependencies: ["0.1"], blockedOnHuman: true, gateKind: "approval", recordTarget: "008", outcomes: { ACCEPT: "continue", REJECT: "plan-gate" }, beforeVerify: true },
  { id: "0.6m", model: "sonnet", execution: "replan", description: "replan", acceptance: "x", dependencies: ["0.1"], replanTarget: "0.6r" },
  { id: "0.6r", model: "opus", execution: "interactive-principal", description: "replan target", acceptance: "x", dependencies: ["0.6m"] },
  { id: "post.3", phase: "0", model: "sonnet", execution: "loop-external", description: "ext", acceptance: "x", dependencies: ["0.1"], targetBranch: "phase/0", externalRepoId: "build-defaults", externalRepoPath: "/work/.ext/build-defaults", externalTargetRef: "refs/heads/main", externalVerify: "node scripts/validate-defaults.mjs" },
] }) }])).tasks;

const errorsFor = (mutate) => { const raw = base(); mutate(raw); const exp = expand(raw); return validate(exp, { expectedCount: exp.length }); };
const find = (raw, id) => raw.find((t) => t.id === id);

test("the declared fixture graph validates", () => {
  const exp = expand(base());
  assert.deepEqual(validate(exp, { expectedCount: exp.length }), []);
});

test("expanded count must equal EXPECTED_COUNT", () => {
  const exp = expand(base());
  assert.match(validate(exp, { expectedCount: exp.length + 1 }).join("\n"), /expanded count/);
});

const cases = [
  ["duplicate id", (raw) => raw.push({ ...find(raw, "0.1") }), /duplicate expanded id 0\.1/],
  ["unresolved dependency", (raw) => find(raw, "0.1").dependencies.push("9.9"), /dependency 9\.9 does not resolve/],
  ["cycle", (raw) => { find(raw, "0.1").dependencies.push("0.verify"); }, /cycle/],
  ["unknown execution", (raw) => { find(raw, "0.1").execution = "magic"; }, /execution "magic"/],
  ["blockedOnHuman on a loop task", (raw) => { find(raw, "0.1").blockedOnHuman = true; }, /blockedOnHuman on execution loop/],
  ["human without gateKind", (raw) => { delete find(raw, "0.5v").gateKind; }, /gateKind undefined/],
  ["unknown gateKind publication", (raw) => { find(raw, "0.5v").gateKind = "publication"; }, /gateKind "publication"/],
  ["human with neither recordTarget nor evidence-only", (raw) => { delete find(raw, "0.5v").recordTarget; }, /exactly one of recordTarget/],
  ["human with both recordTarget and evidence-only", (raw) => { find(raw, "0.5v").recordPolicy = "evidence-only"; }, /exactly one of recordTarget/],
  ["approval without outcomes", (raw) => { delete find(raw, "0.5v").outcomes; }, /approval gate without outcomes/],
  ["approval with wrong outcome key", (raw) => { find(raw, "0.5v").outcomes = { ACCEPT: "continue", "GATE-FAILED": "plan-gate" }; }, /outcomes\.REJECT/],
  ["needsCI without ci object", (raw) => { delete find(raw, "0.verify").ci; }, /needsCI without ci object/],
  ["needsCI with refType tag", (raw) => { find(raw, "0.verify").ci = { ...find(raw, "0.verify").ci, refType: "tag", refTemplate: "v0.1.0" }; }, /refType "ci"/],
  ["ci refType ci without cleanupRef", (raw) => { find(raw, "0.verify").ci = { ...find(raw, "0.verify").ci, cleanupRef: false }; }, /cleanupRef: true/],
  ["ci refTemplate not ci/<id>/a{n}", (raw) => { find(raw, "0.verify").ci = { ...find(raw, "0.verify").ci, refTemplate: "ci/0.verify/r{n}" }; }, /refTemplate must be/],
  ["needsCI without ciAcceptance", (raw) => { delete find(raw, "0.verify").ciAcceptance; }, /without ciAcceptance/],
  ["replan target not interactive-principal", (raw) => { find(raw, "0.6r").execution = "loop"; }, /not interactive-principal/],
  ["replan target unresolved", (raw) => { find(raw, "0.6m").replanTarget = "nope"; }, /replanTarget "nope" does not resolve/],
  ["loop-external missing a field", (raw) => { delete find(raw, "post.3").externalVerify; }, /loop-external without externalVerify/],
  ["close with two sourceBranches", (raw) => { find(raw, "0.close").sourceBranches = ["phase/0", "phase/1"]; }, /exactly one sourceBranches/],
  ["close targetBranch not main", (raw) => { find(raw, "0.close").targetBranch = "phase/0"; }, /targetBranch must be main/],
  ["close with nextPhase but no nextBranch", (raw) => { delete find(raw, "0.close").nextBranch; }, /both nextPhase and nextBranch or neither/],
  ["close with a non-semver releaseVersion", (raw) => { find(raw, "0.close").releaseVersion = "v1"; }, /releaseVersion "v1" is not semver/],
  ["nextPhase on a non-close task", (raw) => { find(raw, "0.1").nextPhase = "1"; }, /nextPhase on a non-close task/],
  ["phase without a review set", (raw) => { raw.splice(raw.findIndex((t) => t.id === "0.9"), 1); find(raw, "0.close").dependencies = ["0.verify"]; }, /exactly one r0 review set/],
  ["phase without an initial verifier", (raw) => { const v = find(raw, "0.verify"); v.id = "0.check"; v.ci.refTemplate = "ci/0.check/a{n}"; find(raw, "0.9").dependencies = ["0.check"]; }, /initial verifier 0\.verify missing/],
  ["phase without a close", (raw) => { raw.splice(raw.findIndex((t) => t.id === "0.close"), 1); }, /exactly one close/],
  ["unknown model", (raw) => { find(raw, "0.1").model = "gpt"; }, /model "gpt"/],
  ["shell-unsafe id", (raw) => { find(raw, "0.1").id = "0.1'"; }, /shell-safe id/],
];
for (const [name, mutate, re] of cases) test(`validator rejects: ${name}`, () => { const errs = errorsFor(mutate); assert.ok(errs.length > 0, "expected errors"); assert.match(errs.join("\n"), re); });

// Grok r0-only (Michael, Phase 2 boundary): an r<k> (k ≥ 1) attempt may omit its `c` row; r0 may not
const addR1 = (raw, suffixes, dDeps = suffixes) => {
  const rev = { a: ["claude", "claude-opus"], b: ["sol", "sol"], c: ["grok", "grok"] };
  raw.push({ id: "0.2", model: "sonnet", description: "fix", acceptance: "x", dependencies: ["0.9"] });
  const v = find(raw, "0.verify");
  raw.push({ ...v, id: "0.verify.r1", dependencies: ["0.2"], ci: { ...v.ci, refTemplate: "ci/0.verify.r1/a{n}" } });
  for (const s of suffixes) raw.push({ id: `0.9.r1${s}`, model: rev[s][1], execution: "reviewer", reviewer: rev[s][0], reviewSet: "0.9", reviewAttempt: "r1", description: "x", acceptance: "x", dependencies: ["0.verify.r1"] });
  raw.push({ id: "0.9.r1d", model: "opus", execution: "interactive-principal", reviewSet: "0.9", reviewAttempt: "r1", description: "x", acceptance: "x", dependencies: dDeps.map((s) => `0.9.r1${s}`) });
  find(raw, "0.close").dependencies = ["0.9.r1d"];
};
const validateRaw = (raw) => { const exp = expand(raw); return validate(exp, { expectedCount: exp.length }); };

test("Grok r0-only: an r1 attempt with a and b and a d depending on a and b validates", () => {
  const raw = base(); addR1(raw, ["a", "b"]);
  assert.deepEqual(validateRaw(raw), []);
});
test("Grok r0-only: an r1 attempt with c present still validates (and d must depend on it)", () => {
  const raw = base(); addR1(raw, ["a", "b", "c"]);
  assert.deepEqual(validateRaw(raw), []);
  const raw2 = base(); addR1(raw2, ["a", "b", "c"], ["a", "b"]);
  assert.match(validateRaw(raw2).join("\n"), /0\.9\.r1d: must depend on 0\.9\.r1a, 0\.9\.r1b, 0\.9\.r1c/);
});
test("Grok r0-only: an r1 attempt without b is rejected", () => {
  const raw = base(); addR1(raw, ["a"]);
  assert.match(validateRaw(raw).join("\n"), /attempt r1 lacks a\/b reviewer tasks/);
});
test("Grok r0-only: r0 is still generated with a/b/c and an r0 without c is rejected", () => {
  const exp = expand(base());
  assert.deepEqual(exp.filter((t) => t.reviewAttempt === "r0").map((t) => t.id), ["0.9.r0a", "0.9.r0b", "0.9.r0c", "0.9.r0d"]);
  const cut = exp.filter((t) => t.id !== "0.9.r0c").map((t) => (t.id === "0.9.r0d" ? { ...t, dependencies: ["0.9.r0a", "0.9.r0b"] } : t));
  assert.match(validate(cut, { expectedCount: cut.length }).join("\n"), /attempt r0 lacks a\/b\/c reviewer tasks/);
});

test("review attempt chain must be linear and the close must depend on the newest d", () => {
  const raw = base();
  // add an r2 attempt without r1
  for (const s of ["a", "b", "c"]) raw.push({ id: `0.9.r2${s}`, model: "sol", execution: "reviewer", reviewer: "sol", reviewSet: "0.9", reviewAttempt: "r2", description: "x", acceptance: "x", dependencies: ["0.verify"] });
  raw.push({ id: "0.9.r2d", model: "opus", execution: "interactive-principal", reviewSet: "0.9", reviewAttempt: "r2", description: "x", acceptance: "x", dependencies: ["0.9.r2a", "0.9.r2b", "0.9.r2c"] });
  const exp = expand(raw);
  const errs = validate(exp, { expectedCount: exp.length }).join("\n");
  assert.match(errs, /not a linear chain/);
  assert.match(errs, /must depend on the newest review attempt 0\.9\.r2d/);
});
