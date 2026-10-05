import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../../../packages/core/src/parse.js";
import { sectionsOf, normalizedText } from "../../../packages/core/src/blocks.js";
import { attach, parseSidecar, type Sidecar } from "../../../packages/core/src/sidecar.js";
import { clickCentreOf, dragBetween, reloadPage, typeText } from "./routes.js";

// Outline mode (task 3.2). Acceptance, on essay-fixture: set a question on section 3 → the sidecar
// has it and the Markdown is unchanged; drag section 5 under section 2 → the Markdown equals
// fixtures/markdown/expected/essay-fixture.nested.md; add 'Why now?' → a new '## Why now?' heading,
// anchored; delete the sidecar and reopen → the headings, with empty question fields.
//
// Sections are numbered as `sectionsOf` numbers them, from 0 — the numbering task 0.7's
// `moveSection(2,0)` golden used — so section 3 is "Lewis Waterman and the Capillary Feed", section
// 5 is "The Golden Age of the Fountain Pen" (an H2) and section 2 is "The Patents of the Early
// Fountain Pen Age" (an H3); nesting 5 under 2 makes it an H4 at the end of section 2.
//
// The workspace holds the fixture's canonical bytes, so "the Markdown is unchanged" holds of the
// file on disk as well as of the store: a save of a canonical document rewrites nothing in it.
// The same constraints as modes.spec.ts: every read is a `browser.execute`, every click and drag a
// pointer action at a computed point (routes.ts), and the workspace is opened through the
// persisted-restore key and a reload.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const CANONICAL = readFileSync(join(FIXTURES, "essay-fixture.canonical.md"), "utf8");
const NESTED = readFileSync(join(FIXTURES, "expected/essay-fixture.nested.md"), "utf8");
const WITH_NEW = `${NESTED}\n## Why now?\n`;
// No letter typed twice in a row: WebKitWebDriver drops the second of two identical consecutive
// key presses ("feed" arrived as "fed" in this container).
const QUESTION = "Who made this nib write?";
const FILE = "essay-fixture.md";
const SIDECAR = "essay-fixture.essaydown.json";

interface Readout {
  readonly mode: string | null;
  readonly markdown: string;
  readonly snapshots: number;
}

async function readout(): Promise<Readout> {
  return browser.execute(() => {
    const hook = (window as unknown as { __essaydown?: Record<string, () => unknown> }).__essaydown;
    if (hook === undefined) throw new Error("window.__essaydown is not installed");
    return {
      mode: document.querySelector('[data-testid="app-shell"]')?.getAttribute("data-mode") ?? null,
      markdown: hook.markdown() as string,
      snapshots: hook.snapshots() as number,
    };
  });
}

/** The Outline's main-pane rows: each title, and its question field's value. */
async function outlineRows(): Promise<{ title: string; question: string; depth: string | null }[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="outline-section"]')).map((row) => ({
      title: row.querySelector('[data-testid="outline-section-title"]')?.textContent ?? "",
      question: (row.querySelector('[data-testid="question-field"]') as HTMLInputElement | null)?.value ?? "<none>",
      depth: row.getAttribute("data-depth"),
    })),
  );
}

async function treeRows(): Promise<{ text: string; depth: string | null }[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="outline-tree-row"]')).map((row) => ({
      text: row.textContent?.replace("⠿", "") ?? "",
      depth: row.getAttribute("data-depth"),
    })),
  );
}

async function rectOf(selector: string): Promise<{ x: number; y: number; left: number; width: number }> {
  const rect = await browser.execute((sel) => {
    const element = document.querySelector(sel);
    if (element === null) return null;
    element.scrollIntoView({ block: "nearest" });
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, left: box.left, width: box.width };
  }, selector);
  assert.ok(rect !== null, `${selector} is not on the page`);
  return { x: Math.round(rect.x), y: Math.round(rect.y), left: Math.round(rect.left), width: Math.round(rect.width) };
}

