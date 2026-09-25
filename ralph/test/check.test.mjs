// check.test.mjs — scripts/check (docs/proposals/001 §4 item 4): the parsers over captured-shape
// outputs of eslint/tsc, vitest and `cargo test -q`, and the wrapper end to end against fake `pnpm`
// and `cargo` on PATH (the real tools do not run in this suite; a container run is still owed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLint, parseVitest, parseCargo, report } from "../../scripts/check.mjs";

const CHECK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "check");
const ESC = String.fromCharCode(27);

const VITEST_GREEN = `
 RUN  v5.0.0 /work/.wt/2.3

 ✓ packages/core/test/ids.test.ts (12 tests) 8ms
 ✓ packages/editor/test/toggle.test.ts (4804 tests) 2412ms

 Test Files  47 passed (47)
      Tests  4816 passed (4816)
   Start at  09:40:01
   Duration  46.61s

 % Coverage report from v8
-----------|---------|----------|---------|---------|
File       | % Stmts | % Branch | % Funcs | % Lines |
-----------|---------|----------|---------|---------|
All files  |   99.52 |    97.22 |     100 |   99.61 |
`;

const VITEST_RED = `
 RUN  v5.0.0 /work/.wt/2.3

 ${ESC}[31m❯${ESC}[39m packages/editor/test/toggle.test.ts (4804 tests | 2 failed) 2412ms
   × emphasis, punctuation edge 4ms
 ✓ packages/core/test/ids.test.ts (12 tests) 8ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  packages/editor/test/toggle.test.ts > marks > emphasis, punctuation edge
AssertionError: expected 'Alpha X\\*(beta.)\\* gamma\\n' to be 'Alpha &#x58;*(beta.)* gamma\\n' // Object.is equality

- Expected
+ Received

 ❯ packages/editor/test/toggle.test.ts:120:7

⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  packages/editor/test/toggle.test.ts > marks > strong, punctuation edge
TypeError: Cannot read properties of undefined (reading 'marks')
 ❯ packages/editor/src/toggle.ts:44:12

⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed | 46 passed (47)
      Tests  2 failed | 4814 passed (4816)
   Duration  46.61s
ERROR: Coverage for lines (98.9%) does not meet global threshold (99%)
 ELIFECYCLE  Test failed. See above for more details.
`;

const LINT_RED = `
/work/.wt/2.3/packages/core/src/ids.ts
  12:7   error  'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars
  30:1   warning  Unexpected console statement  no-console

/work/.wt/2.3/scripts/check.mjs
  4:10  error  'x' is not defined  no-undef

✖ 3 problems (2 errors, 1 warning)

 ELIFECYCLE  Command failed with exit code 1.
`;

const TSC_RED = `packages/editor/src/toggle.ts(44,12): error TS2322: Type 'string' is not assignable to type 'number'.
packages/editor typecheck: Failed
 ELIFECYCLE  Command failed with exit code 2.
`;

const CARGO_GREEN = `
running 12 tests
............
test result: ok. 12 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s


running 3 tests
...
test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;

const CARGO_RED = `
running 4 tests
..F.
failures:

---- workspace::tests::rejects_traversal stdout ----

thread 'workspace::tests::rejects_traversal' panicked at src/workspace.rs:88:9:
assertion \`left == right\` failed
  left: Ok(())
 right: Err(Traversal)

failures:
    workspace::tests::rejects_traversal

test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s

error: test failed, to rerun pass \`-p essaydown --lib\`
`;

const CARGO_BUILD_RED = `error[E0425]: cannot find value \`root\` in this scope
  --> src/workspace.rs:12:5
   |
12 |     root
   |     ^^^^ not found in this scope

error: could not compile \`essaydown\` (lib test) due to 1 previous error
`;

test("vitest: green output reduces to the Test Files / Tests counts, the coverage table dropped", () => {
  const p = parseVitest(VITEST_GREEN);
  assert.equal(p.counts, "Test Files 47 passed (47); Tests 4816 passed (4816)");
  assert.deepEqual(p.failures, []);
  assert.deepEqual(report("test", 0, VITEST_GREEN), ["check: test pass — Test Files 47 passed (47); Tests 4816 passed (4816)"]);
});

test("vitest: red output keeps each FAIL line once with its first error line, the coverage threshold error, the counts; ANSI stripped", () => {
  const p = parseVitest(VITEST_RED);
  assert.equal(p.counts, "Test Files 1 failed | 46 passed (47); Tests 2 failed | 4814 passed (4816)");
  assert.deepEqual(p.failures, [
    "FAIL packages/editor/test/toggle.test.ts > marks > emphasis, punctuation edge",
    "  AssertionError: expected 'Alpha X\\*(beta.)\\* gamma\\n' to be 'Alpha &#x58;*(beta.)* gamma\\n' // Object.is equality",
    "FAIL packages/editor/test/toggle.test.ts > marks > strong, punctuation edge",
    "  TypeError: Cannot read properties of undefined (reading 'marks')",
    "ERROR: Coverage for lines (98.9%) does not meet global threshold (99%)",
  ]);
  const r = report("test", 1, VITEST_RED);
  assert.equal(r[0], "check: test FAIL (exit 1) — Test Files 1 failed | 46 passed (47); Tests 2 failed | 4814 passed (4816)");
  assert.ok(!r.join("\n").includes(ESC) && !r.join("\n").includes("ELIFECYCLE") && !r.join("\n").includes("% Stmts"));
});

