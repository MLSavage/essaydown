// assemble-sidecars.test.ts — task 4.2; host-portable since task 4.11. Offline: a scratch "cache"
// dir stands in for scripts/.cache/sidecars/ (already populated as if `pnpm fetch-sidecars` ran),
// and a fake `Runner` stands in for `lipo` (writing the -output file, failing with ENOENT, or
// exiting non-zero), so no test puts a `lipo` on PATH or runs the host's own — at the 4.2h gate the
// macOS `test` job ran Xcode's real lipo on these fake bytes and failed.
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleSidecars, lipoCreate } from "../scripts/assemble-sidecars.ts";
import { loadLock, type Runner } from "../scripts/fetch-sidecars.ts";

const lockPath = join(import.meta.dirname, "..", "scripts", "sidecars.lock.json");

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "assemble-sidecars-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Populates a scratch cache dir with one fake file per locked artifact, each containing distinct
 * bytes naming the artifact, standing in for fetch-sidecars' real extracted binaries/slices. */
function fakeCache(): string {
  const cacheDir = scratch();
  for (const artifact of loadLock(lockPath)) {
    writeFileSync(join(cacheDir, artifact.target), `fake-binary:${artifact.target}`);
  }
  return cacheDir;
}

/** A fake `lipo` runner: records each argv and writes `lipo-combined` to the `-output` path, so
 * the tests assert the exact invocation shape without a real Mach-O combiner. */
function fakeLipo(): { runner: Runner; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: Runner = (cmd, args) => {
    calls.push({ cmd, args });
    writeFileSync(args[args.indexOf("-output") + 1], "lipo-combined");
    return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  return { runner, calls };
}

/** `lipo` absent: the runner fails the way spawnSync does for a command not on PATH. */
const lipoNotFound: Runner = () => ({
  status: null,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  error: Object.assign(new Error("spawnSync lipo ENOENT"), { code: "ENOENT" }),
});

/** The mode-bit assertion is meaningful only off Windows (win32 has no executable bit; the
 * scripts' `makeExecutable` is a no-op there), so the platform is a parameter. */
function expectExecutable(path: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  expect(statSync(path).mode & 0o111).not.toBe(0);
}

function assembleWithFakeLipo(cacheDir: string, outDir: string) {
  return assembleSidecars({ lockPath, cacheDir, outDir, runner: fakeLipo().runner });
}

describe("assembleSidecars", () => {
  it("copies all 4 platform binaries through unchanged and executable", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    assembleWithFakeLipo(cacheDir, outDir);
    const binaries = loadLock(lockPath).filter((a) => a.kind === "binary");
    expect(binaries).toHaveLength(4);
    for (const artifact of binaries) {
      const dest = join(outDir, artifact.target);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, "utf8")).toBe(`fake-binary:${artifact.target}`);
      expectExecutable(dest);
    }
  });

  it("writes pandoc-universal-apple-darwin and typst-universal-apple-darwin from the lipo runner, nothing under a slices directory", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    const { runner, calls } = fakeLipo();
    const results = assembleSidecars({ lockPath, cacheDir, outDir, runner });
    expect(results.map((r) => r.usedRealLipo)).toEqual([true, true]);
    expect(calls.map((c) => c.cmd)).toEqual(["lipo", "lipo"]);
    expect(readFileSync(join(outDir, "pandoc-universal-apple-darwin"), "utf8")).toBe(
      "lipo-combined",
    );
    expect(readFileSync(join(outDir, "typst-universal-apple-darwin"), "utf8")).toBe(
      "lipo-combined",
    );
    expect(existsSync(join(outDir, "slices"))).toBe(false);
  });

  it("copies the dev-only aarch64 Linux entries into outDir too, real bytes and executable", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    assembleWithFakeLipo(cacheDir, outDir);
    const devArtifacts = loadLock(lockPath).filter((a) => a.kind === "dev");
    expect(devArtifacts).toHaveLength(2);
    for (const artifact of devArtifacts) {
      const dest = join(outDir, artifact.target);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, "utf8")).toBe(`fake-binary:${artifact.target}`);
      expectExecutable(dest);
    }
  });

  it("slice copies: the 4 macOS slices are present under their own target names, unchanged and executable", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    assembleWithFakeLipo(cacheDir, outDir);
    const slices = loadLock(lockPath).filter((a) => a.kind === "slice");
    expect(slices.map((a) => a.target).sort()).toEqual([
      "pandoc-aarch64-apple-darwin",
      "pandoc-x86_64-apple-darwin",
      "typst-aarch64-apple-darwin",
      "typst-x86_64-apple-darwin",
    ]);
    for (const artifact of slices) {
      const dest = join(outDir, artifact.target);
      expect(readFileSync(dest, "utf8")).toBe(`fake-binary:${artifact.target}`);
      expectExecutable(dest);
    }
  });

  it("the 6 shipped distributables are the 4 platform binaries plus the 2 universal macOS files, never the 2 dev entries or the 4 slice copies", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    assembleWithFakeLipo(cacheDir, outDir);
    const allFiles = new Set(readdirSync(outDir));
    const devArtifacts = loadLock(lockPath).filter((a) => a.kind === "dev" || a.kind === "slice");
    const devTargets = devArtifacts.map((a) => a.target);
    expect(devTargets).toHaveLength(6);
    for (const target of devTargets) expect(allFiles.has(target)).toBe(true);
    const shipped = [...allFiles].filter((f) => !devTargets.includes(f)).sort();
    const expected = [
      ...loadLock(lockPath)
        .filter((a) => a.kind === "binary")
        .map((a) => a.target),
      "pandoc-universal-apple-darwin",
      "typst-universal-apple-darwin",
    ].sort();
    expect(shipped).toEqual(expected);
    expect(shipped).toHaveLength(6);
  });

  it("throws naming the missing artifact when fetch-sidecars has not run", () => {
    const cacheDir = scratch();
    const outDir = scratch();
    expect(() => assembleWithFakeLipo(cacheDir, outDir)).toThrow(/pnpm fetch-sidecars/);
  });
});

