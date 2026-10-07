// assemble-sidecars.test.ts — task 4.2. Offline: a scratch "cache" dir stands in for
// scripts/.cache/sidecars/ (already populated as if `pnpm fetch-sidecars` ran), and a scratch
// "bin" dir stands in for PATH to control whether `lipo` is found, so both the real-lipo branch
// and the no-lipo stand-in branch run deterministically regardless of this container's own
// platform (it has neither `lipo` nor `llvm-lipo`, checked during this task).
import {
  chmodSync,
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
import { loadLock } from "../scripts/fetch-sidecars.ts";

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

/** A fake `lipo` on PATH: writes a file recording its own argv, so the test can assert the exact
 * invocation shape without a real Mach-O combiner. */
function fakeLipoOnPath(): { dir: string; invocationLog: string } {
  const dir = scratch();
  const invocationLog = join(dir, "lipo.invocations");
  const script = join(dir, "lipo");
  writeFileSync(
    script,
    `#!/bin/sh\necho "$@" >> "${invocationLog}"\nout=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-output" ]; then shift; out="$1"; fi\n  shift\ndone\nprintf 'lipo-combined' > "$out"\n`,
  );
  chmodSync(script, 0o755);
  writeFileSync(invocationLog, "");
  return { dir, invocationLog };
}

describe("assembleSidecars", () => {
  it("copies all 4 platform binaries through unchanged and executable", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    assembleSidecars({ lockPath, cacheDir, outDir });
    for (const artifact of loadLock(lockPath).filter((a) => a.kind === "binary")) {
      const dest = join(outDir, artifact.target);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, "utf8")).toBe(`fake-binary:${artifact.target}`);
      expect(fakeModeIsExecutable(dest)).toBe(true);
    }
  });

  it("writes exactly pandoc-universal-apple-darwin and typst-universal-apple-darwin, nothing else under a slices directory", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    assembleSidecars({ lockPath, cacheDir, outDir });
    expect(existsSync(join(outDir, "pandoc-universal-apple-darwin"))).toBe(true);
    expect(existsSync(join(outDir, "typst-universal-apple-darwin"))).toBe(true);
    expect(existsSync(join(outDir, "slices"))).toBe(false);
  });

  it("copies the dev-only aarch64 Linux entries into outDir too, real bytes and executable", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    assembleSidecars({ lockPath, cacheDir, outDir });
    const devArtifacts = loadLock(lockPath).filter((a) => a.kind === "dev");
    expect(devArtifacts).toHaveLength(2);
    for (const artifact of devArtifacts) {
      const dest = join(outDir, artifact.target);
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest, "utf8")).toBe(`fake-binary:${artifact.target}`);
      expect(fakeModeIsExecutable(dest)).toBe(true);
    }
  });

  it("the 6 shipped distributables are the 4 platform binaries plus the 2 universal macOS files, never the 2 dev entries", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    assembleSidecars({ lockPath, cacheDir, outDir });
    const allFiles = new Set(readdirSync(outDir));
    const devTargets = loadLock(lockPath)
      .filter((a) => a.kind === "dev")
      .map((a) => a.target);
    for (const target of devTargets) expect(allFiles.has(target)).toBe(true);
    const shipped = [...allFiles].filter((f) => !devTargets.includes(f));
    expect(shipped).toHaveLength(6);
  });

  it("throws naming the missing artifact when fetch-sidecars has not run", () => {
    const cacheDir = scratch();
    const outDir = scratch();
    expect(() => assembleSidecars({ lockPath, cacheDir, outDir })).toThrow(/pnpm fetch-sidecars/);
  });
});

describe("lipoCreate", () => {
  it("runs the real lipo -create <a> <b> -output <out> invocation when lipo is on PATH", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    const { dir: lipoDir, invocationLog } = fakeLipoOnPath();
    const originalPath = process.env.PATH;
    process.env.PATH = `${lipoDir}:${originalPath}`;
    try {
      const artifacts = loadLock(lockPath).filter((a) => a.kind === "slice" && a.tool === "pandoc");
      const slices = artifacts.map((a) => join(cacheDir, a.target)) as [string, string];
      const outPath = join(outDir, "pandoc-universal-apple-darwin");
      const result = lipoCreate("pandoc", slices, outPath);
      expect(result.usedRealLipo).toBe(true);
      expect(readFileSync(outPath, "utf8")).toBe("lipo-combined");
      const invocation = readFileSync(invocationLog, "utf8").trim();
      expect(invocation).toBe(`-create ${slices[0]} ${slices[1]} -output ${outPath}`);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("falls back to a single-slice stand-in when lipo is not on PATH (ENOENT), never silently on another failure", () => {
    const cacheDir = fakeCache();
    const outDir = scratch();
    const originalPath = process.env.PATH;
    process.env.PATH = scratch(); // a directory with nothing in it: lipo cannot be found
    try {
      const artifacts = loadLock(lockPath).filter((a) => a.kind === "slice" && a.tool === "typst");
      const slices = artifacts.map((a) => join(cacheDir, a.target)) as [string, string];
      const outPath = join(outDir, "typst-universal-apple-darwin");
      const result = lipoCreate("typst", slices, outPath);
      expect(result.usedRealLipo).toBe(false);
      expect(readFileSync(outPath, "utf8")).toBe(readFileSync(slices[0], "utf8"));
      expect(fakeModeIsExecutable(outPath)).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

function fakeModeIsExecutable(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0;
}
