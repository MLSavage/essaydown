import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, parse } from "../../../packages/core/src/index.js";
import { applyMoveBlock, emptySidecar } from "../../../packages/core/src/sidecar.js";
import { mdastToPM } from "../../../packages/editor/src/schema.js";
import { caretAtText, clickCentreOf, pressModChord, reloadPage, setRenameField, typeText } from "./routes.js";

// The §146 source toggle in the desktop shell (task 3.19; DECISIONS #054). Cmd/Ctrl+/ swaps the
// pane's one mounted view — ProseMirror or CodeMirror — over its one store; the pane root carries
// `data-surface`. Every chord goes through `pressModChord`; the rendered caret is placed only by
// `caretAtText`'s click (DECISIONS #022); every typed string is letters only, with no two identical
// consecutive characters (WebKitWebDriver drops the second of two identical key presses).
//
// The workspace is seeded with fixtures/markdown/essay-fixture.md as it is (not its canonical
// form): the source view shows `format(root)`, so case 1 compares against `format(parse(file))`.
// "Paragraph 2" is the essay's second top-level paragraph ("Writing with a liquid ink …"), whose
// line in the canonical text is read from index.json's `paragraphStartLines` and located by text.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const SOURCE = '[data-testid="source"] .cm-content';
const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const FILE = "essay-fixture.md";
const OTHER = "other.md";
/** The open file's new name in the rename guard: letters only, no doubled letter. */
const RENAMED = "moved.md";
const ESSAY = readFileSync(join(FIXTURES, FILE), "utf8");
const CANONICAL = format(parse(ESSAY));
const INDEX = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8")) as Record<
  string,
  { paragraphStartLines: number[] }
>;
const PARAGRAPH_LINE = INDEX[FILE].paragraphStartLines[1];

/** Paragraph 2's first word, by which its line and its block are found. */
const LEAD = "Writing";
/** The first second-level heading: short, so a click into it stays on screen in every mode's column. */
const HEADING = `${EDITOR} > h2`;
/** Between "Writing" and " with" in paragraph 2 — no mark before it, so a plain-text offset is a `ch`. */
const OFFSET = 7;
/** Case (1)'s confirmed click target: inside the heading's text, past its leading character. */
const HEADING_OFFSET = 2;

interface Readout {
  readonly surface: string | null;
  readonly mode: string | null;
  readonly markdown: string;
  readonly cursor: number | null;
  readonly snapshots: number;
  readonly rendered: boolean;
  readonly source: boolean;
}

async function readout(): Promise<Readout> {
  return browser.execute(
    (editorSel, sourceSel) => {
      const hook = (window as unknown as { __essaydown?: Record<string, () => unknown> }).__essaydown;
      if (hook === undefined) throw new Error("window.__essaydown is not installed");
      return {
        surface: document.querySelector('[data-testid="document"]')?.getAttribute("data-surface") ?? null,
        mode: document.querySelector('[data-testid="app-shell"]')?.getAttribute("data-mode") ?? null,
        markdown: hook.markdown() as string,
        cursor: hook.cursor() as number | null,
        snapshots: hook.snapshots() as number,
        rendered: document.querySelector(editorSel) !== null,
        source: document.querySelector(sourceSel) !== null,
      };
    },
    EDITOR,
    SOURCE,
  );
}

/** The surface's DOM contract: only that view's host and editor are on the page. */
async function surfaceDom(): Promise<{ surface: string | null; proseMirror: number; sourceHost: number; cmContent: number }> {
  return browser.execute(() => ({
    surface: document.querySelector('[data-testid="document"]')?.getAttribute("data-surface") ?? null,
    proseMirror: document.querySelectorAll(".ProseMirror").length,
    sourceHost: document.querySelectorAll('[data-testid="source"]').length,
    cmContent: document.querySelectorAll('[data-testid="source"] .cm-content').length,
  }));
}

/**
 * Cmd/Ctrl+/ and wait for `surface` to be the one showing, with its view focused — two waits in
 * sequence (DECISIONS #055) so a failure names which half missed: the surface attribute never
 * flipping, or the view never taking focus once it had.
 */
