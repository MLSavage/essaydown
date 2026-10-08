// fetch-sidecars.test.ts — task 4.1. Every case here is offline: a local http server stands in for
// GitHub releases, and tiny synthetic archives stand in for pandoc/typst's real (tens-of-MB) ones,
// so `pnpm test` stays fast and deterministic. The real `pnpm fetch-sidecars` run against the real
// 8 locked URLs was done once by hand during this task (its summary is in the journal) and is not
// re-run here; CI network access for the real sidecars is task 4.2's concern. Since task 4.11 the
// real-archive legs read small archives committed under tests/fixtures/sidecars/ (built once in the
// Linux container) rather than building them with the host's own tar/zip, and every other external
// command is a fake `Runner`, so the suite runs alike on the Linux, macOS and Windows test jobs.
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLockVersionsMatch,
  extractMember,
  extractPkgPayloadMember,
  fetchAndVerify,
  fetchSidecars,
  hostTargetTriple,
  isMainModule,
  loadLock,
  makeExecutable,
  sha256,
  verifyHostBinaries,
  windowsTarPath,
  type Runner,
  type SidecarArtifact,
  type SidecarLock,
} from "../scripts/fetch-sidecars.ts";

const scriptPath = join(import.meta.dirname, "..", "scripts", "fetch-sidecars.ts");
const fixturesDir = join(import.meta.dirname, "fixtures", "sidecars");

/** A fake runner recording each call (command, argv, stdin) and answering with `stdout`. */
function recordingRunner(stdout = "member-bytes"): {
  runner: Runner;
  calls: { cmd: string; args: string[]; input?: Buffer }[];
} {
  const calls: { cmd: string; args: string[]; input?: Buffer }[] = [];
  const runner: Runner = (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts?.input });
    return { status: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
  };
  return { runner, calls };
}

function artifactOf(format: SidecarArtifact["format"], member: string): SidecarArtifact {
  return { target: "t", tool: "pandoc", kind: "binary", url: "x", sha256: "x", format, member };
}

function spawnAsync(
  cmd: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "fetch-sidecars-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("the committed lock file", () => {
  const artifacts = loadLock(join(import.meta.dirname, "..", "scripts", "sidecars.lock.json"));

  it("has exactly 10 artifacts: 4 platform binaries + 4 macOS slices + 2 dev-only aarch64 Linux entries", () => {
    expect(artifacts).toHaveLength(10);
    expect(artifacts.filter((a) => a.kind === "binary")).toHaveLength(4);
    expect(artifacts.filter((a) => a.kind === "slice")).toHaveLength(4);
    expect(artifacts.filter((a) => a.kind === "dev")).toHaveLength(2);
  });

  it("the dev-only entries cover both tools on aarch64-unknown-linux-gnu", () => {
    const devTargets = artifacts.filter((a) => a.kind === "dev").map((a) => a.target);
    expect(devTargets).toContain("pandoc-aarch64-unknown-linux-gnu");
    expect(devTargets).toContain("typst-aarch64-unknown-linux-gnu");
  });

  it("every artifact names a 64-character hex sha256 and a unique target", () => {
    for (const a of artifacts) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(artifacts.map((a) => a.target)).size).toBe(artifacts.length);
  });

  it("both tools' macOS slices cover both architectures", () => {
    for (const tool of ["pandoc", "typst"]) {
      const slices = artifacts
        .filter((a) => a.tool === tool && a.kind === "slice")
        .map((a) => a.target);
      expect(slices).toContain(`${tool}-aarch64-apple-darwin`);
      expect(slices).toContain(`${tool}-x86_64-apple-darwin`);
    }
  });
});

