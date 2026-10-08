#!/usr/bin/env node
// fetch-sidecars.ts — task 4.1 (dev-only aarch64 Linux entries added by 4.2's clean-checkout
// repair). Downloads the archives scripts/sidecars.lock.json names (exact pandoc and typst
// release URLs and SHA-256s), verifies each against its locked checksum, and extracts one
// pre-lipo binary/slice/dev artifact per archive into scripts/.cache/sidecars/ (gitignored; task
// 4.2's `lipo -create` combines the four macOS slices, and nothing here writes under
// src-tauri/binaries/). Every downloaded archive is re-verified by its own checksum before
// extraction, so a tampered or corrupted lock entry aborts with a non-zero exit before anything
// is written to the output directory. The CLI entrypoint also refuses before any of that if the
// lock's own pandocVersion/typstVersion disagree with docker/versions.env (assertLockVersionsMatch).
//
// pandoc's two macOS archives are Apple installer `.pkg` files rather than tarballs (pandoc ships
// no macOS tarball with the Linux build's `bin/` layout): a `.pkg` is a xar archive whose Payload
// member is a gzip-compressed cpio (odc) archive. extractPkgPayloadMember below is a from-scratch
// reader for both container formats — no `xar`/`cpio` binary is installed in this image (checked
// during this task; apt only has unzip/xz-utils/tar for the other six archives) and no npm package
// is a declared dependency for it.
//
// Host portability (task 4.11, after the 4.2h gate's macOS and Windows test jobs): every external
// command goes through an injected `Runner` (default `spawnSync`), every chmod through
// `makeExecutable` (a no-op on win32), and the platform is a parameter, so the unit tests drive the
// win32/darwin routes from this Linux container without a host tool. Tarballs reach `tar` as bytes
// on stdin (`-f -`), never as a path, because the `tar` first on PATH on a Windows runner is Git for
// Windows' GNU tar, which reads `C:` in `-f C:\…` as a remote host. Windows has no `unzip`, so a zip
// member on win32 is read by `%SystemRoot%\System32\tar.exe` (bsdtar/libarchive, which reads zip
// and drive-letter paths) by its absolute path, never by a `tar` from PATH.
import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, inflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface SidecarArtifact {
  target: string;
  tool: string;
  kind: "binary" | "slice" | "dev";
  url: string;
  sha256: string;
  format: "tar.gz" | "tar.xz" | "zip" | "pkg";
  member: string;
  component?: string[];
}

export interface SidecarLock {
  pandocVersion?: string;
  typstVersion?: string;
  artifacts: SidecarArtifact[];
}

/** Runs one external command to completion; the only route by which these scripts reach a host
 * binary, so a test can stand in for `tar`, `unzip`, `lipo` or a sidecar's `--version`. */
export type Runner = (
  cmd: string,
  args: string[],
  opts?: { input?: Buffer },
) => Pick<SpawnSyncReturns<Buffer>, "status" | "stdout" | "stderr" | "error">;

export const defaultRunner: Runner = (cmd, args, opts) =>
  spawnSync(cmd, args, { maxBuffer: 1024 * 1024 * 1024, input: opts?.input });

/** True when the module at `importMetaUrl` is the script node was asked to run (`argv1`). The
 * comparison goes through `pathToFileURL` so a Windows `C:\…` path and a path with a space (both
 * percent- or slash-encoded in `import.meta.url`) still match. */
export function isMainModule(
  importMetaUrl: string,
  argv1: string | undefined,
  windows: boolean = process.platform === "win32",
): boolean {
  if (!argv1) return false;
  return importMetaUrl === pathToFileURL(argv1, { windows }).href;
}

/** Marks `path` executable (0o755) off Windows; on win32 there is no mode bit to set and
 * executability comes from the `.exe` name, so this does nothing there. */
export function makeExecutable(
  path: string,
  platform: NodeJS.Platform = process.platform,
  chmod: (path: string, mode: number) => void = chmodSync,
): void {
  if (platform === "win32") return;
  chmod(path, 0o755);
}

/** Windows' own bsdtar, by absolute path (`%SystemRoot%\System32\tar.exe`). */
export function windowsTarPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status} ${res.statusText}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Downloads `artifact.url` (or reuses a cached copy already verified at `cacheDir` from a prior
 * run) and throws before anything else runs if the bytes don't match `artifact.sha256` — this is
 * the one checkpoint a tampered lock entry or a corrupted transfer cannot get past. */