async function toggleTo(surface: "rendered" | "source"): Promise<void> {
  await pressModChord("/");
  const selector = surface === "source" ? SOURCE : EDITOR;
  await browser.waitUntil(
    () =>
      browser.execute(
        (want) => document.querySelector('[data-testid="document"]')?.getAttribute("data-surface") === want,
        surface,
      ),
    { timeout: 2500, interval: 25, timeoutMsg: `Cmd/Ctrl+/ never showed the ${surface} surface` },
  );
  await browser.waitUntil(
    () => browser.execute((sel) => document.activeElement === document.querySelector(sel), selector),
    { timeout: 2500, interval: 25, timeoutMsg: `the ${surface} view never took focus` },
  );
}

/**
 * Every `.cm-line` of the source view, joined. CodeMirror renders only the lines near the viewport,
 * so the scroll container is stepped from top to bottom and each rendered line is keyed by its line
 * number, which the view's own `posAtDOM` gives (the view is read from `.cm-content` the way
 * `EditorView.findFromDOM` reads it in @codemirror/view 6.43). Throws if any line was never drawn.
 */
async function sourceLines(): Promise<string> {
  const lines = new Map<number, string>();
  let total = -1;
  for (let step = 0; step < 400; step += 1) {
    const atEnd = await browser.execute((index) => {
      const main = document.querySelector('[data-testid="main"]') as HTMLElement | null;
      if (main === null) return true;
      main.scrollTop = index * Math.max(1, Math.floor(main.clientHeight / 2));
      return main.scrollTop + main.clientHeight >= main.scrollHeight - 1;
    }, step);
    // CodeMirror measures and redraws its viewport on the frame after a scroll.
    await browser.pause(150);
    const seen = await browser.execute((sel) => {
      const content = document.querySelector(sel) as (Element & { cmTile?: { root?: { view?: unknown } } }) | null;
      const view = content?.cmTile?.root?.view as
        | {
            posAtDOM(node: Node, offset?: number): number;
            state: { doc: { lines: number; lineAt(pos: number): { number: number } } };
          }
        | undefined;
      if (content === null || view === undefined) return null;
      return {
        lines: view.state.doc.lines,
        drawn: Array.from(content.querySelectorAll(".cm-line")).map((line) => [
          view.state.doc.lineAt(view.posAtDOM(line, 0)).number,
          line.textContent ?? "",
        ]) as [number, string][],
      };
    }, SOURCE);
    assert.ok(seen !== null, "the source view (or its EditorView) is not on the page");
    total = seen.lines;
    for (const [number, text] of seen.drawn) lines.set(number, text);
    if (lines.size === total || atEnd) break;
  }
  const missing = Array.from({ length: total }, (_, index) => index + 1).filter((number) => !lines.has(number));
  assert.deepEqual(missing, [], "some source lines were never drawn");
  return Array.from({ length: total }, (_, index) => lines.get(index + 1) as string).join("\n");
}

/** The source caret, read from the DOM selection: its line's text and its offset in that line. */
async function sourceCaret(): Promise<{ text: string; ch: number } | null> {
  return browser.execute(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    if (selection === null || anchor === null) return null;
    const element = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element);
    const line = element?.closest(".cm-line") ?? null;
    if (line === null) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let ch = 0;
    let node = walker.nextNode();
    while (node !== null && node !== anchor) {
      ch += node.textContent?.length ?? 0;
      node = walker.nextNode();
    }
    return { text: line.textContent ?? "", ch: ch + (node === anchor ? selection.anchorOffset : 0) };
  });
}

/** Paragraph 2's line in `markdown`, located by its text (case 5's move shifts it). */
function paragraphOf(markdown: string): string {
  const line = markdown.split("\n").find((one) => one.startsWith(LEAD));
  assert.ok(line !== undefined, "paragraph 2 is not in the Markdown");
  return line;
}

/** `markdown` with `text` inserted at paragraph 2's `OFFSET`. */
function typedInto(markdown: string, text: string): string {
  const at = markdown.indexOf(paragraphOf(markdown));
  return markdown.slice(0, at + OFFSET) + text + markdown.slice(at + OFFSET);
}

