/**
 * Integration test (task 4.3's acceptance): spawns the real, container-pinned `pandoc` binary
 * (`docker/versions.env`'s `PANDOC_VERSION`, on `PATH` in this image) against `essay-fixture.md`
 * with this package's own argument builders, and validates the result with pinned tooling only —
 * `unzip -t`/`unzip -p` (the container's apt-installed unzip) and `fast-xml-parser`, pinned in this
 * package's own package.json — never a full office-suite reader (none is installed, PRD).
 *
 * This does not exercise `apps/desktop/src-tauri/src/export.rs`'s sidecar spawn (a Tauri sidecar
 * binary cannot run outside the bundled app in a plain vitest process); it proves the pandoc
 * invocation this package's builders produce, which `export.rs` mirrors in Rust (its own doc
 * comment names this file).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildPandocArgs, isMissingResourceWarning, outputPathFor, resourceDirFor } from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const FIXTURE_DOC = "essay-fixture.md";

interface IndexEntry {
  sectionCount: number;
}

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, IndexEntry>;
const sectionCount = index[FIXTURE_DOC].sectionCount;

let pandocVersion = "";
beforeAll(() => {
  pandocVersion = execFileSync("pandoc", ["--version"], { encoding: "utf8" }).split("\n")[0] ?? "";
});

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "essaydown-export-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Runs pandoc exactly as `export.rs` does: fed over stdin, cwd at `cwd`, no positional input
 * argument, capturing stderr apart from the exit code. `execFileSync` discards stderr on a zero
 * exit (its return value is stdout alone), which is exactly the case this suite's warning —
 * pandoc exits 0 even on a missing image (lesson [4.0]) — needs to read; `spawnSync` reports both
 * regardless of status. */
function runPandoc(cwd: string, args: string[], source: string): { status: number; stderr: string } {
  const result = spawnSync("pandoc", args, { cwd, input: source, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? 1, stderr: result.stderr };
}

function unzipList(docxPath: string): string[] {
  const out = execFileSync("unzip", ["-l", docxPath], { encoding: "utf8" });
  return out
    .split("\n")
    .slice(3, -3)
    .map((line) => line.trim().split(/\s+/).slice(3).join(" "))
    .filter((name) => name !== "");
}

function unzipExtract(docxPath: string, member: string): string {
  return execFileSync("unzip", ["-p", docxPath, member], { encoding: "utf8" });
}

describe("DOCX export of essay-fixture (task 4.3 acceptance)", () => {
  it(`runs against the container's pinned pandoc (${pandocVersion === "" ? "version read in beforeAll" : pandocVersion})`, () => {
    expect(pandocVersion.startsWith("pandoc")).toBe(true);
  });

  it("produces a readable zip with the three required parts, 12 heading paragraphs, 2 tables and 2 media files", () => {
    const dir = tempDir();
    const outPath = outputPathFor(FIXTURE_DOC, "docx");
    const resourceDir = resourceDirFor(FIXTURE_DOC);
    const args = buildPandocArgs({ resourceDir, outPath: join(dir, outPath), format: "docx" });
    const source = readFileSync(`${FIXTURES}/${FIXTURE_DOC}`, "utf8");
    const result = runPandoc(FIXTURES, args, source);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const docxPath = join(dir, outPath);
    // `unzip -t`: the pinned tool itself proves the archive is a readable zip.
    const integrity = execFileSync("unzip", ["-t", docxPath], { encoding: "utf8" });
    expect(integrity).toContain("No errors detected");

    const members = unzipList(docxPath);
    expect(members).toContain("word/document.xml");
    expect(members).toContain("word/styles.xml");
    expect(members).toContain("[Content_Types].xml");
    const media = members.filter((name) => name.startsWith("word/media/"));
    expect(media).toHaveLength(2);

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    const documentXml = unzipExtract(docxPath, "word/document.xml");
    const document = parser.parse(documentXml) as Record<string, unknown>;
    expect(document["w:document"]).toBeDefined();

    const headingCount = (documentXml.match(/<w:pStyle w:val="Heading\d+"\s*\/>/g) ?? []).length;
    expect(headingCount).toBe(sectionCount);
    const tableCount = (documentXml.match(/<w:tbl>/g) ?? []).length;
    expect(tableCount).toBe(2);
  });
});

describe("HTML export of essay-fixture (task 4.3 acceptance)", () => {
  it("passes html-validate with the committed config", () => {
    const dir = tempDir();
    const outPath = outputPathFor(FIXTURE_DOC, "html");
    const resourceDir = resourceDirFor(FIXTURE_DOC);
    const args = [...buildPandocArgs({ resourceDir, outPath: join(dir, outPath), format: "html" }), "--metadata", "lang=en"];
    const source = readFileSync(`${FIXTURES}/${FIXTURE_DOC}`, "utf8");
    const result = runPandoc(FIXTURES, args, source);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const htmlPath = join(dir, outPath);
    const configPath = fileURLToPath(new URL("../../../.htmlvalidate.json", import.meta.url));
    expect(() =>
      execFileSync("html-validate", ["--config", configPath, htmlPath], { encoding: "utf8", stdio: "pipe" }),
    ).not.toThrow();
  });
});

describe("a missing image (task 4.3 acceptance: warning, not failure)", () => {
  it("exits 0 with a classifiable warning on stderr, and writes no media for the unresolved image", () => {
    const emptyDir = tempDir();
    const outDir = tempDir();
    const outPath = outputPathFor(FIXTURE_DOC, "docx");
    // `--resource-path` points at a directory with no images, and the invocation's cwd is the same
    // empty directory (never the fixture's own), so pandoc truly cannot resolve either image —
    // `export.rs`'s `current_dir(root)` is why the Rust side cannot fall back to finding them by cwd.
    const args = buildPandocArgs({ resourceDir: emptyDir, outPath: join(outDir, outPath), format: "docx" });
    const source = readFileSync(`${FIXTURES}/${FIXTURE_DOC}`, "utf8");
    const result = runPandoc(emptyDir, args, source);

    expect(result.status).toBe(0);
    expect(isMissingResourceWarning(result.stderr)).toBe(true);
    expect(result.stderr).toContain("golden-age-advert.png");
    expect(result.stderr).toContain("pen-materials.png");

    const docxPath = join(outDir, outPath);
    const members = unzipList(docxPath);
    expect(members.filter((name) => name.startsWith("word/media/"))).toHaveLength(0);
  });

  it("isMissingResourceWarning is false for the fixture's own clean export", () => {
    const dir = tempDir();
    const outPath = outputPathFor(FIXTURE_DOC, "docx");
    const args = buildPandocArgs({ resourceDir: resourceDirFor(FIXTURE_DOC), outPath: join(dir, outPath), format: "docx" });
    const source = readFileSync(`${FIXTURES}/${FIXTURE_DOC}`, "utf8");
    const result = runPandoc(FIXTURES, args, source);
    expect(isMissingResourceWarning(result.stderr)).toBe(false);
  });
});
