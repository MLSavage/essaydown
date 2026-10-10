import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import { parse } from "../../../packages/core/src/parse.js";
import { outputPathFor } from "../../../packages/export/src/index.js";
import { clickCentreOf, reloadPage } from "./routes.js";

// File -> Export, through the real sidecar and the real dialog (task 4.29, a Phase 4 review fix;
// DECISIONS #review-4-r0, #064's question answered: the fixture carrying images lives in its own
// spec, on a copy of essay-fixture.md, never in one-workflow.spec.ts, so none of that spec's golden
// changes). one-workflow.spec.ts step 7 drives only PDF, on a 3-question document with no image;
// this spec drives all four presets the dialog offers by default (DOCX, HTML, PDF, EPUB) on
// essay-fixture.md (12 headings, 2 images, DECISIONS #004's pipeline), each validated with the
// external reader CLAUDE.md names for that format, and separately exercises the missing-image
// toast (App.tsx's `onWarning`, lesson [4.0]) on a second document whose image reference is left
// dangling on purpose.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const FIXTURE_DOC = "essay-fixture.md";

interface IndexEntry {
  sectionCount: number;
}
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, IndexEntry>;
const sectionCount = index[FIXTURE_DOC].sectionCount;

type MdNode = Root["children"][number];
type WithText = MdNode & { readonly value?: string; readonly children?: readonly WithText[] };

/** A node's own characters, never a hand-copied transcription (CLAUDE.md): every text node's
 * value, joined, so a heading rewrapped by pandoc's line-wrap still reads as one string. */
function textOf(node: WithText): string {
  if (node.type === "text") return node.value ?? "";
  if (node.children !== undefined) return node.children.map(textOf).join("");
  return "";
}

const fixtureRoot = parse(readFileSync(`${FIXTURES}/${FIXTURE_DOC}`, "utf8"));
const fixtureHeadings = (fixtureRoot.children as readonly WithText[])
  .filter((node) => node.type === "heading")
  .map(textOf);
assert.equal(fixtureHeadings.length, sectionCount, "essay-fixture.md's own heading count drifted from its index entry");

/** Collapses pandoc's own line-wrapping to one run of spaces, so a content check reads the same
 * text a reader would see rendered, never pandoc's own line-wrap choice (packages/export/test/
 * integration.test.ts's identical helper). */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Every external-reader spawn below goes through this: a spawn failure (ENOENT, a non-zero exit)
 * that reaches a wdio spec's own test framework as the raw `execFileSync` error is opaque —
 * `checkExecSyncError`'s `Object.assign(err, ret)` leaves `ret.error` pointing at `err` itself, and
 * `@wdio/utils`'s own reporting serialization chokes on that circular reference with "Converting
 * circular structure to JSON" instead of the real failure (DECISIONS #065's backlog line, "a spawn
 * failure inside a wdio spec is opaque"). A plain `Error` built from a string message carries no
 * such reference and names the command that failed. `shell: true` resolves a `.cmd` shim
 * (html-validate) and a shebang script (epubcheck) the same way `packages/export/test/
 * integration.test.ts`'s own `runValidator` does; `unzip`/`pdfimages`/`pdftotext` need no shell. */