/** Paragraph 2's block in the rendered view, by its text — its child index moves with case 5. */
async function paragraphBlock(): Promise<string> {
  const index = await browser.execute(
    (sel, lead) => Array.from(document.querySelector(sel)?.children ?? []).findIndex((child) => (child.textContent ?? "").startsWith(lead)),
    EDITOR,
    LEAD,
  );
  assert.ok(index >= 0, "paragraph 2 is not in the rendered view");
  return `${EDITOR} > :nth-child(${index + 1})`;
}

async function openThroughRestore(folder: string, file: string): Promise<void> {
  await browser.execute((key, value) => localStorage.setItem(key, value), STORAGE_KEY, JSON.stringify({ folder, file }));
  await reloadPage();
  await waitOpen(file);
}

async function waitOpen(file: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (name, editorSel) =>
          document.querySelector('[data-testid="current-file"]')?.textContent === name &&
          document.querySelector(editorSel) !== null &&
          "__essaydown" in window,
        file,
        EDITOR,
      ),
    { timeout: 15000, interval: 25, timeoutMsg: `${file} never opened` },
  );
}

/** The ProseMirror position of paragraph 2's `OFFSET` in the document `markdown` parses to. */
function paragraphHead(markdown: string): number {
  const { doc } = mdastToPM(parse(markdown));
  let head = -1;
  doc.forEach((node, offset) => {
    if (head < 0 && node.textContent.startsWith(LEAD)) head = offset + 1 + OFFSET;
  });
  assert.ok(head >= 0, "paragraph 2 is not in the editor's document");
  return head;
}

/**
 * The rendered caret at paragraph 2's `OFFSET`, confirmed in the editor's own state (the store's
 * cursor), not the DOM's (lesson [3.9]). The click is at a computed point, and in this container it
 * occasionally lands one character over or in the next block (a run of this spec read the cursor
 * at 878 for 877 straight after the click, and once in the following paragraph), so a click whose
 * caret the editor does not report is made again.
 */
async function caretAtParagraph(): Promise<void> {
  const head = paragraphHead((await readout()).markdown);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await caretAtText(EDITOR, await paragraphBlock(), OFFSET);
    const placed = await browser
      .waitUntil(async () => (await readout()).cursor === head, { timeout: 1500, interval: 25 })
      .catch(() => false);
    if (placed) return;
  }
  assert.fail(`the click never put the editor's caret at ${head}`);
}

/** From the rendered view: the caret at paragraph 2's `OFFSET`, then Cmd/Ctrl+/ into the source. */
async function intoSourceAtParagraph(): Promise<void> {
  await caretAtParagraph();
  await toggleTo("source");
}

/** The ProseMirror position of offset 2 in the first depth-2 heading of the document `markdown`
 * parses to (block offset + 1 + 2; a heading, so no mark lies before the offset). */
function headingHead(markdown: string): number {
  const { doc } = mdastToPM(parse(markdown));
  let head = -1;
  doc.forEach((node, offset) => {
    if (head < 0 && node.type.name === "heading" && node.attrs.depth === 2) head = offset + 1 + HEADING_OFFSET;
  });
  assert.ok(head >= 0, "the first depth-2 heading is not in the editor's document");
  return head;
}

/**
 * The rendered caret at the first depth-2 heading's offset 2, confirmed in both the editor's own
 * state (the store's cursor) and its focus — case (1)'s click is the first pointer event after
 * `openThroughRestore`'s reload, before which the editor holds no focus at all (DECISIONS #055);
 * a click whose caret or focus the editor does not confirm is made again, as `caretAtParagraph`
 * already does for its own target.
 */
async function caretAtHeading(): Promise<void> {
  const head = headingHead((await readout()).markdown);
  let lastCursor: number | null = null;
  let lastFocused = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await caretAtText(EDITOR, HEADING, HEADING_OFFSET);
    const placed = await browser
      .waitUntil(
        async () => {
          lastCursor = (await readout()).cursor;
          lastFocused = await browser.execute(
            (sel) => document.activeElement === document.querySelector(sel),
            EDITOR,
          );
          return lastCursor === head && lastFocused;
        },
        { timeout: 1500, interval: 25 },
      )
      .catch(() => false);
    if (placed) return;
  }
  assert.fail(`the click never put the editor's caret at ${head} with focus (cursor ${lastCursor}, focused ${lastFocused})`);
}