describe("extractMember: one committed real archive per format, through the platform's real route", () => {
  it("tar.gz: extracts the named member's exact bytes", () => {
    const archive = join(fixturesDir, "member.tar.gz");
    const out = extractMember(readFileSync(archive), archive, artifactOf("tar.gz", "pkg/bin/tool"));
    expect(out.toString("utf8")).toBe("hello-tar-gz");
  });

  it("tar.xz: extracts the named member's exact bytes", () => {
    const archive = join(fixturesDir, "member.tar.xz");
    const out = extractMember(readFileSync(archive), archive, artifactOf("tar.xz", "tool"));
    expect(out.toString("utf8")).toBe("hello-tar-xz");
  });

  it("zip: extracts the named member's exact bytes", () => {
    const archive = join(fixturesDir, "member.zip");
    const out = extractMember(readFileSync(archive), archive, artifactOf("zip", "tool.exe"));
    expect(out.toString("utf8")).toBe("hello-zip");
  });
});

describe("extractMember: the argv each format hands the runner", () => {
  const archive = Buffer.from("archive-bytes");
  const archivePath = "C:\\Users\\runner\\cache\\t.download";

  it("tar.gz argv: tar -xzO -f - <member> with the archive bytes on stdin, never a path", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const { runner, calls } = recordingRunner();
      const out = extractMember(
        archive,
        archivePath,
        artifactOf("tar.gz", "a/b"),
        runner,
        platform,
      );
      expect(out.toString("utf8")).toBe("member-bytes");
      expect(calls).toEqual([{ cmd: "tar", args: ["-xzO", "-f", "-", "a/b"], input: archive }]);
    }
  });

  it("tar.xz argv: tar -xJO -f - <member> with the archive bytes on stdin, never a path", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const { runner, calls } = recordingRunner();
      extractMember(archive, archivePath, artifactOf("tar.xz", "a/b"), runner, platform);
      expect(calls).toEqual([{ cmd: "tar", args: ["-xJO", "-f", "-", "a/b"], input: archive }]);
    }
  });

  it("win32 zip argv: the absolute System32 tar.exe, -xOf, the archive path, the member", () => {
    const { runner, calls } = recordingRunner();
    extractMember(
      archive,
      archivePath,
      artifactOf("zip", "pandoc-3.11/pandoc.exe"),
      runner,
      "win32",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(windowsTarPath());
    expect(calls[0].cmd).toMatch(/^[A-Za-z]:\\.*\\System32\\tar\.exe$/);
    expect(calls[0].args).toEqual(["-xOf", archivePath, "pandoc-3.11/pandoc.exe"]);
    expect(calls[0].input).toBeUndefined();
  });

  it("windowsTarPath reads %SystemRoot%, and falls back to C:\\Windows when it is unset", () => {
    expect(windowsTarPath({ SystemRoot: "D:\\WINNT" })).toBe("D:\\WINNT\\System32\\tar.exe");
    expect(windowsTarPath({})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("non-win32 zip argv: unzip -p <archive> <member>, unchanged", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const { runner, calls } = recordingRunner();
      extractMember(archive, "/tmp/t.download", artifactOf("zip", "m.exe"), runner, platform);
      expect(calls).toEqual([
        { cmd: "unzip", args: ["-p", "/tmp/t.download", "m.exe"], input: undefined },
      ]);
    }
  });

  it("a runner that exits non-zero throws naming the command", () => {
    const failing: Runner = () => ({
      status: 2,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("tar: Cannot connect to C: resolve failed"),
    });
    expect(() => extractMember(archive, archivePath, artifactOf("tar.gz", "m"), failing)).toThrow(
      /tar -xzO -f - m exited 2/,
    );
  });
});

describe("isMainModule: the run-as-main check, via pathToFileURL", () => {
  it("matches a POSIX argv[1]", () => {
    expect(
      isMainModule(
        "file:///repo/scripts/fetch-sidecars.ts",
        "/repo/scripts/fetch-sidecars.ts",
        false,
      ),
    ).toBe(true);
  });

  it("matches a C:\\ backslash argv[1] under windows", () => {
    expect(
      isMainModule(
        "file:///C:/a/essaydown/scripts/fetch-sidecars.ts",
        "C:\\a\\essaydown\\scripts\\fetch-sidecars.ts",
        true,
      ),
    ).toBe(true);
  });

  it("matches an argv[1] containing a space (percent-encoded in import.meta.url)", () => {
    expect(isMainModule("file:///my%20repo/scripts/x.ts", "/my repo/scripts/x.ts", false)).toBe(
      true,
    );
    expect(isMainModule("file:///C:/my%20repo/x.ts", "C:\\my repo\\x.ts", true)).toBe(true);
  });

  it("is false for a non-main argv[1] (another script, or none)", () => {
    expect(
      isMainModule(
        "file:///repo/scripts/fetch-sidecars.ts",
        "/repo/node_modules/vitest/vitest.mjs",
        false,
      ),
    ).toBe(false);
    expect(isMainModule("file:///repo/scripts/fetch-sidecars.ts", undefined, false)).toBe(false);
  });

  it("this test file's own module URL round-trips through its path on this host", () => {
    const self = join(import.meta.dirname, "fetch-sidecars.test.ts");
    expect(isMainModule(pathToFileURL(self).href, self)).toBe(true);
  });
});

