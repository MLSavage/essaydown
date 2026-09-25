// summary.test.mjs — RUNNER-SPEC §10: summary.md carries the last 5 journal entries one line each
// (id, time, status, a short head), not in full. A fixture-repository scenario (a real `run` that
// integrates, which regenerates the summary) plus direct cases for the line format.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixture, phaseTasks, ralph, control, state, cleanup } from "./harness.mjs";
import { git } from "../lib/util.mjs";
import { journalHead, recentJournal, HEAD_CHARS } from "../lib/summary.mjs";

const MARK = "NARRATIVE-BODY-MARKER";
const long = (id, iso, status) => `- [${id}] ${iso} Task: ${"A long task description that runs on and on ".repeat(6)}. Status: ${status}. Files: x.ts. Notes: ${MARK} ${"detail ".repeat(400)}`;
const section = (md) => md.split("## Last 5 journal entries")[1].split("\n## ")[0].split("\n").filter((l) => l.startsWith("- "));

test("summary.md after an integration: the last 5 journal entries, one line each (id, time, status, head), never the full entry (§10)", () => {
  const f = makeFixture({ phases: [{ n: "0", tasks: phaseTasks("0", { next: "1" }) }] });
  try {
    git(f.root, ["checkout", "-q", "phase/0"]); // the summary reads the checkout, refreshed when it is on the moved branch
    const journal = ["# journal", "", long("0.0", "2026-09-01T00:00:00Z", "Complete"), long("9.1", "2026-09-01T00:01:00Z", "In progress"), long("9.2", "2026-09-01T00:02:00Z", "Blocked"),
      "- [9.3] 2026-09-01T00:03:00Z Task: short. Status: Partial.", long("9.4", "2026-09-01T00:04:00Z", "Complete"), long("9.5", "2026-09-01T00:05:00Z", "Debugging"),
      long("0.1", "2026-09-01T00:06:00Z", "Complete"), ""].join("\n");
    control(f.root, "0.1", { files: { "docs/progress/journal-main.md": journal } });
    ralph(f.root, ["run", "--phase", "0"]);
    assert.equal(state(f.root)["0.1"].status, "passed", "0.1 integrated, so the summary was regenerated");
    const md = readFileSync(join(f.root, ".evidence/state/summary.md"), "utf8");
    const lines = section(md);
    const all = readFileSync(join(f.root, "docs/progress/journal-main.md"), "utf8").split("\n").filter((l) => l.startsWith("- ["));
    assert.equal(lines.length, Math.min(5, all.length));
    assert.deepEqual(lines.map((l) => l.match(/^- \[([^\]]+)\]/)[1]), all.slice(-5).map((l) => l.match(/^- \[([^\]]+)\]/)[1]), "the last five, in journal order");
    for (const l of lines) {
      assert.match(l, /^- \[[^\]]+\] \S+ [^—]+ — \S/, `one-line shape: ${l.slice(0, 80)}`);
      assert.ok(l.length <= HEAD_CHARS + 80, `bounded: ${l.length}`);
    }
    assert.ok(!md.includes(MARK), "no narrative body reaches summary.md");
    assert.ok(lines.some((l) => / Debugging — /.test(l)) && lines.some((l) => / Partial — short\.$/.test(l)), "status and head are both present");
    assert.ok(lines.some((l) => l.endsWith("…")), "a long head is cut with an ellipsis");
  } finally { cleanup(f.root); }
});

test("journalHead: status is the entry's first Status value; head is the Task text cut at HEAD_CHARS; an off-template line is cut unparsed", () => {
  assert.equal(journalHead("- [2.3] 2026-09-25T10:00:00Z Task: Add the outline pane. Status: In progress."), "- [2.3] 2026-09-25T10:00:00Z In progress — Add the outline pane.");
  assert.equal(journalHead("- [2.3] 2026-09-25T10:00:00Z Task: T. Status: Complete. Notes: later Status: Blocked."), "- [2.3] 2026-09-25T10:00:00Z Complete — T.");
  assert.equal(journalHead("- [2.3] 2026-09-25T10:00:00Z Task: no status here"), "- [2.3] 2026-09-25T10:00:00Z no status — no status here");
  const h = journalHead(`- [2.3] 2026-09-25T10:00:00Z Task: ${"x".repeat(500)}. Status: Complete.`);
  assert.equal(h, `- [2.3] 2026-09-25T10:00:00Z Complete — ${"x".repeat(HEAD_CHARS - 1)}…`);
  assert.equal(journalHead(`- [${"y".repeat(300)}`).length, HEAD_CHARS);
  assert.deepEqual(recentJournal("# j\n\nprose line\n- [a] t Task: 1. Status: Complete.\n    indented continuation\n", 5), ["- [a] t Complete — 1."]);
});
