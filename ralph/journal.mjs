#!/usr/bin/env node
// ralph/journal.mjs — the journal helper a task agent runs inside its own worktree (docs/proposals/001 §4
// item 2; RUNNER-SPEC §10). Standalone: it reads only the worktree (ralph/tasks.json and
// docs/progress/journal-main.md) and git, never runner state, so it works in the container.
//
//   node ralph/journal.mjs stub <id>
//       Appends "- [<id>] <ISO> Task: <first sentence of the description>. Status: In progress." and
//       commits it alone as "wip(<id>): journal stub". It ALWAYS appends: a stub left by an earlier
//       attempt is never reused, because the stop-check counts one new "- [<id>] " line per attempt.
//
//   node ralph/journal.mjs complete <id> --status Complete|Partial|Debugging|Blocked --files <text>
//       (--tests <text> | --check <file saved from scripts/check>) [--guard "<guard> => <test>"]...
//       --attempt <n> [--iterations <n>] [--first-attempt y|n] --tool-calls <n> --notes <text>
//       Completes, in place, the LAST "- [<id>] " line, which must still be an open stub (this attempt's
//       own); every other line is left byte-identical. Notes are capped at NOTES_CAP characters.
//       Commits the journal alone as "wip(<id>): journal complete".
//
// Both take --no-commit (write only). Exit 0 on success, 1 on refusal or failure, 2 on usage.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const JOURNAL = "docs/progress/journal-main.md";
export const NOTES_CAP = 800;
export const STATUSES = ["Complete", "Partial", "Debugging", "Blocked"];
const STUB_END = "Status: In progress.";

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();
const dotless = (s) => oneLine(s).replace(/[.]+$/, "");
export const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
export const ownLine = (id) => new RegExp(`^- \\[${reEsc(id)}\\] `);

/** First sentence of a description: up to the first . ! or ? followed by whitespace or the end. */
export function firstSentence(description) {
  const d = oneLine(description);
  const m = d.match(/^(.*?[.!?])(?=\s|$)/);
  return dotless(m ? m[1] : d);
}

export function taskDescription(root, id) {
  const p = join(root, "ralph/tasks.json");
  if (!existsSync(p)) throw new Error(`no ralph/tasks.json under ${root}`);
  const t = JSON.parse(readFileSync(p, "utf8")).find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} is not in ralph/tasks.json`);
  return t.description;
}

export function stubLine(id, description, iso = isoNow()) {
  return `- [${id}] ${iso} Task: ${firstSentence(description)}. ${STUB_END}`;
}

/** Appends a stub line, adding a newline first when the file's last byte is not one. Returns the line. */
export function appendStub(root, id, iso = isoNow()) {
  const line = stubLine(id, taskDescription(root, id), iso);
  const p = join(root, JOURNAL);
  mkdirSync(dirname(p), { recursive: true });
  const cur = existsSync(p) ? readFileSync(p) : Buffer.alloc(0);
  const sep = cur.length && cur[cur.length - 1] !== 0x0a ? "\n" : "";
  appendFileSync(p, `${sep}${line}\n`);
  return line;
}

/** The structured tail that replaces "Status: In progress." (PROMPT.md's entry template). */
export function completion(f) {
  if (!STATUSES.includes(f.status)) throw new Error(`--status must be one of ${STATUSES.join("|")}`);
  for (const k of ["files", "attempt", "toolCalls", "notes"]) if (f[k] === undefined || oneLine(f[k]) === "") throw new Error(`--${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} is required`);
  if (!f.tests || !oneLine(f.tests)) throw new Error("--tests or --check is required");
  for (const k of ["attempt", "toolCalls", "iterations"]) if (f[k] !== undefined && !/^\d+$/.test(String(f[k]))) throw new Error(`--${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} must be a whole number`);
  const notes = oneLine(f.notes);
  if (notes.length > NOTES_CAP) throw new Error(`--notes is ${notes.length} characters; the cap is ${NOTES_CAP} (put detail in docs/lessons.md or the commit body)`);
  const first = f.firstAttempt ?? (String(f.attempt) === "1" && f.status === "Complete" ? "y" : "n");
  if (!["y", "n"].includes(first)) throw new Error("--first-attempt must be y or n");
  const guards = (f.guards ?? []).map(oneLine).filter(Boolean);
  return [
    `Status: ${f.status}.`,
    `Files: ${dotless(f.files)}.`,
    `Tests: ${dotless(f.tests)}.`,
    `Guards: ${guards.length ? guards.join("; ") : "none"}.`,
    `Attempt: ${f.attempt}.`,
    `Iterations used: ${f.iterations ?? f.attempt}.`,
    `First attempt passed: ${first}.`,
    `Tool calls: ${f.toolCalls}.`,
    `Notes: ${notes}`,
  ].join(" ");
}

/** Completes the last own line in place; refuses unless it is an open stub. Returns the new line. */
export function completeLast(root, id, fields) {
  const p = join(root, JOURNAL);
  if (!existsSync(p)) throw new Error(`${JOURNAL} does not exist; run: node ralph/journal.mjs stub ${id}`);
  const lines = readFileSync(p, "utf8").split("\n");
  const re = ownLine(id);
  let i = lines.length - 1;
  while (i >= 0 && !re.test(lines[i])) i--;
  if (i < 0) throw new Error(`no [${id}] line in ${JOURNAL}; run: node ralph/journal.mjs stub ${id}`);
  if (!lines[i].endsWith(STUB_END)) throw new Error(`the last [${id}] line is not an open stub (an earlier attempt's line is never completed); run: node ralph/journal.mjs stub ${id}`);
  lines[i] = lines[i].slice(0, -STUB_END.length) + completion(fields);
  writeFileSync(p, lines.join("\n"));
  return lines[i];
}