describe("makeExecutable: the one platform-aware chmod", () => {
  function chmodSpy() {
    const calls: [string, number][] = [];
    return { calls, chmod: (path: string, mode: number) => void calls.push([path, mode]) };
  }

  it("chmods 0o755 on linux", () => {
    const { calls, chmod } = chmodSpy();
    makeExecutable("/x/pandoc", "linux", chmod);
    expect(calls).toEqual([["/x/pandoc", 0o755]]);
  });

  it("chmods 0o755 on darwin", () => {
    const { calls, chmod } = chmodSpy();
    makeExecutable("/x/pandoc", "darwin", chmod);
    expect(calls).toEqual([["/x/pandoc", 0o755]]);
  });

  it("does not chmod on win32", () => {
    const { calls, chmod } = chmodSpy();
    makeExecutable("C:\\x\\pandoc.exe", "win32", chmod);
    expect(calls).toEqual([]);
  });
});

/** Hand-builds a minimal xar archive around one `<component>/Payload` member, whose payload bytes
 * are a gzip-compressed cpio (odc) archive holding one named entry — the same shape as a real
 * pandoc macOS .pkg, small enough to live inline in a test. Mirrors extractPkgPayloadMember's own
 * reading order so a defect in either direction (reading, or this fixture's writing) is caught by
 * the other. */
function buildPkgFixture(component: string, memberName: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(`${memberName}\0`, "ascii");
  const header = Buffer.alloc(76);
  header.write("070707", 0, "ascii");
  header.write("000000", 6, "ascii"); // dev
  header.write("000000", 12, "ascii"); // ino
  header.write("100644", 18, "ascii"); // mode (regular file)
  header.write("000000", 24, "ascii"); // uid
  header.write("000000", 30, "ascii"); // gid
  header.write("000001", 36, "ascii"); // nlink
  header.write("000000", 42, "ascii"); // rdev
  header.write("00000000000", 48, "ascii"); // mtime (6+6+6+6+6+6+6 = 42, mtime 11 wide)
  header.write(nameBytes.length.toString(8).padStart(6, "0"), 59, "ascii");
  header.write(content.length.toString(8).padStart(11, "0"), 65, "ascii");
  const trailerName = Buffer.from("TRAILER!!!\0", "ascii");
  const trailer = Buffer.alloc(76);
  trailer.write("070707", 0, "ascii");
  trailer.write("000000000000000000000000000000000000000000000000000", 6, "ascii");
  trailer.write(trailerName.length.toString(8).padStart(6, "0"), 59, "ascii");
  trailer.write("00000000000", 65, "ascii");
  const cpio = Buffer.concat([header, nameBytes, content, trailer, trailerName]);
  const payloadBytes = gzipSync(cpio);

  const tocXml = `<?xml version="1.0" encoding="UTF-8"?><xar><toc>
    <file id="1"><type>directory</type><name>${component}</name>
      <file id="2"><data><length>${payloadBytes.length}</length><offset>0</offset><size>${payloadBytes.length}</size>
        <encoding style="application/octet-stream"/></data><type>file</type><name>Payload</name></file>
    </file>
  </toc></xar>`;
  const tocCompressed = deflateSync(Buffer.from(tocXml, "utf8"));
  const header28 = Buffer.alloc(28);
  header28.write("xar!", 0, "ascii");
  header28.writeUInt16BE(28, 4);
  header28.writeUInt16BE(1, 6);
  header28.writeBigUInt64BE(BigInt(tocCompressed.length), 8);
  header28.writeBigUInt64BE(BigInt(tocXml.length), 16);
  header28.writeUInt32BE(0, 24);
  return Buffer.concat([header28, tocCompressed, payloadBytes]);
}

