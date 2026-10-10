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
import { parse } from "../../core/src/parse.js";
import { buildPandocArgs, isMissingResourceWarning, outputPathFor, resourceDirFor } from "../src/index.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const FIXTURE_DOC = "essay-fixture.md";

/** `lang` is not product (DECISIONS #065, Michael's answer): the HTML and EPUB legs below need it
 * only so this suite's own assertions do not depend on the container's `LANG` (pandoc 3.11's epub
 * writer derives `dc:language` from it when no `--metadata lang` is given, lesson [4.0]'s sibling
 * finding), so it is kept as one named test-only exception rather than sprinkled per leg. */
const LANG_EXCEPTION = ["--metadata", "lang=en"] as const;

interface IndexEntry {
  sectionCount: number;
}

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, IndexEntry>;
const sectionCount = index[FIXTURE_DOC].sectionCount;

type MdNode = ReturnType<typeof parse>["children"][number];
type WithText = MdNode & { readonly value?: string; readonly children?: readonly WithText[] };

/** `root`'s own characters, never a hand-copied transcription (CLAUDE.md): every text node's
 * value, joined, so a heading's or a table cell's rewrapped bytes still read as one string. */
function textOf(node: WithText): string {
  if (node.type === "text") return node.value ?? "";
  if (node.children !== undefined) return node.children.map(textOf).join("");
  return "";
}

const fixtureRoot = parse(readFileSync(`${FIXTURES}/${FIXTURE_DOC}`, "utf8"));
const fixtureHeadings = (fixtureRoot.children as readonly WithText[])
  .filter((node) => node.type === "heading")
  .map(textOf);
const fixtureTables = (fixtureRoot.children as readonly WithText[]).filter((node) => node.type === "table");
// One cell from each of the 2 tables (task 4.4 acceptance): the first body row's first cell.
const fixtureTableCells = fixtureTables.map((table) => textOf((table.children as readonly WithText[])[1].children![0]));
// The code-block text (task 4.4 acceptance): a token with no internal whitespace, read off the
// fixture's own fenced code blocks, so a pandoc/typst line-wrap cannot split it apart.
const fixtureCodeBlocks = (fixtureRoot.children as readonly WithText[]).filter((node) => node.type === "code");
const codeToken = fixtureCodeBlocks.flatMap((code) => (code.value ?? "").match(/pen_safety=\w+/) ?? []).at(0);

/** Collapses pandoc's own line-wrapping (`--wrap=auto`'s default breaks a heading's text across
 * two source lines at ~72 columns) to one run of spaces, so a content check reads the same text a
 * reader would see rendered, never pandoc's own line-wrap choice. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

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
function runPandoc(
  cwd: string,
  args: string[],
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stderr: string } {
  const result = spawnSync("pandoc", args, { cwd, input: source, encoding: "utf8", env });
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

/** Resolves `name` the way the platform's own shell resolves a bare command — `/bin/sh` here,
 * `cmd.exe` with `PATHEXT` on Windows — so a `.cmd` shim (html-validate) and a shebang script
 * (epubcheck) both resolve; `execFileSync` without `shell` is CreateProcess directly, which
 * resolves neither (DECISIONS #065). No OS check of any kind: every argument passed through here
 * is a mkdtemp path or this repo's own config path, none containing a space, since a
 * shell-joined command line is otherwise unquoted. */
