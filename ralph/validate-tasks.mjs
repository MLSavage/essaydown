#!/usr/bin/env node
// validate-tasks.mjs — schema and graph checks on the expanded ralph/tasks.json (RUNNER-SPEC §3). Plain Node, no deps.
//   node ralph/validate-tasks.mjs             validate ralph/tasks.json against ralph/EXPECTED_COUNT and the PRD regeneration
// Exported `validate(tasks, {expectedCount})` returns [] or a list of error strings (used by the conformance suite).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EXECUTIONS, generate } from "./generate-tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_KINDS = ["observation", "approval", "ci"];
const MODELS = ["sonnet", "opus", "claude-opus", "sol", "grok"];
const OUTCOMES = ["ACCEPT", "REJECT", "GATE-FAILED"];
const SEMVER = /^\d+\.\d+\.\d+$/;

export function validate(tasks, { expectedCount = null } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!Array.isArray(tasks)) return ["tasks.json is not an array"];
  const byId = new Map();
  for (const t of tasks) {
    if (!t || typeof t.id !== "string" || !/^[A-Za-z0-9.]+$/.test(t.id)) { err(`task without a shell-safe id: ${JSON.stringify(t?.id)}`); continue; }
    if (byId.has(t.id)) err(`duplicate expanded id ${t.id}`);
    byId.set(t.id, t);
  }
  // per-task schema
  for (const t of byId.values()) {
    const id = t.id;
    if (!EXECUTIONS.includes(t.execution)) err(`${id}: execution ${JSON.stringify(t.execution)} not in ${EXECUTIONS.join("|")}`);
    if (!MODELS.includes(t.model)) err(`${id}: model ${JSON.stringify(t.model)} not in ${MODELS.join("|")}`);
    if (typeof t.description !== "string" || !t.description) err(`${id}: description missing`);
    if (typeof t.acceptance !== "string") err(`${id}: acceptance missing`);
    if (!Array.isArray(t.dependencies)) err(`${id}: dependencies not an array`);
    else for (const d of t.dependencies) if (!byId.has(d)) err(`${id}: dependency ${d} does not resolve`);
    if (typeof t.targetBranch !== "string" || !/^(main|phase\/\d+)$/.test(t.targetBranch)) err(`${id}: targetBranch ${JSON.stringify(t.targetBranch)} invalid`);
    if (t.blockedOnHuman && t.execution !== "human") err(`${id}: blockedOnHuman on execution ${t.execution}`);
    if (t.execution === "human") {
      if (t.blockedOnHuman !== true) err(`${id}: human task without blockedOnHuman: true`);
      if (!GATE_KINDS.includes(t.gateKind)) err(`${id}: gateKind ${JSON.stringify(t.gateKind)} not in ${GATE_KINDS.join("|")}`);
      const hasTarget = typeof t.recordTarget === "string" && t.recordTarget.length > 0;
      const evidenceOnly = t.recordPolicy === "evidence-only";
      if (hasTarget === evidenceOnly) err(`${id}: human task needs exactly one of recordTarget / recordPolicy: evidence-only`);
      if (t.recordPolicy !== undefined && t.recordPolicy !== "evidence-only") err(`${id}: recordPolicy must be "evidence-only"`);
      if (t.gateKind === "approval" || t.gateKind === "ci") {
        if (!t.outcomes || typeof t.outcomes !== "object") err(`${id}: ${t.gateKind} gate without outcomes`);
        else {
          if (t.outcomes.ACCEPT !== "continue") err(`${id}: outcomes.ACCEPT must be "continue"`);
          const bad = t.gateKind === "approval" ? "REJECT" : "GATE-FAILED";
          if (t.outcomes[bad] !== "plan-gate") err(`${id}: outcomes.${bad} must be "plan-gate"`);
          for (const k of Object.keys(t.outcomes)) if (!OUTCOMES.includes(k)) err(`${id}: unknown outcome ${k}`);
        }
      }
      if (t.gateKind === "ci") {
        if (!t.gateFor || !byId.has(t.gateFor)) err(`${id}: ci gate without a resolving gateFor`);
        if (!t.ci) err(`${id}: ci gate without ci object`);
      }
    } else {
      if (t.gateKind !== undefined) err(`${id}: gateKind on non-human task`);
      if (t.outcomes !== undefined) err(`${id}: outcomes on non-human task`);
    }
    if (t.needsCI) {
      if (!t.ci || typeof t.ci !== "object") err(`${id}: needsCI without ci object`);
      else {
        const c = t.ci;
        if (c.refType !== "ci") err(`${id}: needsCI task must use ci.refType "ci" (got ${JSON.stringify(c.refType)}; tags are created only by N.close)`);
        if (c.refType === "ci" && c.cleanupRef !== true) err(`${id}: ci.refType ci requires cleanupRef: true`);
        if (c.refType === "ci" && c.refTemplate !== `ci/${id}/a{n}`) err(`${id}: ci.refTemplate must be ci/${id}/a{n} (got ${JSON.stringify(c.refTemplate)})`);
        if (typeof c.workflow !== "string" || !c.workflow) err(`${id}: ci.workflow missing`);
        if (c.trigger !== "push") err(`${id}: ci.trigger must be "push"`);
        if (!Array.isArray(c.artifactNames) || c.artifactNames.length === 0) err(`${id}: ci.artifactNames empty`);
      }
      if (!byId.has(`${id}h`)) err(`${id}: needsCI without generated gate ${id}h`);
      if (typeof t.ciAcceptance !== "string" || !t.ciAcceptance) err(`${id}: needsCI without ciAcceptance`);
    } else if (t.ci && t.execution !== "human") {
      err(`${id}: ci object on a task without needsCI`);
    }
    if (t.execution === "replan") {
      const target = byId.get(t.replanTarget);
      if (!target) err(`${id}: replanTarget ${JSON.stringify(t.replanTarget)} does not resolve`);
      else if (target.execution !== "interactive-principal") err(`${id}: replanTarget ${t.replanTarget} is ${target.execution}, not interactive-principal`);
    } else if (t.replanTarget !== undefined) err(`${id}: replanTarget on execution ${t.execution}`);
    if (t.execution === "loop-external") {
      for (const f of ["externalRepoId", "externalRepoPath", "externalTargetRef", "externalVerify"]) if (typeof t[f] !== "string" || !t[f]) err(`${id}: loop-external without ${f}`);
    }
    if (t.execution === "reviewer" && !["claude", "sol", "grok"].includes(t.reviewer)) err(`${id}: reviewer task without reviewer`);
    if (/\.close$/.test(id)) {
      if (t.execution !== "runner") err(`${id}: close must be execution runner`);
      if (!Array.isArray(t.sourceBranches) || t.sourceBranches.length !== 1) err(`${id}: close needs exactly one sourceBranches entry`);
      if (t.targetBranch !== "main") err(`${id}: close targetBranch must be main`);
      const hasNext = t.nextPhase !== undefined, hasBranch = t.nextBranch !== undefined;
      if (hasNext !== hasBranch) err(`${id}: close needs both nextPhase and nextBranch or neither`);
      if (hasBranch && t.nextBranch !== `phase/${t.nextPhase}`) err(`${id}: nextBranch must be phase/${t.nextPhase}`);
      if (t.releaseVersion !== undefined && !SEMVER.test(t.releaseVersion)) err(`${id}: releaseVersion ${JSON.stringify(t.releaseVersion)} is not semver`);
    } else {
      for (const f of ["sourceBranches", "nextPhase", "nextBranch", "releaseVersion"]) if (t[f] !== undefined) err(`${id}: ${f} on a non-close task`);
    }
    if (t.execution === "bootstrap" && id !== "0.0") err(`${id}: only 0.0 is bootstrap`);
  }
  // acyclic (Kahn)
  {
    const indeg = new Map([...byId.keys()].map((k) => [k, 0]));
    for (const t of byId.values()) for (const d of t.dependencies ?? []) if (byId.has(d)) indeg.set(t.id, indeg.get(t.id) + 1);
    const q = [...indeg].filter(([, n]) => n === 0).map(([k]) => k);
    let seen = 0;
    while (q.length) {
      const k = q.shift(); seen++;
      for (const t of byId.values()) if ((t.dependencies ?? []).includes(k) && indeg.set(t.id, indeg.get(t.id) - 1) && indeg.get(t.id) === 0) q.push(t.id);
    }
    if (seen !== byId.size) err(`graph has a cycle (${byId.size - seen} tasks unreachable from the roots)`);
  }
  // per phase: one r0 review set, one initial verifier, one close, linear attempt chain, close depends on newest d
  const phases = new Set([...byId.values()].map((t) => t.phase).filter((p) => p !== undefined));
  for (const t of byId.values()) if (t.phase === undefined) err(`${t.id}: phase missing`);
  for (const p of phases) {
    const inPhase = [...byId.values()].filter((t) => t.phase === p);
    const r0d = inPhase.filter((t) => t.reviewAttempt === "r0" && /d$/.test(t.id) && t.execution === "interactive-principal");
    if (r0d.length !== 1) err(`phase ${p}: expected exactly one r0 review set, found ${r0d.length}`);
    const verifier = byId.get(`${p}.verify`);
    if (!verifier) err(`phase ${p}: initial verifier ${p}.verify missing`);
    else if (!verifier.needsCI) err(`phase ${p}: ${p}.verify must be needsCI`);
    const closes = inPhase.filter((t) => /\.close$/.test(t.id));
    if (closes.length !== 1) err(`phase ${p}: expected exactly one close, found ${closes.length}`);
    if (r0d.length === 1) {
      const set = r0d[0].reviewSet;
      const attempts = inPhase.filter((t) => t.reviewSet === set && /d$/.test(t.id)).map((t) => Number(/\.r(\d+)d$/.exec(t.id)?.[1])).sort((a, b) => a - b);
      for (let k = 0; k < attempts.length; k++) if (attempts[k] !== k) err(`phase ${p}: review attempts are not a linear chain r0..r${attempts.length - 1} (found r${attempts[k]})`);
      const newest = `${set}.r${attempts[attempts.length - 1]}d`;
      for (const k of attempts) {
        const d = byId.get(`${set}.r${k}d`);
        const abc = ["a", "b", "c"].map((s) => byId.get(`${set}.r${k}${s}`));
        if (abc.some((x) => !x)) { err(`phase ${p}: attempt r${k} lacks a/b/c reviewer tasks`); continue; }
        for (const x of abc) if (x.execution !== "reviewer") err(`${x.id}: must be execution reviewer`);
        if (!abc.every((x) => d.dependencies.includes(x.id))) err(`${d.id}: must depend on ${abc.map((x) => x.id).join(", ")}`);
        // the attempt's verifier gate: N.verify[.r<k>][.g<n>]h must be among the reviewers' dependencies
        const gate = abc[0].dependencies.find((dep) => new RegExp(`^${p.replace(".", "\\.")}\\.verify(\\.r${k})?(\\.g\\d+)?h$`).test(dep));
        if (!gate) err(`${abc[0].id}: must depend on the attempt's verifier gate ${p}.verify${k ? `.r${k}` : ""}[.g<n>]h`);
        else if (k > 0 && !new RegExp(`^${p}\\.verify\\.r${k}(\\.g\\d+)?h$`).test(gate)) err(`${abc[0].id}: attempt r${k} must have its own verifier ${p}.verify.r${k}`);
      }
      if (closes.length === 1 && !closes[0].dependencies.includes(newest)) err(`${closes[0].id}: must depend on the newest review attempt ${newest}`);
    }
  }
  if (expectedCount !== null && tasks.length !== Number(expectedCount)) err(`expanded count ${tasks.length} != EXPECTED_COUNT ${expectedCount}`);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.RALPH_ROOT ? resolve(process.env.RALPH_ROOT) : resolve(HERE, "..");
  let tasks, expected;
  try {
    tasks = JSON.parse(readFileSync(resolve(root, "ralph/tasks.json"), "utf8"));
    expected = readFileSync(resolve(root, "ralph/EXPECTED_COUNT"), "utf8").trim();
  } catch (e) { console.error(`validate-tasks: ${e.message}`); process.exit(1); }
  const errors = validate(tasks, { expectedCount: expected });
  let regen;
  try { regen = generate(root); } catch (e) { errors.push(`PRD §8 does not regenerate: ${e.message}`); }
  if (regen && regen.json !== readFileSync(resolve(root, "ralph/tasks.json"), "utf8")) errors.push("ralph/tasks.json is not byte-identical to the regeneration from PRD §8 (run node ralph/generate-tasks.mjs)");
  if (errors.length) { for (const e of errors) console.error(`validate-tasks: ${e}`); console.error(`validate-tasks: FAILED (${errors.length})`); process.exit(1); }
  const phases = [...new Set(tasks.map((t) => t.phase))];
  console.log(`validate-tasks: OK ${tasks.length} expanded tasks (EXPECTED_COUNT ${expected}), phases ${phases.join(",")}, acyclic, byte-identical to PRD §8`);
}
