// fetch-sidecars.test.ts — task 4.1. Every case here is offline: a local http server stands in for
// GitHub releases, and tiny synthetic archives stand in for pandoc/typst's real (tens-of-MB) ones,
// so `pnpm test` stays fast and deterministic. The real `pnpm fetch-sidecars` run against the real
// 8 locked URLs was done once by hand during this task (its summary is in the journal) and is not
// re-run here; CI network access for the real sidecars is task 4.2's concern.
import { createServer, type Server } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractMember,
  extractPkgPayloadMember,
  fetchAndVerify,
  fetchSidecars,
  hostTargetTriple,
  loadLock,
  sha256,
  verifyHostBinaries,
  type SidecarArtifact,
} from "../scripts/fetch-sidecars.ts";

const scriptPath = join(import.meta.dirname, "..", "scripts", "fetch-sidecars.ts");

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

  it("has exactly 8 artifacts: 4 platform binaries + 4 macOS slices", () => {
    expect(artifacts).toHaveLength(8);
    expect(artifacts.filter((a) => a.kind === "binary")).toHaveLength(4);
    expect(artifacts.filter((a) => a.kind === "slice")).toHaveLength(4);
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

describe("extractMember: one real archive per format, built with the system's own tar/unzip", () => {
  function tarGzWith(dir: string, memberPath: string, content: string): string {
    const archive = join(dir, "a.tar.gz");
    const full = join(dir, memberPath);
    mkdirSync(join(dir, memberPath.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(full, content);
    const r = spawnSync("tar", ["-czf", archive, "-C", dir, memberPath]);
    expect(r.status).toBe(0);
    return archive;
  }

  it("tar.gz: extracts the named member's exact bytes", () => {
    const dir = scratch();
    const archive = tarGzWith(dir, "pkg/bin/tool", "hello-tar-gz");
    const out = extractMember(readFileSync(archive), archive, {
      target: "t",
      tool: "pandoc",
      kind: "binary",
      url: "x",
      sha256: "x",
      format: "tar.gz",
      member: "pkg/bin/tool",
    } satisfies SidecarArtifact);
    expect(out.toString("utf8")).toBe("hello-tar-gz");
  });

  it("tar.xz: extracts the named member's exact bytes", () => {
    const dir = scratch();
    const full = join(dir, "tool");
    writeFileSync(full, "hello-tar-xz");
    const archive = join(dir, "a.tar.xz");
    const r = spawnSync("tar", ["-cJf", archive, "-C", dir, "tool"]);
    expect(r.status).toBe(0);
    const out = extractMember(readFileSync(archive), archive, {
      target: "t",
      tool: "typst",
      kind: "binary",
      url: "x",
      sha256: "x",
      format: "tar.xz",
      member: "tool",
    } satisfies SidecarArtifact);
    expect(out.toString("utf8")).toBe("hello-tar-xz");
  });

  it("zip: extracts the named member's exact bytes", () => {
    const dir = scratch();
    const full = join(dir, "tool.exe");
    writeFileSync(full, "hello-zip");
    const archive = join(dir, "a.zip");
    const r = spawnSync("zip", ["-q", archive, "tool.exe"], { cwd: dir });
    expect(r.status).toBe(0);
    const out = extractMember(readFileSync(archive), archive, {
      target: "t",
      tool: "pandoc",
      kind: "binary",
      url: "x",
      sha256: "x",
      format: "zip",
      member: "tool.exe",
    } satisfies SidecarArtifact);
    expect(out.toString("utf8")).toBe("hello-zip");
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
      const memberContent = "end-to-end-member";
      const full = join(dir, "tool");
      writeFileSync(full, memberContent);
      const archivePath = join(dir, "a.tar.gz");
      const tarResult = spawnSync("tar", ["-czf", archivePath, "-C", dir, "tool"]);
      expect(tarResult.status).toBe(0);
      const archiveBytes = readFileSync(archivePath);

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
                  member: "tool",
                },
              ],
            }),
          );
          const artifacts = await fetchSidecars({ lockPath, outDir });
          expect(artifacts).toHaveLength(1);
          const extracted = readFileSync(join(outDir, "tool-x86_64-unknown-linux-gnu"), "utf8");
          expect(extracted).toBe(memberContent);
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
  it("runs --version against the host-triple artifact for each tool and returns its first line", () => {
    const dir = scratch();
    const triple = hostTargetTriple() as string;
    for (const tool of ["pandoc", "typst"]) {
      const path = join(dir, `${tool}-${triple}`);
      writeFileSync(path, `#!/bin/sh\necho "${tool} 9.9.9 (fake)"\n`);
      chmodSync(path, 0o755);
    }
    const artifacts: SidecarArtifact[] = ["pandoc", "typst"].map((tool) => ({
      target: `${tool}-${triple}`,
      tool: tool as "pandoc" | "typst",
      kind: "binary",
      url: "x",
      sha256: "x",
      format: "tar.gz",
      member: "x",
    }));
    const summaries = verifyHostBinaries(dir, artifacts);
    expect(summaries).toEqual(["pandoc 9.9.9 (fake)", "typst 9.9.9 (fake)"]);
  });

  it("throws naming the failing binary when --version exits non-zero", () => {
    const dir = scratch();
    const triple = hostTargetTriple() as string;
    const pandocPath = join(dir, `pandoc-${triple}`);
    writeFileSync(pandocPath, "#!/bin/sh\nexit 1\n");
    chmodSync(pandocPath, 0o755);
    const artifacts: SidecarArtifact[] = [
      {
        target: `pandoc-${triple}`,
        tool: "pandoc",
        kind: "binary",
        url: "x",
        sha256: "x",
        format: "tar.gz",
        member: "x",
      },
    ];
    expect(() => verifyHostBinaries(dir, artifacts)).toThrow(/pandoc.*--version failed/);
  });

  it("throws naming the tool when the lock has no artifact for this host's triple", () => {
    expect(() => verifyHostBinaries(scratch(), [])).toThrow(/no locked pandoc artifact/);
  });
});