test("lint: eslint problems carry their file; tsc errors are kept; counts name both tools", () => {
  const e = parseLint(LINT_RED);
  assert.equal(e.counts, "eslint 3 problems; tsc 0 errors");
  assert.deepEqual(e.failures, [
    "/work/.wt/2.3/packages/core/src/ids.ts 12:7  error  'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars",
    "/work/.wt/2.3/packages/core/src/ids.ts 30:1  warning  Unexpected console statement  no-console",
    "/work/.wt/2.3/scripts/check.mjs 4:10  error  'x' is not defined  no-undef",
  ]);
  const t = parseLint(TSC_RED);
  assert.equal(t.counts, "eslint 0 problems; tsc 1 errors");
  assert.deepEqual(t.failures, ["packages/editor/src/toggle.ts(44,12): error TS2322: Type 'string' is not assignable to type 'number'."]);
  assert.deepEqual(report("lint", 0, ""), ["check: lint pass"]);
});

test("cargo: result lines are summed across suites; a failing test gives its name once and its panic; a build error gives its location", () => {
  assert.deepEqual(parseCargo(CARGO_GREEN), { counts: "3 suites: 15 passed; 0 failed; 1 ignored", failures: [] });
  const r = parseCargo(CARGO_RED);
  assert.equal(r.counts, "1 suites: 3 passed; 1 failed; 0 ignored");
  assert.deepEqual(r.failures.slice(0, 3), [
    "FAILED workspace::tests::rejects_traversal",
    "  thread 'workspace::tests::rejects_traversal' panicked at src/workspace.rs:88:9:",
    "  assertion `left == right` failed",
  ]);
  const b = parseCargo(CARGO_BUILD_RED);
  assert.equal(b.counts, "");
  assert.deepEqual(b.failures.slice(0, 2), ["error[E0425]: cannot find value `root` in this scope", "  --> src/workspace.rs:12:5"]);
});

test("a failed step with no recognised failure lines falls back to the last lines of output, without pnpm noise", () => {
  const r = report("lint", 1, "check-deps: react 20.0.0 is not the pinned major 19\n ELIFECYCLE  Command failed with exit code 1.\n");
  assert.deepEqual(r, ["check: lint FAIL (exit 1)", "  (no failure lines recognised; last lines of output:)", "  check-deps: react 20.0.0 is not the pinned major 19"]);
});

test("scripts/check end to end with fake pnpm and cargo: every step runs, only summaries and failures print, exit is non-zero on any failure and zero when all pass", () => {
  const bin = mkdtempSync(join(tmpdir(), "check-bin-"));
  try {
    const fake = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    writeFileSync(join(bin, "vitest-red.txt"), VITEST_RED);
    writeFileSync(join(bin, "cargo-green.txt"), CARGO_GREEN);
    fake("pnpm", `case "$2" in lint) exit 0;; test) cat "${bin}/vitest-red.txt"; exit 1;; esac; exit 9`);
    fake("cargo", `cat "${bin}/cargo-green.txt"`);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: bin };
    const red = spawnSync("bash", [CHECK], { env, encoding: "utf8" });
    assert.equal(red.status, 1);
    const out = red.stdout.split("\n");
    assert.equal(out[0], "check: lint pass");
    assert.match(out[1], /^check: test FAIL \(exit 1\) — Test Files 1 failed/);
    assert.ok(out.includes("check: cargo pass — 3 suites: 15 passed; 0 failed; 1 ignored"), "a later step still runs after a failure");
    assert.match(out.at(-2), /^check: FAIL \(test\); full output in /);
    assert.ok(!red.stdout.includes("Coverage report") && !red.stdout.includes("RUN  v5"), "passing detail is not printed");
    fake("pnpm", `exit 0`);
    const green = spawnSync("bash", [CHECK], { env, encoding: "utf8" });
    assert.equal(green.status, 0);
    assert.equal(green.stdout.trim().split("\n").at(-1), "check: all green");
    const one = spawnSync("bash", [CHECK, "cargo"], { env, encoding: "utf8" });
    assert.deepEqual(one.stdout.trim().split("\n"), ["check: cargo pass — 3 suites: 15 passed; 0 failed; 1 ignored", "check: all green"]);
    assert.equal(spawnSync("bash", [CHECK, "nope"], { env, encoding: "utf8" }).status, 2);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});
