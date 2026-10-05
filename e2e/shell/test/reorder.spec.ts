import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import { parse } from "../../../packages/core/src/parse.js";
import { sectionsOf } from "../../../packages/core/src/blocks.js";
import { emptySidecar, type Sidecar } from "../../../packages/core/src/sidecar.js";
import { applyAddVariant } from "../../../packages/core/src/rewrite.js";
import { caretAtText, clickCentreOf, dragBetween, pressModChord, reloadPage } from "./routes.js";

// Reorder mode (task 3.5). Acceptance: sentence 3 → 1 in paragraph 4 → expected/essay-fixture.
// reorder-sentence.md with marks intact; paragraph 2 → 4 in section 3 → expected/essay-fixture.
// reorder-para.md; a keyboard-only section move equals the mouse result; each is one undo step,
// and a Reorder drag followed by Cmd/Ctrl+Z restores the exact prior Markdown and sidecar.
//
// Counting is task 3.4's: from 1, top-level paragraphs only. The essay's paragraph 4 has two
// sentences and no marks, so the sentence case opens expected/essay-fixture.reorder-sentence.seed.md
// (the canonical essay with a third sentence carrying emphasis, strong and inline code appended to
// paragraph 4; packages/core/test/reorder-goldens.test.ts pins that relationship). Section 3 is the
// third section of `sectionsOf`; its paragraphs 2 and 4 are the second and fourth top-level
// paragraphs between its heading and the next. The section move is section 3 → 1, whose result is
// the existing expected/essay-fixture.moved.md (task 1.4's `moveSection(root, 2, 0)`).
//
// Each document opens with a sidecar holding a rewrite entry on the item the drag moves, so the
// undo case has a sidecar change to take back, not an empty list.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const CANONICAL = read("essay-fixture.canonical.md");
const SEED = read("expected/essay-fixture.reorder-sentence.seed.md");
const SENTENCE_GOLDEN = read("expected/essay-fixture.reorder-sentence.md");
const PARA_GOLDEN = read("expected/essay-fixture.reorder-para.md");
const MOVED_GOLDEN = read("expected/essay-fixture.moved.md");
const SENTENCE_FILE = "reorder-sentence.md";
const PARA_FILE = "reorder-para.md";
const CREATED_AT = "2026-10-05T00:00:00.000Z";

function paragraphIndices(root: Root, from = 0, to = root.children.length): number[] {
  const found: number[] = [];
  for (let at = from; at < to; at += 1) if (root.children[at].type === "paragraph") found.push(at);
  return found;
}

const seedRoot = parse(SEED);
const canonicalRoot = parse(CANONICAL);
/** Root index of paragraph 4 (no front matter, so also the editor's child index). */
const P4 = paragraphIndices(seedRoot)[3];
const SECTION_3 = sectionsOf(canonicalRoot)[2].start;
const SECTION_3_END = (() => {
  let to = SECTION_3 + 1;
  while (to < canonicalRoot.children.length && canonicalRoot.children[to].type !== "heading") to += 1;
  return to;
})();
const [, PARA_2, , PARA_4] = paragraphIndices(canonicalRoot, SECTION_3 + 1, SECTION_3_END);

const blockSelector = (at: number): string => `${EDITOR} > :nth-child(${at + 1})`;
const chip = (index: number): string => `[data-testid="reorder-sentence"][data-index="${index}"]`;
const card = (at: number): string => `[data-testid="reorder-block"][data-index="${at}"]`;
const row = (index: number): string => `[data-testid="reorder-section"][data-index="${index}"]`;

/** A sidecar with one rewrite entry on the sentence at `pos`, as the app would write it. */
function sidecarWithVariant(root: Root, pos: readonly number[], text: string): string {
  return JSON.stringify(applyAddVariant({ root, sidecar: emptySidecar() }, pos, text, CREATED_AT).sidecar);
}

interface Readout {
  readonly mode: string | null;
  readonly markdown: string;
  /** The store's sidecar as the hook serialises it, compared byte for byte. */
  readonly sidecar: string;
  readonly snapshots: number;
}

async function readout(): Promise<Readout> {
  return browser.execute(() => {
    const hook = (window as unknown as { __essaydown?: Record<string, () => unknown> }).__essaydown;
    if (hook === undefined) throw new Error("window.__essaydown is not installed");
    return {
      mode: document.querySelector('[data-testid="app-shell"]')?.getAttribute("data-mode") ?? null,
      markdown: hook.markdown() as string,
      sidecar: hook.sidecar() as string,
      snapshots: hook.snapshots() as number,
    };
  });
}

function anchorsOf(sidecar: string): number[][] {
  return (JSON.parse(sidecar) as Sidecar).rewrites.map((entry) => [...entry.anchor.pos]);
}

async function count(selector: string): Promise<number> {
  return browser.execute((sel) => document.querySelectorAll(sel).length, selector);
}