describe("the source toggle in the desktop shell (task 3.19, PRD §146)", () => {
  let workspace: string;
  let doc: string;

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-source-toggle-"));
    doc = join(workspace, FILE);
    writeFileSync(doc, ESSAY);
    writeFileSync(join(workspace, OTHER), "Another file.\n");
    await openThroughRestore(workspace, FILE);
  });

  it("(1) Cmd/Ctrl+/ shows the source view holding format(parse(file)) byte-exact, and back; the pair changes nothing", async function () {
    this.timeout(90000);
    assert.equal(CANONICAL.split("\n")[PARAGRAPH_LINE - 1], paragraphOf(CANONICAL), "index.json's line is not paragraph 2's");
    await caretAtHeading();
    const before = await readout();
    assert.equal(before.surface, "rendered");
    assert.equal(before.markdown, CANONICAL);
    const disk = readFileSync(doc, "utf8");

    await toggleTo("source");
    assert.deepEqual(await surfaceDom(), { surface: "source", proseMirror: 0, sourceHost: 1, cmContent: 1 });
    assert.equal(await sourceLines(), CANONICAL);

    await toggleTo("rendered");
    assert.deepEqual(await surfaceDom(), { surface: "rendered", proseMirror: 1, sourceHost: 0, cmContent: 0 });
    const after = await readout();
    assert.equal(after.markdown, before.markdown);
    assert.equal(after.snapshots, before.snapshots);
    assert.equal(readFileSync(doc, "utf8"), disk);
  });

  it("(2) the rendered caret lands on paragraph 2's line at its ch, and comes back to where it was", async function () {
    this.timeout(60000);
    await caretAtParagraph();
    const before = (await readout()).cursor;

    await toggleTo("source");
    let caret: { text: string; ch: number } | null = null;
    await browser.waitUntil(
      async () => {
        caret = await sourceCaret();
        return caret !== null;
      },
      { timeout: 5000, interval: 25, timeoutMsg: "the source view never showed a caret" },
    );
    const at = caret as unknown as { text: string; ch: number };
    // Located by text: the caret's line is the one in the canonical text that index.json names.
    assert.equal(CANONICAL.split("\n").indexOf(at.text) + 1, PARAGRAPH_LINE);
    assert.equal(at.ch, OFFSET);

    await toggleTo("rendered");
    assert.equal((await readout()).cursor, before);
  });

  it("(3) text typed in the source view and toggled back at once is in the rendered view, markdown() and on disk, and still after 1.5 s", async function () {
    this.timeout(60000);
    const before = (await readout()).markdown;
    const expected = typedInto(before, "Zebu");
    await intoSourceAtParagraph();
    await typeText(SOURCE, "Zebu");
    await toggleTo("rendered");

    const block = await paragraphBlock();
    const shown = async (): Promise<string> =>
      browser.execute((sel) => document.querySelector(sel)?.textContent ?? "", block);
    assert.ok((await shown()).startsWith("WritingZebu with"), "the rendered view lost the typed text");
    assert.equal((await readout()).markdown, expected);
    await browser.waitUntil(() => readFileSync(doc, "utf8") === expected, {
      timeout: 10000,
      interval: 50,
      timeoutMsg: "the typed text never reached the disk",
    });
    await browser.pause(1500);
    assert.ok((await shown()).startsWith("WritingZebu with"));
    assert.equal((await readout()).markdown, expected);
    assert.equal(readFileSync(doc, "utf8"), expected);
  });

  it("(4) text typed in the source view, then at once a switch to another file, is on the first file's disk", async function () {
    this.timeout(60000);
    const before = (await readout()).markdown;
    const expected = typedInto(before, "Kiwa");
    await intoSourceAtParagraph();
    await typeText(SOURCE, "Kiwa");
    await clickCentreOf(`[data-testid="tree-entry:${OTHER}"]`);
    await waitOpen(OTHER);
    // The switch waited for the pane's flush, which settled the burst first: no wait here.
    assert.equal(readFileSync(doc, "utf8"), expected);

    await clickCentreOf(`[data-testid="tree-entry:${FILE}"]`);
    await waitOpen(FILE);
    assert.equal((await readout()).markdown, expected);
  });

  it("(5) text typed in the source view, then at once a dispatched moveBlock, leaves both in markdown()", async function () {
    this.timeout(60000);
    const before = (await readout()).markdown;
    const typed = typedInto(before, "Lynxo");
    const expected = format(applyMoveBlock({ root: parse(typed), sidecar: emptySidecar() }, 0, 2).root);
    assert.notEqual(expected, typed, "the move changes nothing");
    assert.ok(expected.includes("WritingLynxo"));
    await intoSourceAtParagraph();
    await typeText(SOURCE, "Lynxo");
    await browser.execute(() => {
      const hook = (window as unknown as {
        __essaydown: { dispatch(mutation: unknown): void; moveBlock(from: number, to: number): unknown };
      }).__essaydown;
      hook.dispatch(hook.moveBlock(0, 2));
    });
    assert.equal((await readout()).markdown, expected);
    await browser.pause(1500);
    assert.equal((await readout()).markdown, expected);
    await toggleTo("rendered");
    assert.equal((await readout()).markdown, expected);
  });

  it("(6) a toggle pair in each of the four modes leaves the mode and markdown() unchanged and shows the source view", async function () {
    this.timeout(120000);
    const modes: string[] = [];
    for (const key of ["1", "2", "3", "4"]) {
      await pressModChord(key);
      await browser.waitUntil(async () => !modes.includes((await readout()).mode ?? ""), {
        timeout: 5000,
        interval: 25,
        timeoutMsg: `Cmd/Ctrl+${key} never switched the mode`,
      });
      const before = await readout();
      assert.ok(before.mode !== null);
      modes.push(before.mode);
      await caretAtText(EDITOR, HEADING, 2);
      await toggleTo("source");
      const inSource = await readout();
      assert.deepEqual(await surfaceDom(), { surface: "source", proseMirror: 0, sourceHost: 1, cmContent: 1 });
      assert.equal(inSource.mode, before.mode);
      await toggleTo("rendered");
      const after = await readout();
      assert.equal(after.mode, before.mode);
      assert.equal(after.markdown, before.markdown);
      assert.equal(after.snapshots, before.snapshots);
    }
    assert.equal(new Set(modes).size, 4);
  });

  it("guard test-hook readers: markdown() read at once after typing in the source view holds the typed text", async function () {
    this.timeout(60000);
    await pressModChord("1");
    const before = (await readout()).markdown;
    const expected = typedInto(before, "Mojave");
    await intoSourceAtParagraph();
    await typeText(SOURCE, "Mojave");
    assert.equal((await readout()).markdown, expected);
    await toggleTo("rendered");
  });

  it("guard pane rename: text typed in the source view, then at once a rename of the open file, is in the renamed file", async function () {
    this.timeout(60000);
    const before = (await readout()).markdown;
    const expected = typedInto(before, "Quetzal");
    await intoSourceAtParagraph();
    await typeText(SOURCE, "Quetzal");
    // F2 on the open file's row, focused without a click: a click on a row opens it, and the
    // switch's flush would settle the burst before the rename could.
    await browser.execute((sel) => (document.querySelector(sel) as HTMLElement | null)?.focus(), `[data-testid="tree-entry:${FILE}"]`);
    await browser.keys(["F2"]);
    await browser.waitUntil(() => browser.execute(() => document.querySelector('[data-testid="rename-input"]') !== null), {
      timeout: 5000,
      interval: 10,
      timeoutMsg: "rename-input never appeared",
    });
    await setRenameField(RENAMED);
    await browser.keys(["Enter"]);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelector('[data-testid="current-file"]')?.textContent)) === RENAMED,
      { timeout: 5000, interval: 10, timeoutMsg: `current-file never became ${RENAMED}` },
    );
    // The rename's write ran inside the pane's `rename`, which settled the burst first: no wait.
    assert.equal(readFileSync(join(workspace, RENAMED), "utf8"), expected);
  });
});
