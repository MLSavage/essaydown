// util.mjs — shell, git, atomic files, lock (RUNNER-SPEC §1 "write-temp-then-rename", one lock).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync, renameSync, unlinkSync, writeSync, appendFileSync, readdirSync, statSync, symlinkSync, lstatSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export class RalphError extends Error {
  constructor(message, { signal = null, exit = 1 } = {}) { super(message); this.signal = signal; this.exit = exit; }
}

export const now = () => new Date().toISOString();

export function sh(cmd, args, { cwd, env, input, check = true, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...(env ?? {}) }, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new RalphError(`${cmd} ${args.join(" ")}: ${r.error.message}`);
  if (check && r.status !== 0) throw new RalphError(`${cmd} ${args.join(" ")} failed (${r.status})${quiet ? "" : `: ${(r.stderr || r.stdout || "").trim().slice(0, 2000)}`}`);
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run a shell command line (string) via sh -c, streaming output to the terminal. */
export function shell(line, { cwd, env, check = true, capture = false } = {}) {
  const r = spawnSync("sh", ["-c", line], { cwd, env: { ...process.env, ...(env ?? {}) }, stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new RalphError(`${line}: ${r.error.message}`);
  if (check && r.status !== 0) throw new RalphError(`command failed (${r.status}): ${line}`);
  return r;
}

export const git = (repo, args, opts = {}) => sh("git", ["-C", repo, ...args], opts);
export const gitOut = (repo, args, opts = {}) => git(repo, args, opts).stdout.trim();
export const revParse = (repo, ref) => { const r = git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { check: false }); return r.status === 0 ? r.stdout.trim() : null; };
export const refExists = (repo, ref) => git(repo, ["show-ref", "--verify", "--quiet", ref], { check: false }).status === 0;
export const refOid = (repo, ref) => { const r = git(repo, ["rev-parse", "--verify", "--quiet", ref], { check: false }); return r.status === 0 ? r.stdout.trim() : null; };
export const isAncestor = (repo, a, b) => git(repo, ["merge-base", "--is-ancestor", a, b], { check: false }).status === 0;
export const ZERO = "0000000000000000000000000000000000000000";

export function ensureDir(p) { mkdirSync(p, { recursive: true }); return p; }

export function readJson(p, fallback = undefined) {
  if (!existsSync(p)) { if (fallback !== undefined) return fallback; throw new RalphError(`missing ${p}`); }
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new RalphError(`${p} does not parse: ${e.message}`); }
}

/** The real syscalls writeAtomic issues; the conformance suite injects a recorder in their place. */
const REAL_FS = { openSync, writeSync, fsyncSync, closeSync, renameSync };

/**
 * write-temp-then-rename, fsync'd (RUNNER-SPEC §1). The order is
 * write → fsync(fd) → close → rename → fsync(dir): the bytes reach the disk before the rename
 * publishes them, and the directory entry the rename created reaches the disk before we return,
 * because §8.4 needs the close intent durable *before* the ref transaction it authorises.
 */
export function writeAtomic(p, content, { fs = REAL_FS } = {}) {
  const dir = ensureDir(dirname(p));
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
  try {
    const dfd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* a platform that refuses to open a directory for reading; the file fsync above stands */ }
}
export const writeJsonAtomic = (p, obj) => writeAtomic(p, JSON.stringify(obj, null, 2) + "\n");

export function appendLine(p, line) { ensureDir(dirname(p)); appendFileSync(p, line.endsWith("\n") ? line : line + "\n"); }

export function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

/** Digest of a directory: sha256 over "relpath\0sha256(file)\n" for every file, sorted. */
export function digestDir(dir) {
  const files = [];
  (function walk(d, rel) {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r); else if (e.isFile()) files.push([r, p]);
    }
  })(dir, "");
  const h = createHash("sha256");
  let bytes = 0;
  for (const [r, p] of files) { h.update(`${r}\0${sha256File(p)}\n`); bytes += statSync(p).size; }
  return { sha256: h.digest("hex"), bytes, files: files.length };
}

export function symlinkForce(target, link) {
  try { if (lstatSync(link)) unlinkSync(link); } catch { /* absent */ }
  symlinkSync(target, link);
}

export const rmrf = (p) => rmSync(p, { recursive: true, force: true });

const readLockFile = (lock) => { try { return readFileSync(lock, "utf8"); } catch { return null; } };

/**
 * Break a stale lock and take it away in one operation: rename it to a per-pid name, and count the
 * break only if the rename succeeded *and* the bytes it carried away are the bytes we judged stale.
 * A rename that fails means another process broke it first (retry the create); bytes that differ
 * mean a live holder replaced the file between our check and our break, so we put it back and
 * refuse rather than run beside it.
 */
function breakStaleLock(lock, holder) {
  const stash = `${lock}.stale.${process.pid}.${Date.now()}`;
  try { renameSync(lock, stash); } catch { return; }
  const taken = readLockFile(stash);
  if (taken === holder) { try { unlinkSync(stash); } catch { /* gone */ } return; }
  let restored = false;
  if (!existsSync(lock)) { try { renameSync(stash, lock); restored = true; } catch { /* the holder re-created it */ } }
  if (!restored) { try { unlinkSync(stash); } catch { /* gone */ } }
  throw new RalphError(`lock ${lock} was replaced between the staleness check and the break; refusing to break a live lock`);
}

/**
 * The one lock (RUNNER-SPEC §1): <root>/.locks/ralph, O_EXCL create, stale-holder recovery by
 * identity rather than by path. The file carries a random token; the token is re-read after
 * acquisition (a breaker that took the lock from us in between aborts here instead of running a
 * second critical section) and the release deletes the file only while it still carries our token.
 * `hooks.beforeBreak` / `hooks.afterCreate` are the two interleaving points the conformance suite
 * drives a concurrent breaker through; nothing in the runner passes them.
 */
export function withLock(root, fn, { timeoutMs = 30_000, hooks = {} } = {}) {
  const dir = ensureDir(resolve(root, ".locks"));
  const lock = resolve(dir, "ralph");
  const mine = `${process.pid} ${now()} ${randomBytes(16).toString("hex")}\n`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try { writeSync(fd, mine); } finally { closeSync(fd); }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const holder = readLockFile(lock);
      if (holder === null) continue; // released under us; try the create again
      const pid = Number(holder.split(" ")[0]);
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === "EPERM"; } }
      if (alive) {
        if (Date.now() - start > timeoutMs) throw new RalphError(`lock ${lock} held by pid ${pid}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        continue;
      }
      hooks.beforeBreak?.({ lock, holder });
      breakStaleLock(lock, holder);
      continue;
    }
    hooks.afterCreate?.({ lock, token: mine });
    if (readLockFile(lock) !== mine) throw new RalphError(`lock ${lock} does not carry our token after acquisition (another process broke it); refusing to run`);
    break;
  }
  try { return fn(); } finally { if (readLockFile(lock) === mine) { try { unlinkSync(lock); } catch { /* gone */ } } }
}

export function firstLine(s, max = 72) {
  const l = (s ?? "").split(/\.(?=\s|$)|\n/)[0].trim(); // first sentence: a period followed by whitespace, not one inside a path
  return l.length > max ? l.slice(0, max - 1) + "…" : l;
}
