#!/usr/bin/env node
// cli.mjs — dispatcher behind ralph/ralph.sh and scripts/gate.sh (RUNNER-SPEC §11 entry points, byte for byte).
import { resolve } from "node:path";
import { RalphError } from "./util.mjs";
import { Ctx } from "./state.mjs";
import * as runMod from "./run.mjs";
import { run, dryRun } from "./run.mjs";
import { closePhase } from "./close.mjs";
import { doctor, adminMarkIntegrated, adminRetry, adminResolveRequest, retry, resume, resolveConflict, abandon, planStart, planRetry, planAbandon, syncStateCmd, registerRun } from "./doctor.mjs";
import { runGate, rerunGate, abandonAttempt, gc } from "./gate.mjs";
import { status } from "./summary.mjs";

registerRun(runMod);

const USAGE = `ralph.sh run [--phase N] [--dry-run] | retry <id> | resume <id> | resolve-conflict <id> | abandon <id> --reason <text>
         | plan <request-id> | plan-retry <request-id> | plan-abandon <request-id> --reason <text> | rerun <gate-id>
         | close <N> | sync-state | status | doctor
         | admin mark-integrated <id> | admin retry <id> | admin resolve-request <request-id> --state <s>
gate.sh  <id> [--resume a<n>] [--outcome ACCEPT|REJECT] [--payload k=v]... [--note text | --file path]
         | rerun <gate-id> | abandon <id> a<n> --reason <text> | gc`;

function opt(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function has(args, name) { return args.includes(name); }
function payloadOf(args) {
  const p = {};
  for (let i = 0; i < args.length; i++) if (args[i] === "--payload") { const [k, ...v] = (args[i + 1] ?? "").split("="); if (k) { const raw = v.join("="); try { p[k] = JSON.parse(raw); } catch { p[k] = raw; } } }
  return p;
}

export function main(argv) {
  const root = resolve(process.env.RALPH_ROOT ?? process.cwd());
  const ctx = new Ctx(root);
  const [tool, cmd, ...args] = argv; // tool = ralph | gate
  const out = (o) => { if (o !== undefined && typeof o === "object") console.log(JSON.stringify(o, null, 2)); };
  if (tool === "gate") {
    switch (cmd) {
      case "rerun": out(rerunGate(ctx, args[0])); return 0;
      case "abandon": out(abandonAttempt(ctx, args[0], args[1], opt(args, "--reason"))); return 0;
      case "gc": out(gc(ctx)); return 0;
      case undefined: case "-h": case "--help": console.log(USAGE); return 0;
      default: out(runGate(ctx, cmd, { resume: opt(args, "--resume") ?? null, outcome: opt(args, "--outcome"), payload: payloadOf(args), note: opt(args, "--note") ?? "", file: opt(args, "--file") ?? null })); return 0;
    }
  }
  switch (cmd) {
    case "run": { const phase = opt(args, "--phase") ?? null; if (has(args, "--dry-run")) { console.log(dryRun(ctx, phase)); return 0; } const r = run(ctx, { phase }); return r.signal && r.signal !== "COMPLETE" ? 3 : 0; }
    case "retry": out(retry(ctx, args[0])); return 0;
    case "resume": out(resume(ctx, args[0])); return 0;
    case "resolve-conflict": out(resolveConflict(ctx, args[0])); return 0;
    case "abandon": out(abandon(ctx, args[0], opt(args, "--reason"))); return 0;
    case "plan": out(planStart(ctx, args[0])); return 0;
    case "plan-retry": out(planRetry(ctx, args[0])); return 0;
    case "plan-abandon": out(planAbandon(ctx, args[0], opt(args, "--reason"))); return 0;
    case "rerun": out(rerunGate(ctx, args[0])); return 0;
    case "close": { const r = closePhase(ctx, args[0]); return r.signal ? 3 : 0; }
    case "sync-state": out(syncStateCmd(ctx, opt(args, "--ref") ?? null)); return 0;
    case "status": console.log(status(ctx)); return 0;
    case "doctor": { const f = doctor(ctx); for (const x of f) console.log(x.line); if (f.length) { console.log(`DOCTOR ${f.length} findings`); return 3; } console.log("doctor: clean"); return 0; }
    case "admin": {
      const [sub, id] = args;
      if (sub === "mark-integrated") { out(adminMarkIntegrated(ctx, id)); return 0; }
      if (sub === "retry") { out(adminRetry(ctx, id)); return 0; }
      if (sub === "resolve-request") { out(adminResolveRequest(ctx, id, opt(args, "--state"))); return 0; }
      throw new RalphError(`unknown admin command ${sub}\n${USAGE}`);
    }
    case undefined: case "-h": case "--help": console.log(USAGE); return 0;
    default: throw new RalphError(`unknown command ${cmd}\n${USAGE}`);
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  if (e instanceof RalphError) { console.error(`ralph: ${e.message}`); process.exit(e.exit ?? 1); }
  throw e;
}
