#!/usr/bin/env node
// generate-tasks.mjs — PRD §8 → immutable ralph/tasks.json (RUNNER-SPEC §1, §3). Plain Node, no deps.
//   node ralph/generate-tasks.mjs            write ralph/tasks.json + ralph/EXPECTED_COUNT
//   node ralph/generate-tasks.mjs --check    regenerate and assert byte-identity with the committed files (sync-state, §6)
//   node ralph/generate-tasks.mjs --stdout   print the expanded JSON
// Expansions: `execution` default (loop), targetBranch derivation, review-set macro (<id>.r0a/b/c/d),
// needsCI gate expansion (<id>h), close metadata (sourceBranches, targetBranch main).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const EXECUTIONS = ["bootstrap", "loop", "loop-external", "reviewer", "interactive-principal", "replan", "human", "runner"];
export const REVIEWERS = [
  { suffix: "a", reviewer: "claude", model: "claude-opus" },
  { suffix: "b", reviewer: "sol", model: "sol" },
  { suffix: "c", reviewer: "grok", model: "grok" },
];

/** Phase key of a task id: "0".."6" or "5" for post.*; close/verify ids keep their prefix. */
export function phaseOf(id) {
  const p = String(id).split(".")[0];
  return p === "post" ? "5" : p;
}

export function deriveTargetBranch(id) {
  return `phase/${phaseOf(id)}`;
}

