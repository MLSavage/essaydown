#!/usr/bin/env node
// bootstrap-state.mjs — called by ralph/bootstrap.sh after the task(0.0) commit exists (RUNNER-SPEC §2 bootstrap row):
// initialise .evidence/state/ with 0.0 passed, the Phase 0 record from the preflight main head, the external-repo
// state (§7), and the first summary.md.
//   node ralph/lib/bootstrap-state.mjs <bootstrap-commit-sha> <external-repo-id> <external-repo-path> <external-target-ref>
import { resolve } from "node:path";
import { Ctx, initState } from "./state.mjs";
import { readJson, revParse, refOid, writeJsonAtomic, now, RalphError, git } from "./util.mjs";
import { writeSummary } from "./summary.mjs";

const [sha, extId, extPath, extRef] = process.argv.slice(2);
if (!sha) { console.error("usage: bootstrap-state.mjs <sha> <externalRepoId> <externalRepoPath> <externalTargetRef>"); process.exit(2); }
const ctx = new Ctx(process.env.RALPH_ROOT ?? process.cwd());
if (ctx.initialised) throw new RalphError(`${ctx.stateDir} already initialised; reversal is rm -rf .evidence/state`);
const spec = readJson(resolve(ctx.root, "ralph/tasks.json"));
const mainSha = revParse(ctx.root, "main");
if (!mainSha) throw new RalphError("main missing");
if (revParse(ctx.root, "phase/0") !== sha) throw new RalphError(`phase/0 head != bootstrap commit ${sha}`);
initState(ctx, { spec, phaseRecords: { "0": { phase: "0", branch: "phase/0", base_main_sha: mainSha, created_by: "bootstrap", created_at: now() } }, passed: { "0.0": sha } });
if (extId) {
  const repo = resolve(ctx.root, extPath.replace(/^\/work\//, ""));
  const base = refOid(repo, extRef);
  if (!base) throw new RalphError(`${extRef} missing in ${repo}`);
  writeJsonAtomic(resolve(ctx.externalDir(extId), "state.json"), { target_ref: extRef, base_sha: base, initialised_at: now(), initialised_by: "bootstrap" });
}
writeSummary(ctx);
console.log(`bootstrap-state: ${spec.length} tasks, 0.0 passed at ${sha.slice(0, 7)}, phase 0 base_main_sha ${mainSha.slice(0, 7)}${extId ? `, external ${extId} at ${refOid(resolve(ctx.root, extPath.replace(/^\/work\//, "")), extRef).slice(0, 7)}` : ""}`);
