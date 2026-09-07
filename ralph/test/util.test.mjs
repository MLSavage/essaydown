// util.test.mjs — RUNNER-SPEC §1 ("one lock", write-temp-then-rename) and §8.4 (the close intent
// must be durable before the ref transaction), asserted directly against ralph/lib/util.mjs.
// Unlike conformance.test.mjs these are not fixture-repository scenarios: the two properties under
// test (who owns the lock at each instant, and the syscall order writeAtomic issues) are only
// observable by interleaving a second actor at an exact point and by watching the calls themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { withLock, writeAtomic, lockHolder } from "../lib/util.mjs";
import { Ctx } from "../lib/state.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "ralph-util-"));
const lockPath = (root) => join(root, ".locks", "ralph");
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pid that is certainly not running: spawn a process that exits, then reuse its (reaped) pid. */
function deadPid() {
  const r = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  assert.equal(r.status, 0, "probe process failed");
  return r.pid;
}

const staleLine = (pid) => `${pid} ${new Date().toISOString()} ${"0".repeat(32)}\n`;
const foreignLine = (pid) => `${pid} ${new Date().toISOString()} ${"f".repeat(32)}\n`;

// The wait a third entrant is asked to spend on a live holder before it gives up. Long enough that
// withLock's 200 ms poll is reached at least once, short enough to keep the suite quick.
const WAIT_MS = 260;