describe("lipoCreate", () => {
  function pandocSlices(cacheDir: string): [string, string] {
    return loadLock(lockPath)
      .filter((a) => a.kind === "slice" && a.tool === "pandoc")
      .map((a) => join(cacheDir, a.target)) as [string, string];
  }

  it("lipo real: runs lipo -create <a> <b> -output <out> through the runner and reports usedRealLipo", () => {
    const cacheDir = fakeCache();
    const outPath = join(scratch(), "pandoc-universal-apple-darwin");
    const slices = pandocSlices(cacheDir);
    const { runner, calls } = fakeLipo();
    const result = lipoCreate("pandoc", slices, outPath, runner);
    expect(result.usedRealLipo).toBe(true);
    expect(calls).toEqual([
      { cmd: "lipo", args: ["-create", slices[0], slices[1], "-output", outPath] },
    ]);
    expect(readFileSync(outPath, "utf8")).toBe("lipo-combined");
    expectExecutable(outPath);
  });

  it("lipo ENOENT stand-in: writes the first slice's bytes, executable, when lipo is not found", () => {
    const cacheDir = fakeCache();
    const outPath = join(scratch(), "typst-universal-apple-darwin");
    const slices = loadLock(lockPath)
      .filter((a) => a.kind === "slice" && a.tool === "typst")
      .map((a) => join(cacheDir, a.target)) as [string, string];
    const result = lipoCreate("typst", slices, outPath, lipoNotFound);
    expect(result.usedRealLipo).toBe(false);
    expect(readFileSync(outPath, "utf8")).toBe(readFileSync(slices[0], "utf8"));
    expectExecutable(outPath);
  });

  it("lipo non-zero throws: a real lipo that exits non-zero is never swallowed into the stand-in", () => {
    const cacheDir = fakeCache();
    const outPath = join(scratch(), "pandoc-universal-apple-darwin");
    const failing: Runner = () => ({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("fatal error: can't figure out the architecture type"),
    });
    expect(() => lipoCreate("pandoc", pandocSlices(cacheDir), outPath, failing)).toThrow(
      /lipo -create .* exited 1: fatal error/,
    );
    expect(existsSync(outPath)).toBe(false);
  });

  it("lipo spawn error other than ENOENT is rethrown, not swallowed into the stand-in", () => {
    const cacheDir = fakeCache();
    const outPath = join(scratch(), "pandoc-universal-apple-darwin");
    const eacces: Runner = () => ({
      status: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      error: Object.assign(new Error("spawnSync lipo EACCES"), { code: "EACCES" }),
    });
    expect(() => lipoCreate("pandoc", pandocSlices(cacheDir), outPath, eacces)).toThrow(/EACCES/);
    expect(existsSync(outPath)).toBe(false);
  });
});