/** The centres of the drag handles of `from` and `to`, two items of one list, after the list is
 * scrolled to the top of the sidebar so both are on screen at once (scrolling each into view in
 * turn can push the first back out). */
async function handlesOf(from: string, to: string): Promise<[{ x: number; y: number }, { x: number; y: number }]> {
  const points = await browser.execute(
    (a, b) => {
      const first = document.querySelector(`${a} .reorder-handle`);
      const second = document.querySelector(`${b} .reorder-handle`);
      if (first === null || second === null) return null;
      first.closest(".reorder-list")?.scrollIntoView({ block: "start" });
      // No named inner function: the spec's bundler wraps one in a `__name` helper the page lacks.
      return [first, second].map((element) => {
        const box = element.getBoundingClientRect();
        const y = Math.round(box.top + box.height / 2);
        return { x: Math.round(box.left + box.width / 2), y, visible: y > 0 && y < window.innerHeight };
      });
    },
    from,
    to,
  );
  assert.ok(points !== null, `${from} or ${to} has no handle on the page`);
  assert.ok(points[0].visible && points[1].visible, `${from} and ${to} are not both on screen: ${JSON.stringify(points)}`);
  return [points[0], points[1]];
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
          "__essaydown" in window,
        file,
        EDITOR,
      ),
    { timeout: 15000, interval: 25, timeoutMsg: `${file} never opened` },
  );
  await clickCentreOf('[data-testid="mode-reorder"]');
  await browser.waitUntil(async () => (await readout()).mode === "reorder", {
    timeout: 5000,
    interval: 25,
    timeoutMsg: "Reorder mode never showed",
  });
}

/** The caret into top-level block `at`, and the sidebar following it. The click lands halfway
 * through the block's text: `caretAtText` centres the block in the viewport first, and with both
 * sidebars open a long paragraph is taller than the window, so its first line can be above it. */
async function caretInto(at: number, ready: () => Promise<boolean>, what: string): Promise<void> {
  const length = await browser.execute((sel) => document.querySelector(sel)?.textContent?.length ?? 0, blockSelector(at));
  assert.ok(length > 0, `block ${at} has no text`);
  await caretAtText(EDITOR, blockSelector(at), Math.floor(length / 2));
  await browser.waitUntil(ready, { timeout: 5000, interval: 50, timeoutMsg: `the sidebar never showed ${what}` });
}

async function waitForMarkdown(expected: string, message: string): Promise<Readout> {
  await browser.waitUntil(async () => (await readout()).markdown === expected, { timeout: 5000, interval: 50, timeoutMsg: message });
  return readout();
}

async function waitForDisk(path: string, expected: string, message: string): Promise<void> {
  await browser.waitUntil(() => readFileSync(path, "utf8") === expected, { timeout: 5000, interval: 50, timeoutMsg: message });
}

/** Cmd/Ctrl+Z outside the editor: back to `prior`, Markdown and sidecar byte for byte. */
async function undoTo(prior: Readout, what: string): Promise<void> {
  await pressModChord("z");
  const undone = await waitForMarkdown(prior.markdown, `Cmd/Ctrl+Z never restored the Markdown before the ${what}`);
  assert.equal(undone.sidecar, prior.sidecar, `Cmd/Ctrl+Z did not restore the exact sidecar before the ${what}`);
}

