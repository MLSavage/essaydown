// util.mjs — shell, git, atomic files, lock (RUNNER-SPEC §1 "write-temp-then-rename", one lock).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, writeSync, appendFileSync, readdirSync, statSync, symlinkSync, lstatSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createHash } from "node:crypto";

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

/** write-temp-then-rename; fsync'd. */
export function writeAtomic(p, content) {
  ensureDir(dirname(p));
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, "w");
  try { writeSync(fd, content); } finally { closeSync(fd); }
  renameSync(tmp, p);
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

/** The one lock (RUNNER-SPEC §1): <root>/.locks/ralph, O_EXCL create, stale-pid recovery. */
export function withLock(root, fn, { timeoutMs = 30_000 } = {}) {
  const dir = ensureDir(resolve(root, ".locks"));
  const lock = resolve(dir, "ralph");
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, `${process.pid} ${now()}\n`);
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = "";
      try { holder = readFileSync(lock, "utf8"); } catch { /* raced */ }
      const pid = Number(holder.split(" ")[0]);
      let alive = false;
      if (pid) { try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === "EPERM"; } }
      if (!alive) { try { unlinkSync(lock); } catch { /* raced */ } continue; }
      if (Date.now() - start > timeoutMs) throw new RalphError(`lock ${lock} held by pid ${pid}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* gone */ } }
}

export function firstLine(s, max = 72) {
  const l = (s ?? "").split(/\.(?=\s|$)|\n/)[0].trim(); // first sentence: a period followed by whitespace, not one inside a path
  return l.length > max ? l.slice(0, max - 1) + "…" : l;
}
