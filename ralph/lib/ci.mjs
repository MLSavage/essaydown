// ci.mjs — the remote side of a CI gate (push ref, find run, wait, log, artifacts, delete ref).
// Real adapter uses git + gh on the host (Michael's login, never in a container).
// RALPH_CI_ADAPTER=fake reads scenarios from RALPH_CI_FAKE_DIR/<ref with / → _>.json (conformance suite).
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { RalphError, sh, ensureDir, appendLine } from "./util.mjs";

export function ciAdapter(ctx) {
  return process.env.RALPH_CI_ADAPTER === "fake" ? fakeAdapter(ctx) : realAdapter(ctx);
}

function realAdapter(ctx) {
  const gh = (args, opts = {}) => sh("gh", args, { cwd: ctx.root, ...opts });
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  return {
    pushRef(sha, ref) { sh("git", ["-C", ctx.root, "push", "origin", `${sha}:refs/heads/${ref}`]); },
    deleteRef(ref) { sh("git", ["-C", ctx.root, "push", "origin", "--delete", `refs/heads/${ref}`], { check: false }); },
    listRefs(prefix) { return sh("git", ["-C", ctx.root, "ls-remote", "--heads", "origin", `refs/heads/${prefix}*`]).stdout.split("\n").filter(Boolean).map((l) => l.split(/\s+/)[1].replace(/^refs\/heads\//, "")); },
    findRun(workflow, ref, sha, { timeoutMs = 300_000 } = {}) {
      const start = Date.now();
      for (;;) {
        const out = gh(["run", "list", "--workflow", workflow, "--branch", ref, "--json", "databaseId,url,headSha,status,conclusion", "--limit", "10"], { check: false }).stdout;
        const runs = out ? JSON.parse(out) : [];
        const run = runs.find((r) => r.headSha === sha);
        if (run) return { run_id: String(run.databaseId), url: run.url };
        if (Date.now() - start > timeoutMs) throw new RalphError(`no ${workflow} run for ${sha} on ${ref} after ${timeoutMs / 1000}s`);
        sleep(10_000);
      }
    },
    waitRun(runId) {
      const r = gh(["run", "watch", runId, "--exit-status"], { check: false });
      const view = JSON.parse(gh(["run", "view", runId, "--json", "conclusion,status,headSha,url,databaseId"]).stdout);
      return { conclusion: view.conclusion ?? (r.status === 0 ? "success" : "failure"), sha: view.headSha, url: view.url };
    },
    runInfo(runId) { const v = JSON.parse(gh(["run", "view", runId, "--json", "conclusion,status,headSha,url,databaseId"]).stdout); return { conclusion: v.conclusion, status: v.status, sha: v.headSha, url: v.url }; },
    fetchLog(runId, dest) { const r = gh(["run", "view", runId, "--log"], { check: false }); writeFileSync(dest, r.stdout || r.stderr); },
    downloadArtifact(runId, name, dest) { ensureDir(dest); gh(["run", "download", runId, "-n", name, "-D", dest]); },
  };
}

function fakeAdapter(ctx) {
  const dir = process.env.RALPH_CI_FAKE_DIR ?? resolve(ctx.evidence, "..", ".ci-fake");
  ensureDir(dir);
  const scenarioPath = (ref) => join(dir, `${ref.replace(/\//g, "_")}.json`);
  const remote = join(dir, "remote-refs.json");
  const refs = () => (existsSync(remote) ? JSON.parse(readFileSync(remote, "utf8")) : {});
  const saveRefs = (r) => writeFileSync(remote, JSON.stringify(r, null, 2));
  const runs = () => (existsSync(join(dir, "runs.json")) ? JSON.parse(readFileSync(join(dir, "runs.json"), "utf8")) : {});
  const saveRuns = (r) => writeFileSync(join(dir, "runs.json"), JSON.stringify(r, null, 2));
  return {
    pushRef(sha, ref) { const r = refs(); r[ref] = sha; saveRefs(r); appendLine(join(dir, "log"), `push ${ref} ${sha}`); },
    deleteRef(ref) { const r = refs(); delete r[ref]; saveRefs(r); appendLine(join(dir, "log"), `delete ${ref}`); },
    listRefs(prefix) { return Object.keys(refs()).filter((r) => r.startsWith(prefix)); },
    findRun(workflow, ref, sha) {
      const p = scenarioPath(ref);
      const sc = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { conclusion: "success" };
      const all = runs();
      const id = sc.run_id ?? String(1000 + Object.keys(all).length + 1);
      all[id] = { ...sc, run_id: id, sha, ref, workflow, started: true };
      saveRuns(all);
      appendLine(join(dir, "log"), `run ${id} ${workflow} ${ref} ${sha}`);
      return { run_id: id, url: `fake://runs/${id}` };
    },
    waitRun(runId) { const r = runs()[runId]; if (!r) throw new RalphError(`fake run ${runId} unknown`); return { conclusion: r.conclusion ?? "success", sha: r.sha, url: `fake://runs/${runId}` }; },
    runInfo(runId) { const r = runs()[runId]; if (!r) throw new RalphError(`fake run ${runId} unknown`); return { conclusion: r.conclusion ?? "success", status: "completed", sha: r.sha, url: `fake://runs/${runId}` }; },
    fetchLog(runId, dest) { const r = runs()[runId]; writeFileSync(dest, `fake workflow log for run ${runId}\nconclusion: ${r.conclusion ?? "success"}\n${(r.log ?? "")}`); },
    downloadArtifact(runId, name, dest) {
      const r = runs()[runId];
      // no `artifacts` key at all → every named artifact exists (one fake file); a present map without the name → missing
      const files = r.artifacts === undefined ? { [`${name}.txt`]: `fake artifact ${name} of run ${runId}\n` } : r.artifacts[name];
      if (!files) throw new RalphError(`fake run ${runId} has no artifact ${name}`);
      ensureDir(dest);
      for (const [f, content] of Object.entries(files)) writeFileSync(join(dest, f), content);
    },
    _dir: dir,
    _runCount() { return Object.keys(runs()).length; },
  };
}

export function listArtifactDirs(attemptDir) {
  return existsSync(attemptDir) ? readdirSync(attemptDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
}