describe("extractPkgPayloadMember: xar + cpio(odc), proven against pandoc's real .pkg by hand", () => {
  it("reads the named cpio member out of a Payload nested under one component", () => {
    const pkg = buildPkgFixture(
      "pandoc.pkg",
      "./usr/local/bin/pandoc",
      Buffer.from("#!fake-binary"),
    );
    const out = extractPkgPayloadMember(pkg, ["pandoc.pkg"], "./usr/local/bin/pandoc");
    expect(out.toString("ascii")).toBe("#!fake-binary");
  });

  it("throws naming the missing component when the path doesn't match the TOC", () => {
    const pkg = buildPkgFixture("pandoc.pkg", "./usr/local/bin/pandoc", Buffer.from("x"));
    expect(() => extractPkgPayloadMember(pkg, ["nope.pkg"], "./usr/local/bin/pandoc")).toThrow(
      /Payload/,
    );
  });

  it("throws naming the missing cpio member when the component is right but the member isn't", () => {
    const pkg = buildPkgFixture("pandoc.pkg", "./usr/local/bin/pandoc", Buffer.from("x"));
    expect(() => extractPkgPayloadMember(pkg, ["pandoc.pkg"], "./usr/local/bin/nope")).toThrow(
      /no member/,
    );
  });

  it("throws on a buffer that isn't a xar archive at all", () => {
    expect(() => extractPkgPayloadMember(Buffer.from("not a pkg"), ["x"], "y")).toThrow(
      /bad magic/,
    );
  });
});

describe("fetchAndVerify + the tampered-checksum abort", () => {
  let server: Server;
  let base: string;
  const body = Buffer.from("archive-bytes-for-checksum-tests");

  function withServer(fn: (base: string) => Promise<void> | void) {
    return new Promise<void>((resolve, reject) => {
      server = createServer((_req, res) => res.end(body));
      server.listen(0, "127.0.0.1", async () => {
        const address = server.address();
        base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
        try {
          await fn(base);
          resolve();
        } catch (e) {
          reject(e);
        } finally {
          server.close();
        }
      });
    });
  }

  it("accepts a download whose sha256 matches the lock entry", () =>
    withServer(async (url) => {
      const dir = scratch();
      const artifact: SidecarArtifact = {
        target: "ok",
        tool: "pandoc",
        kind: "binary",
        url,
        sha256: sha256(body),
        format: "tar.gz",
        member: "x",
      };
      const buf = await fetchAndVerify(artifact, dir);
      expect(buf.equals(body)).toBe(true);
    }));

  it("rejects a download whose sha256 does not match the lock entry", () =>
    withServer(async (url) => {
      const dir = scratch();
      const artifact: SidecarArtifact = {
        target: "tampered",
        tool: "pandoc",
        kind: "binary",
        url,
        sha256: "0".repeat(64),
        format: "tar.gz",
        member: "x",
      };
      await expect(fetchAndVerify(artifact, dir)).rejects.toThrow(/checksum mismatch/);
      expect(existsSync(join(dir, "tampered.download"))).toBe(false);
    }));

  it("the CLI aborts with a non-zero exit and writes nothing to --out on a tampered checksum", () =>
    withServer(async (url) => {
      const dir = scratch();
      const lockPath = join(dir, "lock.json");
      const outDir = join(dir, "out");
      writeFileSync(
        lockPath,
        JSON.stringify({
          artifacts: [
            {
              target: "tampered",
              tool: "pandoc",
              kind: "binary",
              url,
              sha256: "0".repeat(64),
              format: "tar.gz",
              member: "x",
            },
          ],
        }),
      );
      // spawnSync would block this process's event loop while the child dials back into the
      // server above (hosted in this same process), deadlocking both sides; spawn it async instead.
      const r = await spawnAsync(process.execPath, [
        scriptPath,
        "--lock",
        lockPath,
        "--out",
        outDir,
      ]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("checksum mismatch");
      expect(existsSync(join(outDir, "tampered"))).toBe(false);
    }));
});

describe("fetchSidecars: end-to-end against a local server with a tiny synthetic lock", () => {
  it("downloads, verifies and extracts every artifact in the lock", () =>
    new Promise<void>((resolve, reject) => {
      const dir = scratch();
      const archiveBytes = readFileSync(join(fixturesDir, "member.tar.gz"));

      const server = createServer((_req, res) => res.end(archiveBytes));
      server.listen(0, "127.0.0.1", async () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        try {
          const lockPath = join(dir, "lock.json");
          const outDir = join(dir, "out");
          writeFileSync(
            lockPath,
            JSON.stringify({
              artifacts: [
                {
                  target: "tool-x86_64-unknown-linux-gnu",
                  tool: "pandoc",
                  kind: "binary",
                  url: `http://127.0.0.1:${port}/a.tar.gz`,
                  sha256: sha256(archiveBytes),
                  format: "tar.gz",
                  member: "pkg/bin/tool",
                },
              ],
            }),
          );
          const artifacts = await fetchSidecars({ lockPath, outDir });
          expect(artifacts).toHaveLength(1);
          const extracted = readFileSync(join(outDir, "tool-x86_64-unknown-linux-gnu"), "utf8");
          expect(extracted).toBe("hello-tar-gz");
          resolve();
        } catch (e) {
          reject(e);
        } finally {
          server.close();
        }
      });
    }));
});

