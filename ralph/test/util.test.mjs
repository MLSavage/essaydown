// util.test.mjs — RUNNER-SPEC §1 ("one lock", write-temp-then-rename) and §8.4 (the close intent
// must be durable before the ref transaction), asserted directly against ralph/lib/util.mjs.
// Unlike conformance.test.mjs these are not fixture-repository scenarios: the two properties under
// test (who owns the lock at each instant, and the syscall order writeAtomic issues) are only
// observable by interleaving a second actor at an exact point and by watching the calls themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { withLock, writeAtomic } from "../lib/util.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "ralph-util-"));
const lockPath = (root) => join(root, ".locks", "ralph");

/** A pid that is certainly not running: spawn a process that exits, then reuse its (reaped) pid. */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(r.status, 0, "probe process failed");
  return r.pid;
}

const staleLine = () => `${deadPid()} ${new Date().toISOString()} ${"0".repeat(32)}\n`;
const foreignLine = (pid) => `${pid} ${new Date().toISOString()} ${"f".repeat(32)}\n`;

test("withLock: a stale lock is broken and taken as one operation; a breaker that lands between the check and the break leaves exactly one holder and the other aborts", async (t) => {
  await t.test("a stale lock is broken and taken, and released on the way out", () => {
    const root = tmp();
    try {
      const lock = lockPath(root);
      writeStale(lock);
      let ran = 0;
      const held = withLock(root, () => { ran++; return readFileSync(lock, "utf8"); });
      assert.equal(ran, 1, "the stale lock was not broken");
      assert.match(held, new RegExp(`^${process.pid} `), "the lock we took does not name this process");
      assert.equal(existsSync(lock), false, "the lock survived the release");
      assert.deepEqual(staleDebris(root), [], "the broken stale file was left behind");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  await t.test("a concurrent breaker between the staleness check and the break: this process aborts, the other stays the sole holder", () => {
    const root = tmp();
    try {
      const lock = lockPath(root);
      writeStale(lock);
      const foreign = foreignLine(process.pid); // a *live* holder: it must never be broken
      let ran = 0;
      let hookCalls = 0;
      assert.throws(
        () => withLock(root, () => { ran++; }, {
          hooks: { beforeBreak: () => { hookCalls++; writeFileSync(lock, foreign); } },
        }),
        /replaced between the staleness check and the break/,
        "breaking a lock that changed under us was not refused",
      );
      assert.equal(hookCalls, 1, "the break point was never reached");
      assert.equal(ran, 0, "the aborting process ran the critical section anyway");
      assert.equal(readFileSync(lock, "utf8"), foreign, "the concurrent breaker is no longer the holder");
      assert.deepEqual(staleDebris(root), [], "a live holder's lock was carried off to a stale name");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  await t.test("a breaker that steals the lock after our create: the post-acquisition token re-read aborts and the thief's lock is left alone", () => {
    const root = tmp();
    try {
      const lock = lockPath(root);
      const foreign = foreignLine(process.pid);
      let ran = 0;
      assert.throws(
        () => withLock(root, () => { ran++; }, {
          hooks: { afterCreate: () => writeFileSync(lock, foreign) },
        }),
        /after acquisition/,
        "a lock taken from us after acquisition was not detected",
      );
      assert.equal(ran, 0, "the critical section ran on a lock we no longer held");
      assert.equal(readFileSync(lock, "utf8"), foreign, "the release deleted a lock this process did not own");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("withLock: release deletes the lock only while it still carries our token", () => {
  const root = tmp();
  try {
    const lock = lockPath(root);
    const foreign = foreignLine(process.pid);
    const r = withLock(root, () => { writeFileSync(lock, foreign); return "done"; });
    assert.equal(r, "done");
    assert.equal(existsSync(lock), true, "release unlinked a lock whose token was not ours");
    assert.equal(readFileSync(lock, "utf8"), foreign, "release replaced another holder's lock");
    rmSync(lock, { force: true });
    // and the normal case still releases
    withLock(root, () => {});
    assert.equal(existsSync(lock), false, "release did not delete our own lock");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("writeAtomic: write → fsync(fd) → close → rename → fsync(dir) (RUNNER-SPEC §8.4 needs the close intent durable before the ref transaction)", () => {
  const root = tmp();
  try {
    const p = join(root, "closes", "0.intent.json");
    const calls = [];
    let next = 10;
    const fds = new Map();
    const fs = {
      openSync: (path, flags) => { const fd = next++; fds.set(fd, path); calls.push(`open ${path} ${flags}`); return fd; },
      writeSync: (fd, content) => { calls.push(`write ${fd} ${content.length}`); return content.length; },
      fsyncSync: (fd) => { calls.push(`fsync ${fd}`); },
      closeSync: (fd) => { calls.push(`close ${fd}`); },
      renameSync: (from, to) => { calls.push(`rename ${from} -> ${to}`); },
    };
    writeAtomic(p, "payload", { fs });

    assert.match(calls[0], /^open .* w$/, `first call was ${calls[0]}`);
    const temp = calls[0].slice("open ".length, -" w".length);
    assert.ok(temp.startsWith(`${p}.tmp.`), `temporary file ${temp} is not a sibling temp of ${p}`);
    assert.deepEqual(calls, [
      `open ${temp} w`,
      "write 10 7",
      "fsync 10",
      "close 10",
      `rename ${temp} -> ${p}`,
      `open ${dirname(p)} r`,
      "fsync 11",
      "close 11",
    ], "writeAtomic did not fsync the file before the rename and the directory after it");
    assert.equal(fds.get(10), temp);
    assert.equal(fds.get(11), dirname(p), "the second descriptor is not the containing directory");

    // and with the real fs it still writes the bytes and leaves no temporary behind
    writeAtomic(p, "real\n");
    assert.equal(readFileSync(p, "utf8"), "real\n");
    assert.deepEqual(leftovers(dirname(p)), ["0.intent.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// -- helpers -------------------------------------------------------------------------------------

/** Leave a lock file behind for a process that has already exited. */
function writeStale(lock) {
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, staleLine());
}

function staleDebris(root) {
  const d = join(root, ".locks");
  if (!existsSync(d)) return [];
  return readdir(d).filter((n) => n.startsWith("ralph.stale."));
}
function leftovers(d) { return readdir(d); }
function readdir(d) { return existsSync(d) ? readdirSync(d).sort() : []; }