export async function fetchAndVerify(artifact: SidecarArtifact, cacheDir: string): Promise<Buffer> {
  const cachePath = join(cacheDir, `${artifact.target}.download`);
  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath);
    if (sha256(cached) === artifact.sha256) return cached;
  }
  const downloaded = await downloadBuffer(artifact.url);
  const digest = sha256(downloaded);
  if (digest !== artifact.sha256) {
    throw new Error(
      `checksum mismatch for ${artifact.target}: expected ${artifact.sha256}, got ${digest} (${artifact.url})`,
    );
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, downloaded);
  return downloaded;
}

function runCapture(runner: Runner, cmd: string, args: string[], input?: Buffer): Buffer {
  const r = runner(cmd, args, input ? { input } : undefined);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}: ${r.stderr.toString("utf8")}`);
  }
  return r.stdout as Buffer;
}

// --- xar (Apple installer .pkg) + cpio (odc) reading, for pandoc's two macOS slices ---------------

interface XmlElement {
  tag: string;
  children: (XmlElement | string)[];
}

/** A minimal non-validating XML parser: tags, nested elements and text nodes only (no attribute
 * values are read — the xar TOC fields this script needs, <name>/<offset>/<length>/<encoding>, are
 * all element text, and the gzip check below reads the heap bytes' own magic instead of trusting
 * the <encoding style="..."> attribute). Good enough for xar's own TOC grammar; not a general
 * XML reader. */
function parseXml(xml: string): XmlElement {
  const root: XmlElement = { tag: "#root", children: [] };
  const stack: XmlElement[] = [root];
  const token = /<\?[^?]*\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z0-9_:.-]+)[^>]*?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(xml))) {
    const [, closing, tag, selfClose, text] = m;
    if (text !== undefined) {
      if (text.trim().length > 0) stack[stack.length - 1].children.push(text);
      continue;
    }
    if (!tag) continue;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const element: XmlElement = { tag, children: [] };
    stack[stack.length - 1].children.push(element);
    if (!selfClose) stack.push(element);
  }
  return root;
}

function childElement(node: XmlElement, tag: string): XmlElement | undefined {
  return node.children.find((c): c is XmlElement => typeof c !== "string" && c.tag === tag);
}

function childElements(node: XmlElement, tag: string): XmlElement[] {
  return node.children.filter((c): c is XmlElement => typeof c !== "string" && c.tag === tag);
}

function childText(node: XmlElement, tag: string): string | undefined {
  const child = childElement(node, tag);
  const text = child?.children.find((c) => typeof c === "string");
  return typeof text === "string" ? text.trim() : undefined;
}

/** Walks a xar TOC's `<file>` tree (each level's children, keyed by their own `<name>`) to the
 * node at `pathParts`, e.g. `["pandoc.pkg", "Payload"]`. */
function findXarMember(tocXml: string, pathParts: string[]): XmlElement | undefined {
  const toc = childElement(childElement(parseXml(tocXml), "xar") as XmlElement, "toc");
  let level = toc ? childElements(toc, "file") : [];
  let found: XmlElement | undefined;
  for (const part of pathParts) {
    found = level.find((f) => childText(f, "name") === part);
    if (!found) return undefined;
    level = childElements(found, "file");
  }
  return found;
}

function parseXarToc(buf: Buffer): { heapStart: number; tocXml: string } {
  if (buf.toString("ascii", 0, 4) !== "xar!") throw new Error("not a xar archive (bad magic)");
  const headerSize = buf.readUInt16BE(4);
  const tocCompressedLen = Number(buf.readBigUInt64BE(8));
  const tocCompressed = buf.subarray(headerSize, headerSize + tocCompressedLen);
  return {
    heapStart: headerSize + tocCompressedLen,
    tocXml: inflateSync(tocCompressed).toString("utf8"),
  };
}

/** Reads one member's bytes out of a xar heap. xar's own `<encoding>` can wrap the slice in zlib
 * gzip (true for every member here except Payload); Payload's bytes are themselves a gzip stream
 * regardless of xar's own encoding (Apple's installer format double-wraps it), so this checks the
 * gzip magic on the result and unwraps again rather than trusting which layer the TOC claims. */
function readXarHeapMember(buf: Buffer, heapStart: number, fileNode: XmlElement): Buffer {
  const data = childElement(fileNode, "data");
  if (!data) throw new Error("xar file entry has no <data>");
  const offset = Number(childText(data, "offset"));
  const length = Number(childText(data, "length"));
  let bytes: Buffer = buf.subarray(heapStart + offset, heapStart + offset + length);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  return bytes;
}

/** cpio's old character ("odc") format: a 76-byte all-octal-ASCII header per entry (magic
 * "070707"), the name (namesize bytes, NUL-terminated), then the file's data; a "TRAILER!!!" name
 * ends the archive. Zero-width note: namesize counts the trailing NUL, so the name text itself is
 * `namesize - 1` bytes — this reader is never asked for a zero-length name, so that edge is untested
 * here on purpose (CLAUDE.md's zero-width-slice rule governs the general case, not this one leaf). */
function readCpioOdcMember(cpio: Buffer, memberName: string): Buffer {
  let pos = 0;
  while (pos < cpio.length) {
    const magic = cpio.toString("ascii", pos, pos + 6);
    if (magic !== "070707")
      throw new Error(`unexpected cpio header at byte ${pos}: ${JSON.stringify(magic)}`);
    const fields = cpio.toString("ascii", pos + 6, pos + 76);
    const namesize = parseInt(fields.slice(53, 59), 8);
    const filesize = parseInt(fields.slice(59, 70), 8);
    const nameStart = pos + 76;
    const name = cpio.toString("ascii", nameStart, nameStart + namesize - 1);
    const dataStart = nameStart + namesize;
    if (name === "TRAILER!!!") break;
    if (name === memberName) return cpio.subarray(dataStart, dataStart + filesize);
    pos = dataStart + filesize;
  }
  throw new Error(`cpio archive has no member ${JSON.stringify(memberName)}`);
}

export function extractPkgPayloadMember(
  pkgBuf: Buffer,
  component: string[],
  memberName: string,
): Buffer {
  const { heapStart, tocXml } = parseXarToc(pkgBuf);
  const payloadNode = findXarMember(tocXml, [...component, "Payload"]);
  if (!payloadNode) throw new Error(`no Payload at ${[...component, "Payload"].join("/")}`);
  const cpio = readXarHeapMember(pkgBuf, heapStart, payloadNode);
  return readCpioOdcMember(cpio, memberName);
}

// --- per-format extraction -------------------------------------------------------------------------

export function extractMember(
  archive: Buffer,
  archivePath: string,
  artifact: SidecarArtifact,
  runner: Runner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Buffer {
  switch (artifact.format) {
    case "tar.gz":
      return runCapture(runner, "tar", ["-xzO", "-f", "-", artifact.member], archive);
    case "tar.xz":
      return runCapture(runner, "tar", ["-xJO", "-f", "-", artifact.member], archive);
    case "zip":
      if (platform === "win32") {
        return runCapture(runner, windowsTarPath(), ["-xOf", archivePath, artifact.member]);
      }
      return runCapture(runner, "unzip", ["-p", archivePath, artifact.member]);
    case "pkg":
      return extractPkgPayloadMember(archive, artifact.component ?? [], artifact.member);
  }
}

// --- orchestration -----------------------------------------------------------------------------

export function loadLockFile(lockPath: string): SidecarLock {
  return JSON.parse(readFileSync(lockPath, "utf8")) as SidecarLock;
}

export function loadLock(lockPath: string): SidecarArtifact[] {
  return loadLockFile(lockPath).artifacts;
}

/** Reads `NAME=value` lines out of docker/versions.env (ignoring comments/blank lines). */
export function readVersionsEnv(versionsEnvPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(versionsEnvPath, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Refuses when the lock's own `pandocVersion`/`typstVersion` disagree with docker/versions.env's
 * `PANDOC_VERSION`/`TYPST_VERSION` — the lock's release URLs are hand-pinned to those versions, so
 * a version bumped in one place and not the other would otherwise fetch the wrong release
 * silently. A lock missing either field (every lock built by this file's own tests, which care
 * about other things) skips that field's check rather than failing on an unrelated fixture. */
export function assertLockVersionsMatch(lock: SidecarLock, versionsEnvPath: string): void {
  const env = readVersionsEnv(versionsEnvPath);
  if (lock.pandocVersion !== undefined && lock.pandocVersion !== env.PANDOC_VERSION) {
    throw new Error(
      `sidecars.lock.json pandocVersion (${lock.pandocVersion}) does not match docker/versions.env PANDOC_VERSION (${env.PANDOC_VERSION})`,
    );
  }
  if (lock.typstVersion !== undefined && lock.typstVersion !== env.TYPST_VERSION) {
    throw new Error(
      `sidecars.lock.json typstVersion (${lock.typstVersion}) does not match docker/versions.env TYPST_VERSION (${env.TYPST_VERSION})`,
    );
  }
}

export async function fetchSidecars(opts: {
  lockPath: string;
  outDir: string;
  runner?: Runner;
  platform?: NodeJS.Platform;
}): Promise<SidecarArtifact[]> {
  const artifacts = loadLock(opts.lockPath);
  const cacheDir = join(opts.outDir, ".downloads");
  mkdirSync(opts.outDir, { recursive: true });
  for (const artifact of artifacts) {
    const archive = await fetchAndVerify(artifact, cacheDir);
    const archivePath = join(cacheDir, `${artifact.target}.download`);
    const member = extractMember(archive, archivePath, artifact, opts.runner, opts.platform);
    const destPath = join(opts.outDir, artifact.target);
    writeFileSync(destPath, member);
    makeExecutable(destPath, opts.platform);
  }
  return artifacts;
}

/** The Rust/Tauri target triple this process's own OS+arch would be named under in
 * scripts/sidecars.lock.json — the artifact `verifyHostBinaries` runs `--version` against. */
export function hostTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (platform === "linux") return "x86_64-unknown-linux-gnu";
  if (platform === "darwin")
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (platform === "win32") return "x86_64-pc-windows-msvc";
  return undefined;
}

/** Runs `pandoc --version` and `typst --version` against whichever extracted artifact matches this
 * host's own target triple (the acceptance's "host OS's binary or slice"); a macOS host before 4.2's
 * `lipo` still has its own single-arch slice to run, same as the two platforms with one binary. */
export function verifyHostBinaries(
  outDir: string,
  artifacts: SidecarArtifact[],
  runner: Runner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  const triple = hostTargetTriple(platform, arch);
  if (!triple) throw new Error(`unsupported host platform for a sidecar check: ${platform}`);
  const target = (tool: string) => `${tool}-${triple}${platform === "win32" ? ".exe" : ""}`;
  const summaries: string[] = [];
  for (const tool of ["pandoc", "typst"] as const) {
    const artifact = artifacts.find((a) => a.tool === tool && a.target === target(tool));
    if (!artifact) throw new Error(`no locked ${tool} artifact for host triple ${triple}`);
    const binPath = join(outDir, artifact.target);
    const r = runner(binPath, ["--version"]);
    const stdout = r.stdout?.toString("utf8") ?? "";
    if (r.status !== 0 || !stdout.toLowerCase().includes(tool)) {
      throw new Error(
        `${binPath} --version failed (status ${r.status}): ${r.error?.message ?? r.stderr?.toString("utf8")}`,
      );
    }
    summaries.push(stdout.split("\n")[0]);
  }
  return summaries;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  const lockPath = flag("--lock", join(HERE, "sidecars.lock.json"));
  const outDir = flag("--out", join(HERE, ".cache/sidecars"));
  const versionsEnvPath = flag("--versions-env", join(HERE, "..", "docker/versions.env"));
  assertLockVersionsMatch(loadLockFile(lockPath), versionsEnvPath);
  const artifacts = await fetchSidecars({ lockPath, outDir });
  const binaries = artifacts.filter((a) => a.kind === "binary").length;
  const slices = artifacts.filter((a) => a.kind === "slice").length;
  const dev = artifacts.filter((a) => a.kind === "dev").length;
  console.log(
    `fetch-sidecars: ${artifacts.length} verified artifacts in ${outDir} (${binaries} platform binaries + ${slices} macOS slices + ${dev} dev-only entries)`,
  );
  for (const summary of verifyHostBinaries(outDir, artifacts))
    console.log(`fetch-sidecars: ${summary}`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(`fetch-sidecars: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