describe("Reorder mode (task 3.5)", () => {
  let workspace: string;
  // The store as it stood before the sentence drop, for the undo case that follows it.
  let sentencePrior: Readout;

  before(() => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-reorder-"));
    writeFileSync(join(workspace, SENTENCE_FILE), SEED);
    writeFileSync(join(workspace, "reorder-sentence.essaydown.json"), sidecarWithVariant(seedRoot, [P4, 2], "Steel cured *nothing*."));
    writeFileSync(join(workspace, PARA_FILE), CANONICAL);
    writeFileSync(join(workspace, "reorder-para.essaydown.json"), sidecarWithVariant(canonicalRoot, [PARA_2, 0], "Patents tell the story."));
  });

  it("sentence 3 → 1 in paragraph 4 by mouse: expected/essay-fixture.reorder-sentence.md, marks intact, one undo step", async function () {
    this.timeout(90000);
    await openThroughRestore(workspace, SENTENCE_FILE);
    await caretInto(P4, async () => (await count(chip(2))) === 1 && (await count(chip(3))) === 0, "paragraph 4's three sentences");
    const chipText = await browser.execute((sel) => document.querySelector(`${sel} .reorder-text`)?.textContent ?? null, chip(2));
    assert.equal(chipText, "A steel nib was, in *short*, **no** cure for a dry `feed`.");

    const prior = await readout();
    sentencePrior = prior;
    assert.deepEqual(anchorsOf(prior.sidecar), [[P4, 2]]);
    await dragBetween(...(await handlesOf(chip(2), chip(0))));
    const after = await waitForMarkdown(SENTENCE_GOLDEN, "the drop never produced expected/essay-fixture.reorder-sentence.md");
    assert.equal(after.snapshots, prior.snapshots + 1, "the drop was not exactly one undo step");
    assert.deepEqual(anchorsOf(after.sidecar), [[P4, 0]], "the rewrite entry did not move with its sentence");

    const marks = await browser.execute(
      (sel) => ({
        em: document.querySelector(`${sel} em`)?.textContent ?? null,
        strong: document.querySelector(`${sel} strong`)?.textContent ?? null,
        code: document.querySelector(`${sel} code`)?.textContent ?? null,
      }),
      blockSelector(P4),
    );
    assert.equal(marks.em, "short");
    assert.equal(marks.strong, "no");
    assert.equal(marks.code, "feed");
    const firstChip = await browser.execute((sel) => document.querySelector(`${sel} .reorder-text`)?.textContent ?? null, chip(0));
    assert.equal(firstChip, "A steel nib was, in *short*, **no** cure for a dry `feed`.");
    await waitForDisk(join(workspace, SENTENCE_FILE), SENTENCE_GOLDEN, "the reordered paragraph never reached the disk");
  });

  it("a Reorder drag then Cmd/Ctrl+Z restores the exact prior Markdown and sidecar", async function () {
    this.timeout(60000);
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    assert.equal(sentencePrior.markdown, SEED);
    await undoTo(sentencePrior, "sentence drop");
    assert.deepEqual(anchorsOf((await readout()).sidecar), [[P4, 2]]);
    await waitForDisk(join(workspace, SENTENCE_FILE), SEED, "the undone reorder never reached the disk");
  });

  it("paragraph 2 → 4 in section 3 by mouse: expected/essay-fixture.reorder-para.md, one undo step, undone exactly", async function () {
    this.timeout(90000);
    await openThroughRestore(workspace, PARA_FILE);
    await caretInto(PARA_2, async () => (await count(card(PARA_4))) === 1 && (await count(card(SECTION_3 + 1))) === 1, "section 3's blocks");
    assert.equal(await count('[data-testid="reorder-block"]'), SECTION_3_END - SECTION_3 - 1);

    const prior = await readout();
    await dragBetween(...(await handlesOf(card(PARA_2), card(PARA_4))));
    const after = await waitForMarkdown(PARA_GOLDEN, "the drop never produced expected/essay-fixture.reorder-para.md");
    assert.equal(after.snapshots, prior.snapshots + 1, "the drop was not exactly one undo step");
    assert.deepEqual(anchorsOf(after.sidecar), [[PARA_4, 0]], "the rewrite entry did not move with its paragraph");
    await waitForDisk(join(workspace, PARA_FILE), PARA_GOLDEN, "the moved paragraph never reached the disk");

    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await undoTo(prior, "paragraph drop");
    await waitForDisk(join(workspace, PARA_FILE), CANONICAL, "the undone move never reached the disk");
  });

  it("keyboard-only section 3 → 1 (Space, ArrowUp ×2, Space) equals the mouse result; each one undo step", async function () {
    this.timeout(90000);
    // A fresh store, so the stack has no redo entry and a push grows it by exactly one.
    await openThroughRestore(workspace, PARA_FILE);
    assert.equal(await count('[data-testid="reorder-section"]'), sectionsOf(canonicalRoot).length);
    const prior = await readout();
    assert.equal(prior.markdown, CANONICAL);

    await dragBetween(...(await handlesOf(row(2), row(0))));
    const mouse = await waitForMarkdown(MOVED_GOLDEN, "the mouse section move never produced expected/essay-fixture.moved.md");
    assert.equal(mouse.snapshots, prior.snapshots + 1, "the mouse drop was not exactly one undo step");
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await undoTo(prior, "mouse section move");

    // Keyboard only from here: the handle takes focus (as Tab would give it), then keys alone.
    const focused = await browser.execute((sel) => {
      const handle = document.querySelector(`${sel} .reorder-handle`);
      if (!(handle instanceof HTMLElement)) return false;
      handle.scrollIntoView({ block: "nearest" });
      handle.focus();
      return document.activeElement === handle;
    }, row(2));
    assert.ok(focused, "section 3's handle never took focus");
    const before = await readout();
    for (const key of [" ", "ArrowUp", "ArrowUp", " "]) {
      await browser.keys([key]);
      await browser.pause(250);
    }
    const keyboard = await waitForMarkdown(mouse.markdown, "the keyboard section move never equalled the mouse result");
    // The undo left a redo entry, which the keyboard drop replaced: the same depth as the mouse drop.
    assert.equal(keyboard.snapshots, mouse.snapshots, "the keyboard drop was not exactly one undo step");
    assert.equal(keyboard.sidecar, mouse.sidecar, "the keyboard move's sidecar differs from the mouse move's");

    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await undoTo(before, "keyboard section move");
  });
});
