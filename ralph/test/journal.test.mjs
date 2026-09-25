// journal.test.mjs — ralph/journal.mjs (docs/proposals/001 §4 item 2, RUNNER-SPEC §10) against a
// disposable git repository: the stub always appends (one "- [<id>] " line per attempt, which is what
// the stop-check's journalCount reads), and complete edits only this attempt's own line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { journalCount } from "../lib/integrate.mjs";
import { firstSentence, NOTES_CAP } from "../journal.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "journal.mjs");
const J = "docs/progress/journal-main.md";
const TASKS = [
  { id: "2.3", description: "Add the outline pane (PRD §5.2, v1.2 rules). Then wire it to the store." },
  { id: "2.30", description: "A task whose id shares a prefix with 2.3! Second sentence." },
];
const HEADER = "# journal-main.md\n\n- [1.9] 2026-09-01T00:00:00Z Task: Old. Status: Complete. Notes: untouched";

function repo(journal = HEADER) {
  const root = mkdtempSync(join(tmpdir(), "ralph-journal-"));
  const g = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.invalid");
  g("config", "user.name", "t");
  mkdirSync(join(root, "ralph"), { recursive: true });
  mkdirSync(join(root, "docs/progress"), { recursive: true });
  writeFileSync(join(root, "ralph/tasks.json"), JSON.stringify(TASKS));
  writeFileSync(join(root, J), journal);
  writeFileSync(join(root, "other.txt"), "x\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return { root, g, read: () => readFileSync(join(root, J), "utf8") };
}
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8" });
const DONE_FLAGS = ["--status", "Complete", "--files", "a.ts, b.ts", "--tests", "lint pass; test 10 passed", "--guard", "empty input => a.test.ts > empty", "--guard", "astral => a.test.ts > astral", "--attempt", "2", "--tool-calls", "31", "--notes", "Did the thing.\nNext: nothing."];

test("stub: a journal without a trailing newline gains one before the stub; the stub is committed alone", () => {
  const { root, g, read } = repo(HEADER); // HEADER ends without "\n"
  try {
    writeFileSync(join(root, "other.txt"), "dirty\n");
    const r = run(root, "stub", "2.3");
    assert.equal(r.status, 0, r.stderr);
    const lines = read().split("\n");
    assert.equal(lines[2], "- [1.9] 2026-09-01T00:00:00Z Task: Old. Status: Complete. Notes: untouched", "the old last line is intact, not joined");
    assert.match(lines[3], /^- \[2\.3\] \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ Task: Add the outline pane \(PRD §5\.2, v1\.2 rules\)\. Status: In progress\.$/);
    assert.equal(lines[4], "", "the file ends with a newline");
    assert.equal(g("log", "-1", "--format=%s").stdout.trim(), "wip(2.3): journal stub");
    assert.deepEqual(g("show", "--name-only", "--format=", "HEAD").stdout.trim().split("\n"), [J]);
    assert.match(g("status", "--porcelain").stdout, /other\.txt/, "other dirty files are not swept into the stub commit");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stub: a journal that already ends in a newline gets no blank line", () => {
  const { root, read } = repo(HEADER + "\n");
  try {
    assert.equal(run(root, "stub", "2.3", "--no-commit").status, 0);
    assert.equal(read().split("\n").filter((l) => l === "").length, 2, "header blank + final newline only");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two attempts → two lines: the second stub appends even when the first is still open, and journalCount rises each time", () => {
  const { root, read } = repo();
  try {
    assert.equal(journalCount(root, "2.3"), 0);
    assert.equal(run(root, "stub", "2.3").status, 0);
    assert.equal(journalCount(root, "2.3"), 1);
    assert.equal(run(root, "stub", "2.3").status, 0);
    assert.equal(journalCount(root, "2.3"), 2);
    assert.equal(read().split("\n").filter((l) => l.endsWith("Status: In progress.")).length, 2);
    assert.equal(journalCount(root, "2.30"), 0, "a prefix-sharing id is not counted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("complete edits only the last own line: earlier attempts, other tasks and the header are byte-identical", () => {
  const { root, g, read } = repo();
  try {
    run(root, "stub", "2.3");
    run(root, "stub", "2.30");
    run(root, "stub", "2.3");
    const before = read().split("\n");
    const r = run(root, "complete", "2.3", ...DONE_FLAGS);
    assert.equal(r.status, 0, r.stderr);
    const after = read().split("\n");
    assert.equal(after.length, before.length, "no line added or removed");
    const changed = after.map((l, i) => (l === before[i] ? null : i)).filter((i) => i !== null);
    assert.deepEqual(changed, [before.length - 2], "only the last [2.3] line changed");
    const line = after[before.length - 2];
    assert.ok(line.startsWith(before[before.length - 2].slice(0, -"Status: In progress.".length)), "prefix, ISO and Task text kept");
    assert.match(line, /^- \[2\.3\] /, "the stop-check prefix is kept");
    assert.match(line, / Status: Complete\. Files: a\.ts, b\.ts\. Tests: lint pass; test 10 passed\. Guards: empty input => a\.test\.ts > empty; astral => a\.test\.ts > astral\. Attempt: 2\. Iterations used: 2\. First attempt passed: n\. Tool calls: 31\. Notes: Did the thing\. Next: nothing\.$/);
    assert.equal(journalCount(root, "2.3"), 2, "complete never changes the count");
    assert.equal(g("log", "-1", "--format=%s").stdout.trim(), "wip(2.3): journal complete");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("complete refuses when the last own line is not an open stub (an earlier attempt's line is never completed), when there is none, and on a narrative over the cap", () => {
  const { root, read } = repo();
  try {
    assert.equal(run(root, "complete", "2.3", ...DONE_FLAGS).status, 1, "no own line");
    run(root, "stub", "2.3");
    assert.equal(run(root, "complete", "2.3", ...DONE_FLAGS).status, 0);
    const snapshot = read();
    const again = run(root, "complete", "2.3", ...DONE_FLAGS);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /not an open stub/);
    run(root, "stub", "2.3");
    const long = DONE_FLAGS.slice(0, -1).concat("x".repeat(NOTES_CAP + 1));
    const r = run(root, "complete", "2.3", ...long);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cap is 800/);
    assert.ok(read().startsWith(snapshot), "a refused complete writes nothing");
    assert.equal(run(root, "complete", "2.3", "--status", "Done", ...DONE_FLAGS.slice(2)).status, 1, "status outside the template");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("complete --check reads the summary lines of a saved scripts/check output", () => {
  const { root, read } = repo();
  try {
    run(root, "stub", "2.3");
    writeFileSync(join(root, "check.out"), "noise\ncheck: lint pass\ncheck: test pass — Tests 12 passed (12)\ncheck: cargo pass — 3 passed; 0 failed; 0 ignored\ncheck: all green\n");
    const flags = DONE_FLAGS.filter((_, i) => i !== 4 && i !== 5).concat("--check", "check.out", "--no-commit");
    assert.equal(run(root, "complete", "2.3", ...flags).status, 0);
    assert.match(read(), /Tests: lint pass; test pass — Tests 12 passed \(12\); cargo pass — 3 passed; 0 failed; 0 ignored; all green\. /);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("firstSentence: stops at the first terminator followed by space or the end, not inside ids or section numbers", () => {
  assert.equal(firstSentence("Phase 1 verification (RUNNER-SPEC §3, §5.5): run 1.verify.r10 now. More."), "Phase 1 verification (RUNNER-SPEC §3, §5.5): run 1.verify.r10 now");
  assert.equal(firstSentence("No terminator at all"), "No terminator at all");
  assert.equal(firstSentence("Ends with a period."), "Ends with a period");
});