function runValidator(name: string, args: string[]): string {
  return execFileSync(name, args, { encoding: "utf8", stdio: "pipe", shell: true });
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
    const args = [...buildPandocArgs({ resourceDir, outPath: join(dir, outPath), format: "html" }), ...LANG_EXCEPTION];
    const source = readFileSync(`${FIXTURES}/${FIXTURE_DOC}`, "utf8");
    const result = runPandoc(FIXTURES, args, source);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const htmlPath = join(dir, outPath);
    const configPath = fileURLToPath(new URL("../../../.htmlvalidate.json", import.meta.url));
    expect(() => runValidator("html-validate", ["--config", configPath, htmlPath])).not.toThrow();
  });

  it("contains the 12 headings and both <table> elements (task 4.4 acceptance)", () => {
    const dir = tempDir();
    const outPath = outputPathFor(FIXTURE_DOC, "html");
    const resourceDir = resourceDirFor(FIXTURE_DOC);
    const args = [...buildPandocArgs({ resourceDir, outPath: join(dir, outPath), format: "html" }), ...LANG_EXCEPTION];
    const source = readFileSync(`${FIXTURES}/${FIXTURE_DOC}`, "utf8");
    const result = runPandoc(FIXTURES, args, source);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const html = normalizeWhitespace(readFileSync(join(dir, outPath), "utf8"));
    expect(fixtureHeadings).toHaveLength(sectionCount);
    for (const heading of fixtureHeadings) expect(html).toContain(heading);
    expect(html.match(/<table/g) ?? []).toHaveLength(2);
  });
});

describe("PDF export of essay-fixture (task 4.4 acceptance, DECISIONS #004 pipeline)", () => {
  // One typst compile plus three poppler spawns, on a runner whose process creation this suite
  // has measured as slow: 432ms (ubuntu) / 1965ms (macOS) / 7020ms (windows) for this same test
  // in one CI run (/logs/ci/4.verify.g1h/a1/) — the EPUB leg's own 20000ms budget below, not a
  // multiple of a container timing (DECISIONS #039).
  it("has >= 3 pages, 2 embedded images, and pdftotext contains the 12 headings, the code-block text and one cell from each of the 2 tables", () => {
    const dir = tempDir();
    const outPath = outputPathFor(FIXTURE_DOC, "pdf");
    const resourceDir = resourceDirFor(FIXTURE_DOC);
    const args = buildPandocArgs({ resourceDir, outPath: join(dir, outPath), format: "pdf" });
    const source = readFileSync(`${FIXTURES}/${FIXTURE_DOC}`, "utf8");
    const result = runPandoc(FIXTURES, args, source);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const pdfPath = join(dir, outPath);
    // `pdfinfo` (poppler, CLAUDE.md's external-reader rule): the pinned tool's own page count.
    const info = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    expect(pages).toBeGreaterThanOrEqual(3);

    // `pdfimages -list`: one row per embedded image (the fixture's own 2, per DECISIONS #004).
    const imagesList = execFileSync("pdfimages", ["-list", pdfPath], { encoding: "utf8" });
    const imageRows = imagesList.trim().split("\n").slice(2);
    expect(imageRows).toHaveLength(2);

    const textPath = join(dir, "essay.txt");
    execFileSync("pdftotext", [pdfPath, textPath]);
    const text = normalizeWhitespace(readFileSync(textPath, "utf8"));
    expect(fixtureHeadings).toHaveLength(sectionCount);
    for (const heading of fixtureHeadings) expect(text).toContain(heading);
    expect(fixtureTableCells).toHaveLength(2);
    for (const cell of fixtureTableCells) expect(text).toContain(cell);
    expect(codeToken).toBeDefined();
    expect(text).toContain(codeToken as string);
  }, 20000);
});