function runExternal(name: string, args: readonly string[], shell = false): string {
  try {
    return execFileSync(name, args, { encoding: "utf8", stdio: "pipe", shell });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} ${args.join(" ")} failed: ${message}`, { cause: error });
  }
}

function unzipMembers(archivePath: string): string[] {
  const out = runExternal("unzip", ["-l", archivePath]);
  return out
    .split("\n")
    .slice(3, -3)
    .map((line) => line.trim().split(/\s+/).slice(3).join(" "))
    .filter((name) => name !== "");
}

async function openThroughRestore(folder: string, file: string): Promise<void> {
  await browser.execute(
    (key, value) => localStorage.setItem(key, value),
    STORAGE_KEY,
    JSON.stringify({ folder, file }),
  );
  await reloadPage();
  await browser.waitUntil(
    () =>
      browser.execute(
        (name, editorSel) =>
          document.querySelector('[data-testid="current-file"]')?.textContent === name &&
          document.querySelector(editorSel) !== null,
        file,
        EDITOR,
      ),
    { timeout: 15000, interval: 50, timeoutMsg: `${file} never opened in the editor` },
  );
}

async function openExportDialog(): Promise<void> {
  await clickCentreOf('[data-testid="export-document"]');
  await browser.waitUntil(
    () => browser.execute(() => document.querySelector('[data-testid="export-dialog"]') !== null),
    { timeout: 5000, interval: 50, timeoutMsg: "the export dialog never opened" },
  );
}

/** Selects `preset` (when given; the dialog's own default is DOCX) and clicks Export, then waits
 * for the same resolving condition one-workflow.spec.ts's step 7 uses — the dialog closing
 * (success) or an `export-error` node appearing in it (failure) — so a real pandoc/typst failure
 * surfaces its own message instead of this `waitUntil` timing out first and masking it (task 4.18,
 * DECISIONS #064). Asserts no error and returns once the dialog is gone. */
async function runExportThroughDialog(preset?: "docx" | "html" | "pdf" | "epub"): Promise<void> {
  if (preset !== undefined) await clickCentreOf(`[data-testid="export-format-${preset}"]`);
  await clickCentreOf('[data-testid="export-run"]');
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          document.querySelector('[data-testid="export-dialog"]') === null ||
          document.querySelector('[data-testid="export-error"]') !== null,
      ),
    { timeout: 60000, interval: 50, timeoutMsg: "the export dialog never closed after Export" },
  );
  const exportError = await browser.execute(
    () => document.querySelector('[data-testid="export-error"]')?.textContent ?? null,
  );
  assert.equal(exportError, null, `the export reported an error: ${exportError}`);
  const dialogGone = await browser.execute(() => document.querySelector('[data-testid="export-dialog"]') === null);
  assert.ok(dialogGone, "the export dialog is still open after a successful export");
}

describe("File -> Export, all four presets on a document with images (task 4.29)", () => {
  let workspace: string;
  let danglingWorkspace: string;

  before(() => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-export-"));
    cpSync(`${FIXTURES}/${FIXTURE_DOC}`, join(workspace, FIXTURE_DOC));
    cpSync(`${FIXTURES}/assets/essay`, join(workspace, "assets/essay"), { recursive: true });

    // The dangling copy lives in its own, otherwise-empty workspace: pandoc resolves a relative
    // image reference against its own working directory *in addition to* `--resource-path`
    // (confirmed directly — it is not a replacement for the default search), so a sibling copy of
    // `assets/essay/pen-materials.png` anywhere under the same root would silently resolve the
    // reference `workspace` above exists to exercise. Here only one of the two referenced images
    // is copied in at all, so pandoc's `--resource-path` (the document's own directory) finds one
    // and warns about the other (lesson [4.0]: a missing image is a warning, not a failure).
    danglingWorkspace = mkdtempSync(join(tmpdir(), "essaydown-export-dangling-"));
    mkdirSync(join(danglingWorkspace, "assets", "essay"), { recursive: true });
    cpSync(`${FIXTURES}/${FIXTURE_DOC}`, join(danglingWorkspace, FIXTURE_DOC));
    cpSync(`${FIXTURES}/assets/essay/golden-age-advert.png`, join(danglingWorkspace, "assets/essay/golden-age-advert.png"));
  });

  it("DOCX: unzip -t reports no errors and the archive holds 2 word/media/ members", async function () {
    this.timeout(60000);
    await openThroughRestore(workspace, FIXTURE_DOC);
    await openExportDialog();
    await runExportThroughDialog("docx");

    const docxPath = join(workspace, outputPathFor(FIXTURE_DOC, "docx"));
    const integrity = runExternal("unzip", ["-t", docxPath]);
    assert.ok(integrity.includes("No errors detected"), `unzip -t did not report a clean archive: ${integrity}`);
    const media = unzipMembers(docxPath).filter((name) => name.startsWith("word/media/"));
    assert.equal(media.length, 2, `expected 2 word/media/ members, got ${media.length}: ${media.join(", ")}`);
  });

  it("HTML: passes html-validate (4.25's config) and every <img> is an embedded data: URI", async function () {
    this.timeout(60000);
    await openThroughRestore(workspace, FIXTURE_DOC);
    await openExportDialog();
    await runExportThroughDialog("html");

    const htmlPath = join(workspace, outputPathFor(FIXTURE_DOC, "html"));
    const configPath = fileURLToPath(new URL("../../../.htmlvalidate.json", import.meta.url));
    // `element-required-attributes` (the `<html lang>` requirement) is a known, already-backlogged
    // gap, test-only even in the direct pandoc-invocation suite: `buildPandocArgs`/`pandoc_args`
    // never add `--metadata lang=`, and this dialog drives the real app route with no hook to add
    // one (docs/V1.1-BACKLOG.md "[4.24, U1 title fixed] The HTML `lang` attribute stays test-only");
    // confirmed directly (pandoc 3.11's HTML writer never falls back to the process locale the way
    // its EPUB writer does, DECISIONS #065). Turned off here only, the same test-only spirit as
    // `packages/export/test/integration.test.ts`'s own `LANG_EXCEPTION` — never in the committed
    // `.htmlvalidate.json`, which stays exactly 4.25's.
    assert.doesNotThrow(() =>
      runExternal("html-validate", ["--config", configPath, "--rule", "element-required-attributes:off", htmlPath], true),
    );

    const html = readFileSync(htmlPath, "utf8");
    const srcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1] as string);
    assert.equal(srcs.length, 2, `expected 2 <img> elements, got ${srcs.length}`);
    for (const src of srcs) assert.ok(src.startsWith("data:"), `<img src> is not a data: URI: ${src}`);
  });

  it("PDF: pdfimages -list holds 2 rows and pdftotext holds every heading title", async function () {
    this.timeout(60000);
    await openThroughRestore(workspace, FIXTURE_DOC);
    await openExportDialog();
    await runExportThroughDialog("pdf");

    const pdfPath = join(workspace, outputPathFor(FIXTURE_DOC, "pdf"));
    const imagesList = runExternal("pdfimages", ["-list", pdfPath]);
    const imageRows = imagesList.trim().split("\n").slice(2);
    assert.equal(imageRows.length, 2, `expected 2 pdfimages -list rows, got ${imageRows.length}: ${imagesList}`);

    const text = normalizeWhitespace(runExternal("pdftotext", [pdfPath, "-"]));
    for (const heading of fixtureHeadings) assert.ok(text.includes(heading), `pdftotext output is missing the heading ${JSON.stringify(heading)}`);
  });

  it("EPUB: passes epubcheck with 0 errors", async function () {
    this.timeout(60000);
    await openThroughRestore(workspace, FIXTURE_DOC);
    await openExportDialog();
    await runExportThroughDialog("epub");

    const epubPath = join(workspace, outputPathFor(FIXTURE_DOC, "epub"));
    assert.doesNotThrow(() => runExternal("epubcheck", [epubPath], true));
  });

  it("a document with a dangling image reference shows the missing-image toast, dialog closed", async function () {
    this.timeout(60000);
    await openThroughRestore(danglingWorkspace, FIXTURE_DOC);
    await openExportDialog();
    await runExportThroughDialog(); // the dialog's own default preset, DOCX

    await browser.waitUntil(
      () => browser.execute(() => document.querySelector('[data-testid="export-warning"]') !== null),
      { timeout: 5000, interval: 50, timeoutMsg: "the missing-image toast never appeared" },
    );
    const dialogStillOpen = await browser.execute(() => document.querySelector('[data-testid="export-dialog"]') !== null);
    assert.equal(dialogStillOpen, false, "the export dialog is still open once the missing-image toast appeared");
    const warning = await browser.execute(() => document.querySelector('[data-testid="export-warning"]')?.textContent ?? null);
    assert.ok(warning?.includes("Could not fetch resource"), `the toast does not read as a missing-resource warning: ${warning}`);
  });
});
