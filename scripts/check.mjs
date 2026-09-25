// scripts/check.mjs — the suite (`pnpm lint`, `pnpm test`, `cargo test`) with its output reduced to
// failures and pass/fail counts per step (docs/proposals/001 §4 item 4). Run it as `scripts/check`
// from anywhere in the repo; `scripts/check lint cargo` runs a subset. Every step runs even after a
// failure, so one call shows every red step. Full output of each step is kept in
// <tmpdir>/essaydown-check/<step>.log for grepping; exit status is non-zero when any step fails.
// No dependencies: node:child_process, node:fs, node:os, node:path only.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");
const MAX_LINES = 40;
const NOISE = /ELIFECYCLE|^> |^\s*$|^\s*ERR_PNPM_/;

export const lines = (text) => text.replace(ANSI, "").replace(/\r/g, "").split("\n");
const uniq = (xs) => [...new Set(xs)];
const tail = (ls, n = 30) => ls.filter((l) => !NOISE.test(l)).slice(-n);

/** eslint (stylish), tsc (via `pnpm -r typecheck`) and check-deps output. */
export function parseLint(text) {
  const ls = lines(text);
  const failures = [];
  let file = null;
  let eslint = 0;
  for (const l of ls) {
    if (/^(\/|[\w.@-]+\/)\S*\.(ts|tsx|js|jsx|mjs|cjs)$/.test(l.trim()) && !/\s/.test(l.trim())) { file = l.trim(); continue; }
    if (/^\s+\d+:\d+\s+(error|warning)\s/.test(l)) { failures.push(`${file ?? "?"} ${l.trim().replace(/\s{2,}/g, "  ")}`); continue; }
    if (/error TS\d+:/.test(l)) failures.push(l.trim());
    const m = l.match(/✖ (\d+) problems?/);
    if (m) eslint = Number(m[1]);
  }
  const tsc = ls.filter((l) => /error TS\d+:/.test(l)).length;
  const counts = eslint || tsc ? `eslint ${eslint} problems; tsc ${tsc} errors` : "";
  return { counts, failures: uniq(failures) };
}

/** vitest (default reporter): the Test Files / Tests summary lines, FAIL lines and their first error line. */
export function parseVitest(text) {
  const ls = lines(text);
  const files = ls.map((l) => l.match(/^\s*Test Files\s+(\d.*)$/)?.[1]).filter(Boolean).pop();
  const tests = ls.map((l) => l.match(/^\s*Tests\s+(\d.*)$/)?.[1]).filter(Boolean).pop();
  const counts = [files && `Test Files ${files.trim()}`, tests && `Tests ${tests.trim()}`].filter(Boolean).join("; ");
  const failures = [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (/^\s*FAIL\s/.test(l)) {
      failures.push(l.trim().replace(/\s{2,}/g, " "));
      const err = ls.slice(i + 1, i + 6).find((x) => /^\s*(\w*Error|Error)\b|^\s*Unhandled/.test(x));
      if (err) failures.push(`  ${err.trim()}`);
    } else if (/^\s*ERROR: Coverage/.test(l) || /Unhandled (Errors?|Rejection)/.test(l)) failures.push(l.trim());
  }
  return { counts, failures: uniq(failures) };
}

/** cargo test -q: summed "test result:" lines, failed test names and panics, compile errors. */
export function parseCargo(text) {
  const ls = lines(text);
  let suites = 0, passed = 0, failed = 0, ignored = 0;
  const failures = [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const r = l.match(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/);
    if (r) { suites++; passed += +r[1]; failed += +r[2]; ignored += +r[3]; continue; }
    const t = l.match(/^test (\S+) \.\.\. FAILED$/) ?? l.match(/^---- (\S+) stdout ----$/);
    if (t) { failures.push(`FAILED ${t[1]}`); continue; }
    if (/panicked at /.test(l)) { failures.push(`  ${l.trim()}`); if (ls[i + 1]?.trim()) failures.push(`  ${ls[i + 1].trim()}`); continue; }
    if (/^error(\[E\d+\])?: /.test(l)) { failures.push(l.trim()); const at = ls[i + 1]?.match(/^\s*--> (.*)$/); if (at) failures.push(`  --> ${at[1]}`); }
  }
  const counts = suites ? `${suites} suites: ${passed} passed; ${failed} failed; ${ignored} ignored` : "";
  return { counts, failures: uniq(failures) };
}

export const STEPS = {
  lint: { cmd: "pnpm", args: ["-s", "lint"], parse: parseLint },
  test: { cmd: "pnpm", args: ["-s", "test"], parse: parseVitest },
  cargo: { cmd: "cargo", args: ["test", "-q"], parse: parseCargo },
};

/** The report for one step: a "check: <step> pass|FAIL …" line, then failure lines when it failed. */
export function report(name, code, text) {
  const { counts, failures } = STEPS[name].parse(text);
  const ok = code === 0;
  const head = `check: ${name} ${ok ? "pass" : `FAIL (exit ${code})`}${counts ? ` — ${counts}` : ""}`;
  if (ok) return [head];
  const body = failures.length ? failures : ["(no failure lines recognised; last lines of output:)", ...tail(lines(text))];
  const shown = body.slice(0, MAX_LINES).map((l) => `  ${l}`);
  if (body.length > MAX_LINES) shown.push(`  … ${body.length - MAX_LINES} more lines`);
  return [head, ...shown];
}

export function main(argv, root = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const names = argv.length ? argv : Object.keys(STEPS);
  const unknown = names.filter((n) => !STEPS[n]);
  if (unknown.length) { process.stderr.write(`usage: scripts/check [${Object.keys(STEPS).join("|")}]...  (unknown: ${unknown.join(", ")})\n`); return 2; }
  const logDir = join(tmpdir(), "essaydown-check");
  mkdirSync(logDir, { recursive: true });
  const red = [];
  for (const name of names) {
    const { cmd, args } = STEPS[name];
    const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30 });
    const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
    writeFileSync(join(logDir, `${name}.log`), text);
    const code = r.status ?? 1;
    if (code !== 0) red.push(name);
    process.stdout.write(report(name, code, text).join("\n") + "\n");
  }
  process.stdout.write(red.length ? `check: FAIL (${red.join(", ")}); full output in ${logDir}/<step>.log\n` : "check: all green\n");
  return red.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