describe("hostTargetTriple", () => {
  function withPlatformArch(platform: string, arch: string, fn: () => void) {
    const platformDesc = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    const archDesc = Object.getOwnPropertyDescriptor(process, "arch") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: platform });
    Object.defineProperty(process, "arch", { value: arch });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "platform", platformDesc);
      Object.defineProperty(process, "arch", archDesc);
    }
  }

  it("linux -> x86_64-unknown-linux-gnu", () =>
    withPlatformArch("linux", "x64", () =>
      expect(hostTargetTriple()).toBe("x86_64-unknown-linux-gnu"),
    ));

  it("darwin arm64 -> aarch64-apple-darwin", () =>
    withPlatformArch("darwin", "arm64", () =>
      expect(hostTargetTriple()).toBe("aarch64-apple-darwin"),
    ));

  it("darwin x64 -> x86_64-apple-darwin", () =>
    withPlatformArch("darwin", "x64", () =>
      expect(hostTargetTriple()).toBe("x86_64-apple-darwin"),
    ));

  it("win32 -> x86_64-pc-windows-msvc", () =>
    withPlatformArch("win32", "x64", () =>
      expect(hostTargetTriple()).toBe("x86_64-pc-windows-msvc"),
    ));

  it("an unsupported platform is undefined", () =>
    withPlatformArch("freebsd", "x64", () => expect(hostTargetTriple()).toBeUndefined()));
});