/** Summary lines ("check: ...") from a saved scripts/check output. */
export function checkSummary(text) {
  return text.split("\n").filter((l) => /^check: /.test(l)).map((l) => l.slice(7).trim()).join("; ");
}

function commit(root, id, what) {
  const g = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const a = g(["add", "--", JOURNAL]);
  if (a.status !== 0) throw new Error(`git add failed: ${a.stderr.trim()}`);
  const c = g(["commit", "-q", "-m", `wip(${id}): journal ${what}`, "--only", "--", JOURNAL]);
  if (c.status !== 0) throw new Error(`git commit failed: ${(c.stderr || c.stdout).trim()}`);
}

export function parseArgs(argv) {
  const out = { _: [], guards: [], commit: true };
  const names = { status: "status", files: "files", tests: "tests", check: "check", guard: "guard", attempt: "attempt", iterations: "iterations", "first-attempt": "firstAttempt", "tool-calls": "toolCalls", notes: "notes", root: "root" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-commit") { out.commit = false; continue; }
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const key = names[k];
    if (!key) throw new Error(`unknown flag --${k}`);
    const v = inline !== undefined ? inline : argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    if (key === "guard") out.guards.push(v); else out[key] = v;
  }
  return out;
}

export function main(argv, cwd = process.cwd()) {
  const o = parseArgs(argv);
  const [cmd, id] = o._;
  if (!["stub", "complete"].includes(cmd) || !id) {
    process.stderr.write(`usage: node ralph/journal.mjs stub <id> [--no-commit]
       node ralph/journal.mjs complete <id> --status ${STATUSES.join("|")} --files <text>
         (--tests <text> | --check <file holding scripts/check output>) [--guard "<guard> => <test>"]...
         --attempt <n> [--iterations <n>] [--first-attempt y|n] --tool-calls <n> --notes <text, <= ${NOTES_CAP} chars> [--no-commit]
`);
    return 2;
  }
  const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const root = resolve(o.root ?? (top.status === 0 ? top.stdout.trim() : cwd));
  try {
    let line;
    if (cmd === "stub") line = appendStub(root, id);
    else {
      const tests = [o.tests, o.check ? checkSummary(readFileSync(resolve(cwd, o.check), "utf8")) : undefined].filter(Boolean).join("; ");
      line = completeLast(root, id, { ...o, tests });
    }
    if (o.commit) commit(root, id, cmd);
    process.stdout.write(`${cmd === "stub" ? "stubbed" : "completed"} [${id}] (${line.length} chars)${o.commit ? `, committed wip(${id}): journal ${cmd}` : ""}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`journal: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