describe("EPUB export of essay-fixture (task 4.4 acceptance)", () => {
  // epubcheck starts a JVM (docker/versions.env's `EPUBCHECK_VERSION`), slower than vitest's
  // default 5000ms test timeout under the full suite's parallel load.
  it("passes epubcheck with 0 errors, holds dc:title essay-fixture, and its XHTML contains the 12 headings", () => {
    const dir = tempDir();
    const outPath = outputPathFor(FIXTURE_DOC, "epub");
    const resourceDir = resourceDirFor(FIXTURE_DOC);
    // The fixture itself has no front-matter `title` (DECISIONS #review-4-r0 U1), so `buildPandocArgs`
    // is given the document's own file stem as `title` — exactly what `export-sync.ts`'s
    // `exportDocument` computes from `readFrontMatter` finding no `title` key — and it appends the
    // `--metadata title=…` tokens itself; `LANG_EXCEPTION` is the only other, test-only, addition.
    // epubcheck's RSC-005 requires `dc:title` in the OPF, which pandoc's epub writer only emits from
    // an explicit title (the fixture has no H1 to infer one from either).
    const args = [
      ...buildPandocArgs({ resourceDir, outPath: join(dir, outPath), format: "epub", title: "essay-fixture" }),
      ...LANG_EXCEPTION,
    ];
    const source = readFileSync(`${FIXTURES}/${FIXTURE_DOC}`, "utf8");
    // Run under a fixed, non-POSIX `LANG` (lesson [4.0]'s sibling finding: pandoc's epub writer
    // derives `dc:language` from the process's own `LANG` when no `--metadata lang` is given) so
    // this assertion never depends on the container's own locale, only on `args` itself.
    const result = runPandoc(FIXTURES, args, source, { ...process.env, LANG: "en_US.UTF-8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const epubPath = join(dir, outPath);
    expect(() => runValidator("epubcheck", [epubPath])).not.toThrow();

    const opf = execFileSync("unzip", ["-p", epubPath, "EPUB/content.opf"], { encoding: "utf8" });
    expect(opf).toContain("<dc:title");
    expect(opf).toContain("essay-fixture");

    // Pandoc's epub writer splits chapters at H1 (`--split-level=1`'s default); the fixture has no
    // H1 of its own, so every section lands in the one chapter file.
    const xhtml = normalizeWhitespace(execFileSync("unzip", ["-p", epubPath, "EPUB/text/ch001.xhtml"], { encoding: "utf8" }));
    expect(fixtureHeadings).toHaveLength(sectionCount);
    for (const heading of fixtureHeadings) expect(xhtml).toContain(heading);
  }, 20000);
});

describe("front-matter title vs. the file-stem fallback (DECISIONS #review-4-r0 U1)", () => {
  it("a document with its own front-matter title gets no title token and keeps that title in dc:title (presence case)", () => {
    const dir = tempDir();
    const outPath = "has-title.epub";
    const target = { resourceDir: ".", outPath: join(dir, outPath), format: "epub" };
    const args = [...buildPandocArgs(target), ...LANG_EXCEPTION];
    expect(args.some((token) => token.startsWith("title="))).toBe(false);

    const source = "---\ntitle: My Own Title\n---\n\n# Heading\n\nBody text.\n";
    const result = runPandoc(dir, args, source, { ...process.env, LANG: "en_US.UTF-8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const epubPath = join(dir, outPath);
    expect(() => runValidator("epubcheck", [epubPath])).not.toThrow();
    const opf = execFileSync("unzip", ["-p", epubPath, "EPUB/content.opf"], { encoding: "utf8" });
    expect(opf).toContain("My Own Title");
  }, 20000);

  it("a document with no front-matter title gets the stem as its title token and dc:title (absence case)", () => {
    const dir = tempDir();
    const outPath = "no-title.epub";
    const target = { resourceDir: ".", outPath: join(dir, outPath), format: "epub", title: "no-title" };
    const args = [...buildPandocArgs(target), ...LANG_EXCEPTION];
    expect(args).toContain("title=no-title");

    const source = "# Heading\n\nBody text.\n";
    const result = runPandoc(dir, args, source, { ...process.env, LANG: "en_US.UTF-8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const epubPath = join(dir, outPath);
    const opf = execFileSync("unzip", ["-p", epubPath, "EPUB/content.opf"], { encoding: "utf8" });
    expect(opf).toContain("no-title");
  });

  it("a stem holding a space and a non-BMP letter round-trips into dc:title", () => {
    const dir = tempDir();
    const outPath = "astral-title.epub";
    const title = "essay plan 𝒳";
    const args = [
      ...buildPandocArgs({ resourceDir: ".", outPath: join(dir, outPath), format: "epub", title }),
      ...LANG_EXCEPTION,
    ];
    const source = "# Heading\n\nBody text.\n";
    const result = runPandoc(dir, args, source, { ...process.env, LANG: "en_US.UTF-8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const epubPath = join(dir, outPath);
    expect(() => runValidator("epubcheck", [epubPath])).not.toThrow();
    const opf = execFileSync("unzip", ["-p", epubPath, "EPUB/content.opf"], { encoding: "utf8" });
    expect(opf).toContain(title);
  }, 20000);
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