describe("verifyHostBinaries", () => {
  function lockFor(targets: string[]): SidecarArtifact[] {
    return targets.map((target) => ({
      target,
      tool: target.startsWith("pandoc") ? "pandoc" : "typst",
      kind: "binary",
      url: "x",
      sha256: "x",
      format: "tar.gz",
      member: "x",
    }));
  }

  it("runs --version through the runner against the host-triple artifact for each tool and returns its first line", () => {
    const dir = scratch();
    const calls: string[][] = [];
    const runner: Runner = (cmd, args) => {
      calls.push([cmd, ...args]);
      const tool = cmd.includes("pandoc") ? "pandoc" : "typst";
      return {
        status: 0,
        stdout: Buffer.from(`${tool} 9.9.9 (fake)\nmore\n`),
        stderr: Buffer.alloc(0),
      };
    };
    const artifacts = lockFor([
      "pandoc-x86_64-unknown-linux-gnu",
      "typst-x86_64-unknown-linux-gnu",
    ]);
    const summaries = verifyHostBinaries(dir, artifacts, runner, "linux", "x64");
    expect(summaries).toEqual(["pandoc 9.9.9 (fake)", "typst 9.9.9 (fake)"]);
    expect(calls).toEqual([
      [join(dir, "pandoc-x86_64-unknown-linux-gnu"), "--version"],
      [join(dir, "typst-x86_64-unknown-linux-gnu"), "--version"],
    ]);
  });

  it("win32 .exe lookup: under an injected win32 it runs the `.exe` target", () => {
    const dir = scratch();
    const { runner, calls } = recordingRunner("pandoc typst 1.0");
    const artifacts = lockFor([
      "pandoc-x86_64-unknown-linux-gnu",
      "pandoc-x86_64-pc-windows-msvc.exe",
      "typst-x86_64-pc-windows-msvc.exe",
    ]);
    verifyHostBinaries(dir, artifacts, runner, "win32", "x64");
    expect(calls.map((c) => c.cmd)).toEqual([
      join(dir, "pandoc-x86_64-pc-windows-msvc.exe"),
      join(dir, "typst-x86_64-pc-windows-msvc.exe"),
    ]);
  });

  it("win32 .exe lookup: a lock with only the suffix-less name has no win32 artifact", () => {
    const { runner } = recordingRunner("pandoc");
    const artifacts = lockFor(["pandoc-x86_64-pc-windows-msvc", "typst-x86_64-pc-windows-msvc"]);
    expect(() => verifyHostBinaries(scratch(), artifacts, runner, "win32", "x64")).toThrow(
      /no locked pandoc artifact for host triple x86_64-pc-windows-msvc/,
    );
  });

  it("throws naming the failing binary when --version exits non-zero", () => {
    const failing: Runner = () => ({
      status: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("boom"),
    });
    const artifacts = lockFor(["pandoc-aarch64-apple-darwin"]);
    expect(() => verifyHostBinaries(scratch(), artifacts, failing, "darwin", "arm64")).toThrow(
      /pandoc-aarch64-apple-darwin --version failed \(status 1\): boom/,
    );
  });

  it("throws naming the tool when the lock has no artifact for this host's triple", () => {
    expect(() => verifyHostBinaries(scratch(), [])).toThrow(/no locked pandoc artifact/);
  });
});

describe("assertLockVersionsMatch: the lock's pandocVersion/typstVersion vs docker/versions.env", () => {
  function writeVersionsEnv(dir: string): string {
    const path = join(dir, "versions.env");
    writeFileSync(
      path,
      "# comment\nNODE_VERSION=22.22.1\nPANDOC_VERSION=3.11\nTYPST_VERSION=0.15.1\n",
    );
    return path;
  }

  it("does not throw when both versions match", () => {
    const dir = scratch();
    const lock: SidecarLock = { pandocVersion: "3.11", typstVersion: "0.15.1", artifacts: [] };
    expect(() => assertLockVersionsMatch(lock, writeVersionsEnv(dir))).not.toThrow();
  });

  it("throws naming pandocVersion when the lock's pandocVersion disagrees with PANDOC_VERSION", () => {
    const dir = scratch();
    const lock: SidecarLock = { pandocVersion: "3.10", typstVersion: "0.15.1", artifacts: [] };
    expect(() => assertLockVersionsMatch(lock, writeVersionsEnv(dir))).toThrow(
      /pandocVersion \(3\.10\).*PANDOC_VERSION \(3\.11\)/,
    );
  });

  it("throws naming typstVersion when the lock's typstVersion disagrees with TYPST_VERSION", () => {
    const dir = scratch();
    const lock: SidecarLock = { pandocVersion: "3.11", typstVersion: "0.14.0", artifacts: [] };
    expect(() => assertLockVersionsMatch(lock, writeVersionsEnv(dir))).toThrow(
      /typstVersion \(0\.14\.0\).*TYPST_VERSION \(0\.15\.1\)/,
    );
  });

  it("skips a field's check when the lock omits it, rather than failing on an unrelated fixture", () => {
    const dir = scratch();
    const lock: SidecarLock = { artifacts: [] };
    expect(() => assertLockVersionsMatch(lock, writeVersionsEnv(dir))).not.toThrow();
  });
});