test("withLock: a lock whose holder pid is dead is refused with the manual recovery, never broken (DECISIONS #review-0-r1 G4)", async (t) => {
  await t.test("the refusal names the file, the dead pid and the manual recovery, and the lock file is not touched", () => {
    const root = tmp();
    try {
      const lock = lockPath(root);
      const dead = deadPid();
      writeStale(lock, dead);
      const bytes = readFileSync(lock, "utf8");
      const ino = statSync(lock).ino;
      let ran = 0;
      assert.throws(() => withLock(root, () => { ran++; }), (e) => {
        assert.match(e.message, new RegExp(`lock ${re(lock)} is held by pid ${dead}, which is not running`), e.message);
        assert.match(e.message, /never breaks a lock it did not create/, e.message);
        assert.match(e.message, /pgrep/, e.message);
        assert.match(e.message, new RegExp(`remove ${re(lock)} by hand`), e.message);
        return true;
      });
      assert.equal(ran, 0, "the critical section ran on a lock this process does not hold");
      assert.equal(readFileSync(lock, "utf8"), bytes, "the lock file was rewritten");
      assert.equal(statSync(lock).ino, ino, "the lock file was replaced (renamed away, unlinked or re-created)");
      assert.deepEqual(staleDebris(root), [], "the lock was carried off to a stale name");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  await t.test("every later entrant is refused the same way: the path is never free, so nobody can create it", () => {
    const root = tmp();
    try {
      const lock = lockPath(root);
      writeStale(lock, deadPid());
      const ino = statSync(lock).ino;
      let ran = 0;
      for (const who of ["B", "C", "D"]) {
        assert.throws(() => withLock(root, () => { ran++; }), /is not running/, `${who} was not refused`);
        assert.equal(existsSync(lock), true, `the lock path was free after ${who}`);
        assert.equal(statSync(lock).ino, ino, `${who} replaced the lock file`);
      }
      assert.equal(ran, 0);
      // and the manual repair is the only way through
      rmSync(lock);
      let entered = 0;
      withLock(root, () => { entered++; });
      assert.equal(entered, 1, "the lock could not be taken after the manual removal");
      assert.equal(existsSync(lock), false, "the lock we created survived the release");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("withLock: Sol's three-actor interleaving — a crashed holder, a breaker, a live holder and a third entrant: the live holder's path is never freed and the third entrant waits until timeout", async (t) => {
  await t.test("the sequence from the probe: B refuses instead of breaking, A takes over the path, C waits and gives up", () => {
    const root = tmp();
    try {
      const lock = lockPath(root);
      writeStale(lock, deadPid()); // A0, the crashed holder whose lock is still on disk
      let b = 0, c = 0;
      assert.throws(() => withLock(root, () => { b++; }), /is not running/, "B broke the lock instead of refusing");
      // A, a live holder, takes over the path exactly where the old code's rename window was
      const live = foreignLine(process.pid);
      writeFileSync(lock, live);
      const ino = statSync(lock).ino;
      const t0 = Date.now();
      assert.throws(() => withLock(root, () => { c++; }, { timeoutMs: WAIT_MS }), new RegExp(`lock ${re(lock)} held by pid ${process.pid}$`), "C did not wait for the live holder");
      assert.ok(Date.now() - t0 >= WAIT_MS, "C gave up before the timeout");
      assert.equal(b + c, 0, "a critical section ran beside the live holder");
      assert.equal(readFileSync(lock, "utf8"), live, "the live holder's lock was rewritten");
      assert.equal(statSync(lock).ino, ino, "the live holder's path was freed");
      assert.deepEqual(staleDebris(root), [], "the live holder's lock was carried off to a stale name");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  await t.test("a third entrant driven through hooks.afterCreate, the one interleaving point left: it waits, and the holder's lock file is untouched", () => {
    const root = tmp();
    try {
      const lock = lockPath(root);
      let entered = 0, third = 0, hooks = 0;
      withLock(root, () => { entered++; }, {
        hooks: {
          afterCreate: ({ lock: l }) => {
            hooks++;
            const ino = statSync(l).ino;
            const t0 = Date.now();
            assert.throws(() => withLock(root, () => { third++; }, { timeoutMs: WAIT_MS }), new RegExp(`lock ${re(lock)} held by pid ${process.pid}$`), "the third entrant was not made to wait");
            assert.ok(Date.now() - t0 >= WAIT_MS, "the third entrant gave up before the timeout");
            assert.equal(statSync(l).ino, ino, "the third entrant replaced the holder's lock file");
          },
        },
      });
      assert.equal(hooks, 1, "the interleaving point was never reached");
      assert.equal(entered, 1, "the holder did not run its critical section exactly once");
      assert.equal(third, 0, "a third entrant ran beside the holder");
      assert.equal(existsSync(lock), false, "the holder did not release");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("withLock: a breaker that steals the lock after our create is caught by the post-acquisition token re-read, and the thief's lock is left alone", () => {
  const root = tmp();
  try {
    const lock = lockPath(root);
    const foreign = foreignLine(process.pid);
    let ran = 0;
    assert.throws(
      () => withLock(root, () => { ran++; }, { hooks: { afterCreate: () => writeFileSync(lock, foreign) } }),
      /after acquisition/,
      "a lock taken from us after acquisition was not detected",
    );
    assert.equal(ran, 0, "the critical section ran on a lock we no longer held");
    assert.equal(readFileSync(lock, "utf8"), foreign, "the release deleted a lock this process did not own");
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test("writeAtomic: a directory fsync that fails leaves one line in the state audit log and the write still completes (DECISIONS #review-0-r1 G5)", async (t) => {
  // The sink is the audit log the state layer already writes: writing through the default (what the
  // runner uses) is the point — a swallowed failure is exactly a close intent with no trace.
  const failing = (where, code) => {
    const calls = [];
    const fail = (msg, c) => { const e = new Error(msg); e.code = c; return e; };
    let next = 10;
    return {
      calls,
      fs: {
        openSync: (path, flags) => { calls.push(`open ${path} ${flags}`); if (flags === "r" && where === "open") throw fail(`EACCES: permission denied, open '${path}'`, code); return next++; },
        writeSync: (fd, content) => { calls.push(`write ${fd}`); return content.length; },
        fsyncSync: (fd) => { calls.push(`fsync ${fd}`); if (where === "fsync" && fd > 10) throw fail("EINVAL: invalid argument, fsync", code); },
        closeSync: (fd) => { calls.push(`close ${fd}`); },
        renameSync: (from, to) => { calls.push(`rename ${from} -> ${to}`); },
      },
    };
  };

  for (const [where, code, label] of [["open", "EACCES", "the directory cannot be opened for reading"], ["fsync", "EINVAL", "the directory fsync itself throws"]]) {
    await t.test(label, () => {
      const root = tmp();
      try {
        const ctx = new Ctx(root); // the state layer names its audit log; writeAtomic writes to the same file
        const p = join(root, ".evidence", "closes", "0.intent.json");
        const { fs, calls } = failing(where, code);
        writeAtomic(p, "payload", { fs });
        assert.ok(calls.some((c) => c.startsWith("rename ")), "the write did not complete: no rename");
        assert.equal(existsSync(ctx.paths.audit), true, "no audit log was written");
        const lines = readFileSync(ctx.paths.audit, "utf8").trim().split("\n");
        const hits = lines.filter((l) => l.includes("writeAtomic: directory fsync failed"));
        assert.equal(hits.length, 1, `expected exactly one durability line, got ${JSON.stringify(lines)}`);
        assert.match(hits[0], new RegExp(`writeAtomic: directory fsync failed ${re(p)} ${code}$`), hits[0]);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  await t.test("a directory fsync that succeeds writes no line at all", () => {
    const root = tmp();
    try {
      const ctx = new Ctx(root);
      writeAtomic(join(root, ".evidence", "closes", "1.intent.json"), "payload");
      const log = existsSync(ctx.paths.audit) ? readFileSync(ctx.paths.audit, "utf8") : "";
      assert.doesNotMatch(log, /writeAtomic: directory fsync failed/, "a successful directory fsync was reported as a failure");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// -- helpers -------------------------------------------------------------------------------------

/** Leave a lock file behind for a process that has already exited. */
test("withLock: a lock file that carries no pid is an unidentifiable holder — waited on to the timeout, never declared dead (DECISIONS #review-0-r2 H1)", async (t) => {
  for (const [what, content] of [["empty", ""], ["garbled", "not-a-pid 2026-01-01T00:00:00.000Z deadbeef\n"]]) {
    await t.test(`a ${what} lock file: lockHolder reports pid null and alive null; withLock waits and then refuses without "is not running"; the file is untouched`, () => {
      const root = tmp();
      try {
        const lock = lockPath(root);
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(lock, content);
        const ino = statSync(lock).ino;
        assert.deepEqual(lockHolder(root), { lock, pid: null, alive: null });
        let ran = 0;
        const t0 = Date.now();
        assert.throws(() => withLock(root, () => { ran++; }, { timeoutMs: WAIT_MS }), (e) => {
          assert.doesNotMatch(e.message, /is not running/, e.message);
          assert.match(e.message, new RegExp(`lock ${re(lock)} carries no pid and was not released within ${WAIT_MS} ms`), e.message);
          assert.match(e.message, /pgrep/, e.message);
          return true;
        });
        assert.ok(Date.now() - t0 >= WAIT_MS, "the entrant did not wait for the timeout before refusing");
        assert.equal(ran, 0, "the critical section ran on a lock this process does not hold");
        assert.equal(readFileSync(lock, "utf8"), content, "the lock file was rewritten");
        assert.equal(statSync(lock).ino, ino, "the lock file was replaced");
        assert.deepEqual(staleDebris(root), [], "the lock was carried off to a stale name");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  await t.test("the wait re-reads the file: a holder that finishes writing a dead pid inside the wait is then refused as dead, one that writes a live pid keeps the entrant waiting", () => {
    for (const [who, pidOf] of [["dead", () => deadPid()], ["live", () => process.pid]]) {
      const root = tmp();
      try {
        const lock = lockPath(root);
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(lock, "");
        // a second actor completes the holder's write 100 ms in, while this process blocks in withLock's poll
        const writer = spawn(process.execPath, ["-e", `setTimeout(() => require("fs").writeFileSync(process.argv[1], process.argv[2]), 100)`, lock, staleLine(pidOf())], { stdio: "ignore" });
        let ran = 0;
        assert.throws(() => withLock(root, () => { ran++; }, { timeoutMs: 600 }), who === "dead" ? /is not running/ : /held by pid \d+$/);
        assert.equal(ran, 0);
        assert.equal(existsSync(lock), true, "the lock file was removed");
        writer.kill();
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
});

function writeStale(lock, pid) {
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, staleLine(pid));
}

function staleDebris(root) {
  const d = join(root, ".locks");
  if (!existsSync(d)) return [];
  return readdir(d).filter((n) => n !== "ralph");
}
function leftovers(d) { return readdir(d); }
function readdir(d) { return existsSync(d) ? readdirSync(d).sort() : []; }
