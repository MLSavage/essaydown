import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../../../packages/core/src/parse.js";
import { emptySidecar } from "../../../packages/core/src/sidecar.js";
import { applySetQuestion } from "../../../packages/core/src/outline.js";
import { caretToEndOf, clickCentreOf, pressModChord, reloadPage, typeText } from "./routes.js";

// Produce mode (PRD §6.3, task 3.3). Acceptance: sidebars display:none, editor width ≤ 68ch,
// heading 2's question text present in `.question-hint`; typewriterScroll keeps the caret within
// ±40 px of vertical center across 30 typed lines; Esc returns to the previous mode.
//
// Same constraints as modes.spec.ts/outline.spec.ts: every read is a `browser.execute`, every
// click or chord one of routes.ts's own routes, and the workspace is opened through the
// persisted-restore key and a reload.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR_HOST = '[data-testid="editor"]';
const EDITOR = `${EDITOR_HOST} .ProseMirror`;
const SIDEBAR = '[data-testid="sidebar"]';
const MAIN = '[data-testid="main"]';
const QUESTION = "Why does this matter?";
// Enough filler paragraphs that the document already overflows the 800x600 e2e window before any
// typing starts — the typewriter-scroll case types onto the end of a document that is already
// scrolled, not an empty one, the same way a writer with a half-finished essay would.
const FILLER_COUNT = 20;
const FILLER = Array.from(
  { length: FILLER_COUNT },
  (_, i) => `Filler paragraph number ${i}, long enough on its own to add real height to the page.`,
).join("\n\n");
// "Heading two" (ordinal, §6.3's acceptance): the second of three headings gets the question; the
// first and third get none, so the hint's presence is a real signal and not every heading's.
const SOURCE = `## Heading One\n\nParagraph one text.\n\n## Heading Two\n\nParagraph two text.\n\n## Heading Three\n\n${FILLER}\n`;
const LINES = 30;

/** A sidecar whose section `index` carries `question`, built through the real `applySetQuestion`
 * (packages/core/src/outline.ts) rather than a hand-rolled anchor, so its shape is whatever that
 * function actually produces. */
function seededSidecar(source: string, index: number, question: string): string {
  const state = applySetQuestion({ root: parse(source), sidecar: emptySidecar() }, index, question);
  return `${JSON.stringify(state.sidecar, null, 2)}\n`;
}

async function modeOf(): Promise<string | null> {
  return browser.execute(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute("data-mode") ?? null);
}

async function displayOf(selector: string): Promise<string | null> {
  return browser.execute((sel) => {
    const element = document.querySelector(sel);
    return element === null ? null : getComputedStyle(element).display;
  }, selector);
}

async function widthOf(selector: string): Promise<number> {
  const width = await browser.execute((sel) => document.querySelector(sel)?.getBoundingClientRect().width ?? null, selector);
  assert.ok(width !== null, `${selector} is not on the page`);
  return width;
}

/** 68ch's own pixel width, measured with a hidden probe inside `selector` so it inherits that
 * element's font — never a guess from a font-size constant. */
async function chWidthOf(selector: string, ch: number): Promise<number> {
  const width = await browser.execute(
    (sel, count) => {
      const host = document.querySelector(sel);
      if (host === null) return null;
      const probe = document.createElement("span");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.width = `${count}ch`;
      host.appendChild(probe);
      const measured = probe.getBoundingClientRect().width;
      probe.remove();
      return measured;
    },
    selector,
    ch,
  );
  assert.ok(width !== null, `${selector} is not on the page`);
  return width;
}

async function questionHints(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".question-hint")).map((element) => element.textContent ?? ""),
  );
}

async function textOf(selector: string): Promise<string | null> {
  return browser.execute((sel) => document.querySelector(sel)?.textContent ?? null, selector);
}

/** The vertical centre of the editor's last paragraph's last character, minus `main`'s own
 * vertical centre — the caret's offset from dead centre, since the caret itself (typed natively,
 * right after this line's own text) sits right after that character. Reads the DOM the same way
 * editor-toggle-mark-end.spec.ts's `clickAfter` does, rather than `window.getSelection()`, which a
 * just-finished native keystroke is not guaranteed to have settled (docs/lessons.md [3.9]). */
async function lastLineCenterOffset(): Promise<number> {
  const offset = await browser.execute((editorSel, mainSel) => {
    const editor = document.querySelector(editorSel);
    const main = document.querySelector(mainSel);
    if (editor === null || main === null) return null;
    const last = editor.lastElementChild;
    if (!(last instanceof HTMLElement)) return null;
    const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
    let text: Text | null = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) text = node as Text;
    if (text === null || text.textContent === null || text.textContent.length === 0) return null;
    const length = text.textContent.length;
    const range = document.createRange();
    range.setStart(text, Math.max(0, length - 1));
    range.setEnd(text, length);
    const lineRect = range.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return lineRect.top + lineRect.height / 2 - (mainRect.top + mainRect.height / 2);
  }, EDITOR, MAIN);
  assert.ok(offset !== null, "could not measure the last typed line's vertical position");
  return offset;
}

