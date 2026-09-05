// summary.mjs — /logs/state/summary.md (RUNNER-SPEC §10) and `ralph.sh status`.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeAtomic, now } from "./util.mjs";

export function phaseSummary(ctx) {
  const spec = ctx.spec(), s = ctx.state();
  const phases = [...new Set(spec.map((t) => t.phase))];
  return phases.map((p) => {
    const ids = spec.filter((t) => t.phase === p).map((t) => t.id);
    const counts = {};
    for (const id of ids) counts[s[id]?.status ?? "missing"] = (counts[s[id]?.status ?? "missing"] ?? 0) + 1;
    return { phase: p, total: ids.length, counts };
  });
}

export function currentLine(ctx) {
  const spec = ctx.spec(), s = ctx.state();
  const active = spec.filter((t) => ["running", "human-pending", "principal-pending"].includes(s[t.id]?.status));
  const passed = spec.filter((t) => s[t.id]?.status === "passed");
  const last = passed.length ? passed[passed.length - 1].id : "none";
  const phase = active[0]?.phase ?? (spec.find((t) => s[t.id]?.status === "pending")?.phase ?? "done");
  const gates = spec.filter((t) => t.execution === "human" && s[t.id]?.status === "human-pending").map((t) => t.id);
  const plans = ctx.plans().filter((p) => ["pending", "running", "blocked", "integration-failed"].includes(p.status)).map((p) => `${p.id}:${p.status}`);
  const blocked = spec.filter((t) => ["blocked", "integration-failed"].includes(s[t.id]?.status)).map((t) => `${t.id}:${s[t.id].status}`);
  const act = active.map((t) => `${t.id} ${s[t.id].status}${s[t.id].attempts ? " attempt " + s[t.id].attempts : ""}`).join(", ") || "idle";
  return `Phase ${phase}, ${act}; last passed ${last}; gates open: ${gates.join(", ") || "none"}; plan requests: ${plans.join(", ") || "none"}; blocked: ${blocked.join(", ") || "none"}`;
}

export function writeSummary(ctx) {
  const line = currentLine(ctx);
  const journal = resolve(ctx.root, "docs/progress/journal-main.md");
  const entries = existsSync(journal) ? readFileSync(journal, "utf8").split("\n").filter((l) => /^- \[/.test(l)).slice(-5) : [];
  const gates = ctx.spec().filter((t) => t.execution === "human" && ctx.state()[t.id]?.status === "human-pending").map((t) => `- ${t.id} (${t.gateKind}): scripts/gate.sh ${t.id}`);
  const plans = ctx.plans().filter((p) => p.status !== "resolved" && p.status !== "abandoned").map((p) => `- ${p.id} ${p.status} (${p.trigger_outcome} at ${p.trigger_attempt})`);
  const md = `# summary.md — generated ${now()} (do not edit; RUNNER-SPEC §10)\n\n## Current state\n\n${line}\n\n## Last 5 journal entries\n\n${entries.join("\n") || "(none)"}\n\n## Open human gates\n\n${gates.join("\n") || "none"}\n\n## Plan requests\n\n${plans.join("\n") || "none"}\n`;
  writeAtomic(ctx.paths.summary, md);
  return md;
}

export function status(ctx) {
  const lines = [currentLine(ctx), ""];
  for (const p of phaseSummary(ctx)) lines.push(`phase ${p.phase}: ${p.total} tasks — ${Object.entries(p.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return lines.join("\n");
}
