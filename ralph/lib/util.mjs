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
 * The state layer's audit log (`state/audit.log`), named by the `Ctx` constructor. `writeAtomic`
 * lives below the state layer but its durability failures belong in the same append-only record,
 * so the path is handed down rather than re-derived here.
 */
let auditLog = null;
export function setAuditLog(p) { auditLog = p; }

/** Append one timestamped line to the state audit log; stderr while no audit log has been named. */
export function auditNote(line) {
  if (auditLog) { try { appendLine(auditLog, `${now()} ${line}`); return; } catch { /* fall through to stderr */ } }
  process.stderr.write(`[ralph] ${line}\n`);
}

/**
 * write-temp-then-rename, fsync'd (RUNNER-SPEC §1). The order is
 * write → fsync(fd) → close → rename → fsync(dir): the bytes reach the disk before the rename
 * publishes them, and the directory entry the rename created reaches the disk before we return,
 * because §8.4 needs the close intent durable *before* the ref transaction it authorises.
 *
 * The directory sync is best effort — a platform may refuse to open a directory for reading, or a
 * filesystem may refuse to sync one — but it is never silent (DECISIONS #review-0-r1 G5): on any
 * failure the call records `writeAtomic: directory fsync failed <path> <code>` in the audit log and
 * continues, so a close intent published without directory durability leaves a trace. `<path>` is
 * the file this call published (the directory is its parent); the file fsync above still stands.
 */
export function writeAtomic(p, content, { fs = REAL_FS, audit = auditNote } = {}) {
  const dir = ensureDir(dirname(p));
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
  try {
    const dfd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch (e) { audit(`writeAtomic: directory fsync failed ${p} ${e.code ?? e.message}`); }
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

/** The one lock's path under a root (RUNNER-SPEC §1). */
export const lockPath = (root) => resolve(root, ".locks", "ralph");

/** A pid is alive when we can signal it, or when the OS says we may not (EPERM = it exists). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * The lock's current holder: `{lock, pid, alive}`, or `null` while the path is free. `pid` is null
 * when the file does not open with a pid, and such a lock counts as held by something we cannot
 * identify — fail closed, because inventing a holder is how a live lock gets broken.
 */
export function lockHolder(root) {
  const lock = lockPath(root);
  const text = readLockFile(lock);
  if (text === null) return null;
  const pid = Number(text.split(" ")[0]);
  const known = Number.isInteger(pid) && pid > 0;
  return { lock, pid: known ? pid : null, alive: known && pidAlive(pid) };
}

/**
 * The one repair for a lock whose holder is gone. `withLock` and `doctor` both quote this sentence,
 * so the refusal and the drift report can never describe different procedures.
 */
export const staleLockRepair = (lock) => `manual repair: confirm with pgrep -fl 'ralph.sh|gate.sh' that no ralph.sh, gate.sh or admin process is running, then remove ${lock} by hand`;

/**
 * The one lock (RUNNER-SPEC §1): <root>/.locks/ralph, created with O_EXCL. The file carries
 * `<pid> <iso> <16 random bytes as hex>`; the token is re-read after acquisition (a process that
 * took the path from us in between aborts here instead of running a second critical section) and
 * the release deletes the file only while it still carries our token. **The runner only ever
 * removes a lock it created itself.**
 *
 * A lock is never broken automatically (DECISIONS #review-0-r1 G4). Automatic recovery needs a
 * check ("this holder's pid is dead") and a destructive step (unlink, or rename-then-compare), and
 * no ordering of those two preserves exclusion: the destructive step frees the path for an instant
 * during which a live holder may already own it, and a third entrant creates it and runs beside
 * that holder — Sol's probe in review r1 caught exactly that. There is no primitive here that
 * closes the window, so the feature is cut to a manual procedure: a lock whose holder pid is not
 * running makes this function throw, naming the file, the dead pid and the recovery, and
 * `ralph.sh doctor` reports the same lock as `stale-lock <pid>` with the same repair.
 *
 * `hooks.afterCreate` is the one interleaving point the conformance suite drives a second actor
 * through; nothing in the runner passes it.
 */
export function withLock(root, fn, { timeoutMs = 30_000, hooks = {} } = {}) {
  const lock = lockPath(root);
  ensureDir(dirname(lock));
  const mine = `${process.pid} ${now()} ${randomBytes(16).toString("hex")}\n`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try { writeSync(fd, mine); } finally { closeSync(fd); }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = lockHolder(root);
      if (held === null) continue; // released under us; try the create again
      if (!held.alive) throw new RalphError(`lock ${lock} is held by pid ${held.pid ?? "unknown"}, which is not running; the runner never breaks a lock it did not create — ${staleLockRepair(lock)}`);
      if (Date.now() - start > timeoutMs) throw new RalphError(`lock ${lock} held by pid ${held.pid}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      continue;
    }
    hooks.afterCreate?.({ lock, token: mine });
    if (readLockFile(lock) !== mine) throw new RalphError(`lock ${lock} does not carry our token after acquisition (another process took it); refusing to run`);
    break;
  }
  try { return fn(); } finally { if (readLockFile(lock) === mine) { try { unlinkSync(lock); } catch { /* gone */ } } }
}

export function firstLine(s, max = 72) {
  const l = (s ?? "").split(/\.(?=\s|$)|\n/)[0].trim(); // first sentence: a period followed by whitespace, not one inside a path
  return l.length > max ? l.slice(0, max - 1) + "…" : l;
}