/** Extract every ```json array under "## 8." of the PRD, in document order. */
export function extractRawTasks(prdText) {
  const lines = prdText.split("\n");
  const start = lines.findIndex((l) => /^## 8\. /.test(l));
  if (start < 0) throw new Error("PRD has no '## 8.' section");
  let end = lines.findIndex((l, i) => i > start && /^## \d+\. /.test(l));
  if (end < 0) end = lines.length;
  const section = lines.slice(start, end);
  const tasks = [];
  const phases = [];
  let phaseHeading = null;
  let buf = null;
  for (const line of section) {
    const h = /^### Phase (\S+) /.exec(line);
    if (h) phaseHeading = h[1];
    if (buf === null) {
      if (/^```json\s*$/.test(line)) buf = [];
      continue;
    }
    if (/^```\s*$/.test(line)) {
      let arr;
      try {
        arr = JSON.parse(buf.join("\n"));
      } catch (e) {
        throw new Error(`PRD §8 phase ${phaseHeading}: JSON block does not parse: ${e.message}`);
      }
      if (!Array.isArray(arr)) throw new Error(`PRD §8 phase ${phaseHeading}: JSON block is not an array`);
      phases.push({ phase: phaseHeading, count: arr.length });
      tasks.push(...arr);
      buf = null;
      continue;
    }
    buf.push(line);
  }
  if (buf !== null) throw new Error("PRD §8: unterminated ```json block");
  return { tasks, phases };
}

/** Expand raw PRD tasks into the physical graph. Pure. */
export function expand(raw) {
  const out = [];
  const rename = new Map(); // raw id → id that dependents must use instead
  for (const t of raw) {
    const task = { ...t };
    task.phase = task.phase !== undefined ? String(task.phase) : phaseOf(task.id);
    if (!task.execution) task.execution = task.model === "review-set" ? "review-set" : "loop";
    if (!task.dependencies) task.dependencies = [];
    if (/\.close$/.test(task.id)) {
      const n = task.id.replace(/\.close$/, "");
      task.execution = task.execution === "loop" ? "runner" : task.execution;
      if (!task.sourceBranches) task.sourceBranches = [`phase/${n}`];
      if (!task.targetBranch) task.targetBranch = "main";
    } else if (!task.targetBranch) {
      task.targetBranch = deriveTargetBranch(task.id);
    }

    if (task.model === "review-set") {
      // Macro → <id>.r0a/b/c (reviewer) + <id>.r0d (interactive-principal reconciliation).
      const base = task.id;
      const common = { phase: task.phase, targetBranch: task.targetBranch, reviewSet: base, reviewAttempt: "r0", reviewSetDescription: task.description };
      const abc = [];
      for (const r of REVIEWERS) {
        const id = `${base}.r0${r.suffix}`;
        abc.push(id);
        out.push({
          id, model: r.model, execution: "reviewer", reviewer: r.reviewer,
          description: `Review attempt r0, ${r.reviewer} reviewer, for review set ${base} (phase ${task.phase}). ${task.description}`,
          acceptance: `/logs/reviews/${task.phase}/r0/${r.reviewer}/report.md and status.json exist and pass the docs/reviews/TEMPLATE.md check (canonical review-set acceptance, PRD §8 conventions).`,
          dependencies: task.dependencies.slice(), ...common,
        });
      }
      out.push({
        id: `${base}.r0d`, model: "opus", execution: "interactive-principal",
        description: `Reconciliation of review attempt r0 for review set ${base} (phase ${task.phase}): copy the three reports to docs/reviews/phase-${task.phase}-r0-{claude,sol,grok}.md, append accepted human records by recordTarget into DECISIONS.md, write DECISIONS.md#review-${task.phase}-r0 with verdict PASS|FAIL, class-level lessons, regenerated docs/progress.md; on FAIL append fix tasks, ${task.phase}.verify.r1 and ${base}.r1a/b/c/d in the same planning commit (RUNNER-SPEC §5.4).`,
        acceptance: task.acceptance,
        dependencies: abc, ...common,
      });
      rename.set(base, `${base}.r0d`);
      continue;
    }

    out.push(task);
    if (task.needsCI) {
      const gate = {
        id: `${task.id}h`, model: task.model, execution: "human", blockedOnHuman: true, gateKind: "ci",
        outcomes: { ACCEPT: "continue", "GATE-FAILED": "plan-gate" }, recordPolicy: "evidence-only",
        gateFor: task.id, ci: task.ci, phase: task.phase, targetBranch: task.targetBranch,
        description: `CI gate for ${task.id}: scripts/gate.sh ${task.id}h pushes integrated_sha of ${task.id} to ${task.ci?.refTemplate ?? "<refTemplate>"}, writes run.json, waits for ${task.ci?.workflow ?? "<workflow>"}, fetches ${JSON.stringify(task.ci?.artifactNames ?? [])} into /logs/ci/${task.id}/a<n>/, asserts ciAcceptance, writes accepted.json on ACCEPT (RUNNER-SPEC §2, §3).`,
        acceptance: task.ciAcceptance ?? "",
        dependencies: [task.id],
      };
      out.push(gate);
      rename.set(task.id, gate.id);
    }
  }
  // Rewrite dependents of macros and needsCI producers.
  for (const t of out) {
    if (t.gateFor && t.dependencies.length === 1 && t.dependencies[0] === t.gateFor) continue; // the gate itself depends on the raw producer
    t.dependencies = t.dependencies.map((d) => rename.get(d) ?? d);
    if (t.replanTarget && rename.has(t.replanTarget)) t.replanTarget = rename.get(t.replanTarget);
  }
  return out;
}

export function serialize(expanded) {
  return JSON.stringify(expanded, null, 1) + "\n";
}

export function generate(root = resolve(HERE, "..")) {
  const prd = readFileSync(resolve(root, "docs/PRD.md"), "utf8");
  const { tasks: raw, phases } = extractRawTasks(prd);
  const expanded = expand(raw);
  return { raw, phases, expanded, json: serialize(expanded), count: expanded.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.env.RALPH_ROOT ? resolve(process.env.RALPH_ROOT) : resolve(HERE, "..");
  const mode = process.argv[2] ?? "--write";
  const g = generate(root);
  const tasksPath = resolve(root, "ralph/tasks.json");
  const countPath = resolve(root, "ralph/EXPECTED_COUNT");
  const raw = g.raw.length, sets = g.raw.filter((t) => t.model === "review-set").length * 3, gates = g.raw.filter((t) => t.needsCI).length;
  const summary = `generate-tasks: ${raw} raw + ${sets} review-set + ${gates} CI gates = ${g.count} expanded (${g.phases.map((p) => `${p.phase}:${p.count}`).join(" ")})`;
  if (mode === "--stdout") {
    process.stdout.write(g.json);
  } else if (mode === "--check") {
    const cur = existsSync(tasksPath) ? readFileSync(tasksPath, "utf8") : null;
    const curCount = existsSync(countPath) ? readFileSync(countPath, "utf8").trim() : null;
    if (cur !== g.json) { console.error(`generate-tasks: ralph/tasks.json is NOT byte-identical to the regeneration from PRD §8`); process.exit(1); }
    if (curCount !== String(g.count)) { console.error(`generate-tasks: ralph/EXPECTED_COUNT (${curCount}) != ${g.count}`); process.exit(1); }
    console.log(`${summary}; byte-identical`);
  } else {
    writeFileSync(tasksPath, g.json);
    writeFileSync(countPath, `${g.count}\n`);
    console.log(summary);
  }
}