async function openThroughRestore(folder: string, file: string): Promise<void> {
  await browser.execute((key, value) => localStorage.setItem(key, value), STORAGE_KEY, JSON.stringify({ folder, file }));
  await reloadPage();
  await browser.waitUntil(
    () =>
      browser.execute(
        (name, editorSel) =>
          document.querySelector('[data-testid="current-file"]')?.textContent === name &&
          document.querySelector(editorSel) !== null &&
          document.querySelector('[data-testid="outline-panel"]') !== null &&
          "__essaydown" in window,
        file,
        EDITOR,
      ),
    { timeout: 15000, interval: 25, timeoutMsg: `${file} never opened with the Outline` },
  );
}

/** The sidecar on disk, parsed, or null while there is none (or it is mid-write). */
function diskSidecar(path: string): Sidecar | null {
  if (!existsSync(path)) return null;
  try {
    return parseSidecar(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** The heading texts of a Markdown document, in order. */
function headingTexts(markdown: string): string[] {
  return sectionsOf(parse(markdown)).map((section) => normalizedText(section.heading));
}

describe("Outline mode (task 3.2)", () => {
  let workspace: string;
  let doc: string;
  let sidecarPath: string;

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-outline-"));
    doc = join(workspace, FILE);
    sidecarPath = join(workspace, SIDECAR);
    writeFileSync(doc, CANONICAL);
    await openThroughRestore(workspace, FILE);
  });

  it("set a question on section 3: the sidecar has it, the Markdown is unchanged", async function () {
    this.timeout(60000);
    const before = await readout();
    assert.equal(before.mode, "outline");
    assert.equal(before.markdown, CANONICAL);
    const headings = headingTexts(CANONICAL);
    assert.deepEqual(
      (await outlineRows()).map((row) => row.title),
      headings,
    );
    assert.equal(headings[3], "Lewis Waterman and the Capillary Feed");

    const field = '[data-testid="question-field"][data-index="3"]';
    await rectOf(field);
    await clickCentreOf(field);
    await typeText(field, QUESTION);
    await browser.keys(["Enter"]);

    await browser.waitUntil(() => diskSidecar(sidecarPath)?.headings.some((entry) => entry.question === QUESTION) === true, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "the question never reached the sidecar on disk",
    });
    const sidecar = diskSidecar(sidecarPath) as Sidecar;
    assert.equal(sidecar.headings.length, 1);
    assert.equal(sidecar.headings[0].anchor.kind, "heading");
    assert.equal(sidecar.headings[0].anchor.text, headings[3]);
    // The anchor resolves to section 3's heading in the file as it is on disk.
    const onDisk = parse(readFileSync(doc, "utf8"));
    const attached = attach(sidecar, onDisk);
    assert.equal(attached.sidecar.orphans.length, 0);
    assert.equal(attached.sidecar.headings[0].anchor.pos[0], sectionsOf(onDisk)[3].start);

    const after = await readout();
    assert.equal(after.markdown, CANONICAL, "the question changed the Markdown");
    assert.equal(readFileSync(doc, "utf8"), CANONICAL, "the question changed the file on disk");
    assert.equal(after.snapshots, before.snapshots + 1, "a question edit is one undo step");
    assert.equal((await outlineRows())[3].title, QUESTION);
    assert.equal((await outlineRows())[3].question, QUESTION);
  });

  it("drag section 5 under section 2: the Markdown equals expected/essay-fixture.nested.md", async function () {
    this.timeout(60000);
    const before = await readout();
    const handle = await rectOf('[data-testid="outline-tree-row"][data-index="5"] [data-testid="outline-tree-handle"]');
    const target = await rectOf('[data-testid="outline-tree-row"][data-index="2"]');
    // Onto row 2, and far enough right to nest (NEST_OFFSET_PX, apps/desktop/src/outline/outline-view.ts).
    await dragBetween({ x: handle.x, y: handle.y }, { x: handle.x + 70, y: target.y });

    await browser.waitUntil(async () => (await readout()).markdown === NESTED, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "the drag never produced the nested document",
    });
    assert.equal((await readout()).snapshots, before.snapshots + 1, "a drop is one undo step");
    await browser.waitUntil(() => readFileSync(doc, "utf8") === NESTED, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "the nested document never reached the disk",
    });
    const tree = await treeRows();
    assert.deepEqual(tree[3], { text: "The Golden Age of the Fountain Pen", depth: "4" });
    // Section 3's question moved with its heading, which is now section 4.
    const rows = await outlineRows();
    assert.equal(rows[4].question, QUESTION);
    await browser.waitUntil(
      () => {
        const sidecar = diskSidecar(sidecarPath);
        return sidecar !== null && sidecar.headings[0]?.anchor.pos[0] === sectionsOf(parse(NESTED))[4].start;
      },
      { timeout: 5000, interval: 50, timeoutMsg: "the question's anchor never followed its heading on disk" },
    );
  });

  it("add 'Why now?': a new '## Why now?' heading, anchored", async function () {
    this.timeout(60000);
    const before = await readout();
    await rectOf('[data-testid="new-question"]');
    await clickCentreOf('[data-testid="new-question"]');
    await typeText('[data-testid="new-question"]', "Why now?");
    await clickCentreOf('[data-testid="add-question"]');

    await browser.waitUntil(async () => (await readout()).markdown === WITH_NEW, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "'Why now?' never became a heading",
    });
    assert.equal((await readout()).snapshots, before.snapshots + 1, "New question is one undo step");
    await browser.waitUntil(
      () =>
        readFileSync(doc, "utf8") === WITH_NEW &&
        diskSidecar(sidecarPath)?.headings.some((entry) => entry.question === "Why now?") === true,
      { timeout: 5000, interval: 50, timeoutMsg: "'Why now?' never reached the disk with its question" },
    );
    const sidecar = diskSidecar(sidecarPath) as Sidecar;
    const entry = sidecar.headings.find((one) => one.question === "Why now?");
    assert.ok(entry !== undefined);
    assert.equal(entry.anchor.kind, "heading");
    assert.equal(entry.anchor.text, "Why now?");
    assert.equal(entry.anchor.depth, 2);
    const onDisk = parse(WITH_NEW);
    const attached = attach(sidecar, onDisk);
    assert.equal(attached.sidecar.orphans.length, 0, "an anchor on disk does not resolve");
    const sections = sectionsOf(onDisk);
    assert.equal(
      attached.sidecar.headings.find((one) => one.question === "Why now?")?.anchor.pos[0],
      sections[sections.length - 1].start,
    );
    const rows = await outlineRows();
    assert.deepEqual(rows[rows.length - 1], { title: "Why now?", question: "Why now?", depth: "2" });
  });

  it("delete the sidecar and reopen: the headings, with empty question fields", async function () {
    this.timeout(60000);
    assert.equal(readFileSync(doc, "utf8"), WITH_NEW);
    rmSync(sidecarPath);
    await openThroughRestore(workspace, FILE);

    const headings = headingTexts(WITH_NEW);
    const rows = await outlineRows();
    assert.deepEqual(
      rows.map((row) => row.title),
      headings,
    );
    assert.ok(headings.length > 1);
    for (const row of rows) assert.equal(row.question, "", `${row.title} kept a question without a sidecar`);
    assert.deepEqual(
      (await treeRows()).map((row) => row.text),
      headings,
    );
    const topic = await browser.execute(
      () => (document.querySelector('[data-testid="topic-question"]') as HTMLInputElement | null)?.value ?? null,
    );
    assert.equal(topic, "");
    assert.equal((await readout()).markdown, WITH_NEW);
    assert.equal(existsSync(sidecarPath), false, "opening wrote a sidecar");
  });
});