async function openThroughRestore(folder: string, file: string): Promise<void> {
  await browser.execute((key, value) => localStorage.setItem(key, value), STORAGE_KEY, JSON.stringify({ folder, file }));
  await reloadPage();
  await browser.waitUntil(
    () =>
      browser.execute(
        (name, editorSel) =>
          document.querySelector('[data-testid="current-file"]')?.textContent === name && document.querySelector(editorSel) !== null,
        file,
        EDITOR,
      ),
    { timeout: 15000, interval: 25, timeoutMsg: `${file} never opened in the editor` },
  );
}

describe("Produce mode (task 3.3)", () => {
  let workspace: string;
  // typewriterScroll persists to a real settings file (settings-sync.ts), outside this workspace
  // and outside this spec's own session — so the test that turns it on for the typing case must
  // turn it back off after, or a later spec file (settings.spec.ts's own default-is-off case) sees
  // the setting this one left behind.
  let typewriterScrollWasOn = false;

  /** Opens Settings, sets `typewriterScroll` to `on` (toggling only if it disagrees) and closes
   * the dialog, returning the value it had before this call — so a caller can restore it later. */
  async function setTypewriterScrollTo(on: boolean): Promise<boolean> {
    await browser.keys(["Control", ","]);
    await browser.waitUntil(async () => (await textOf('[data-testid="settings-dialog"]')) !== null, {
      timeout: 15000,
      timeoutMsg: "settings-dialog never opened",
    });
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => (document.querySelector('[data-testid="typewriter-scroll-toggle"]') as HTMLInputElement | null)?.dataset.loaded,
        )) === "true",
      { timeout: 15000, timeoutMsg: "typewriter-scroll-toggle never finished loading" },
    );
    const checked = await browser.execute(
      () => (document.querySelector('[data-testid="typewriter-scroll-toggle"]') as HTMLInputElement | null)?.checked ?? false,
    );
    if (checked !== on) await (await browser.$('[data-testid="typewriter-scroll-toggle"]')).click();
    // The close button, never Escape: Escape would also fire Produce's own "back to the previous
    // mode" handler (both are plain document keydown listeners), which is not this helper's case.
    await clickCentreOf('[data-testid="settings-close"]');
    await browser.waitUntil(async () => (await textOf('[data-testid="settings-dialog"]')) === null, {
      timeout: 15000,
      timeoutMsg: "settings-dialog never closed",
    });
    return checked;
  }

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-produce-"));
    writeFileSync(join(workspace, "a.md"), SOURCE);
    writeFileSync(join(workspace, "a.essaydown.json"), seededSidecar(SOURCE, 1, QUESTION));
    await openThroughRestore(workspace, "a.md");
    assert.equal(await modeOf(), "outline");
  });

  after(async () => {
    await setTypewriterScrollTo(typewriterScrollWasOn);
  });

  it("hides the sidebars and narrows the editor to at most 68ch", async () => {
    assert.notEqual(await displayOf(SIDEBAR), "none", "the sidebar is already hidden outside Produce");
    await pressModChord("2");
    assert.equal(await modeOf(), "produce");
    assert.equal(await displayOf(SIDEBAR), "none");

    const chWidth = await chWidthOf(EDITOR_HOST, 68);
    const editorWidth = await widthOf(EDITOR_HOST);
    assert.ok(editorWidth <= chWidth + 1, `editor width ${editorWidth}px exceeds 68ch (${chWidth}px)`);
  });

  it("shows heading two's question in .question-hint; headings one and three show none", async () => {
    assert.equal(await modeOf(), "produce");
    assert.deepEqual(await questionHints(), [QUESTION]);
  });

  it("Esc returns to whichever mode was active before Produce, not a fixed default", async () => {
    await pressModChord("3");
    assert.equal(await modeOf(), "rewrite");
    await pressModChord("2");
    assert.equal(await modeOf(), "produce");
    await browser.keys(["Escape"]);
    assert.equal(await modeOf(), "rewrite");
  });

  it(`typewriterScroll keeps the caret within ±40px of vertical centre across ${LINES} typed lines`, async function () {
    this.timeout(60000);
    await pressModChord("2");
    assert.equal(await modeOf(), "produce");

    typewriterScrollWasOn = await setTypewriterScrollTo(true);
    assert.equal(await modeOf(), "produce", "closing settings left Produce mode");

    // The filler content is taller than the window, so the last paragraph needs scrolling into
    // view before a computed-point click can land on it (outline.spec.ts's `rectOf` does the same).
    await browser.execute((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), `${EDITOR} p:last-child`);
    await caretToEndOf(EDITOR, `${EDITOR} p:last-child`);
    for (let i = 0; i < LINES; i += 1) {
      // No two identical characters in a row anywhere in the line — WebKitWebDriver drops the
      // second of two identical consecutive key presses (docs/lessons.md's outline.spec.ts note),
      // which a plain two-digit index (11, 22, …) would trip over.
      const counter = String(i).split("").join("-");
      const line = `Typed line ${counter}, with enough words on it to take up a real line's height.`;
      await browser.keys(["Enter"]);
      await typeText(EDITOR, line);
      await browser.waitUntil(async () => (await textOf(`${EDITOR} p:last-child`)) === line, {
        timeout: 5000,
        interval: 10,
        timeoutMsg: `line ${i} ("${line}") never reached the editor`,
      });
      const offset = await lastLineCenterOffset();
      assert.ok(Math.abs(offset) <= 40, `line ${i}: caret is ${offset}px from vertical centre, past the 40px bound`);
    }
  });
});
