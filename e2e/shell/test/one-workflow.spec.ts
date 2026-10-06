import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paragraph, Root, Text } from "mdast";
import { blocksOf } from "../../../packages/core/src/blocks.js";
import { format } from "../../../packages/core/src/format.js";
import { parse } from "../../../packages/core/src/parse.js";
import { applyNewQuestion, applySetQuestion } from "../../../packages/core/src/outline.js";
import { applyAddVariant, applyUseVariant } from "../../../packages/core/src/rewrite.js";
import { applyReorderSentences, emptySidecar, type DocumentState } from "../../../packages/core/src/sidecar.js";
import { caretAtText, clickCentreOf, dragBetween, pressModChord, reloadPage, typeText } from "./routes.js";

// Task 3.6, PRD §3 steps 1-6, encoded once for every later gate to reuse: a fresh temp folder, a
// fresh Untitled file (no pre-seeded fixture), Outline's 3 questions, Produce's 2 paragraphs under
// each, Rewrite's one sentence, Reorder's two sentences, then toggle to source and back. The final
// Markdown is asserted against expected/one-workflow.md, which packages/core/test/
// one-workflow-golden.test.ts pins from the same core operations this spec drives through the UI
// (steps 7-8 are later tasks' own: 4.4 adds export, 5.2 the coach).
//
// Every piece of text typed here is checked below (CHECK_NO_DOUBLE_LETTERS) to have no two
// identical characters in a row, because WebKitWebDriver (this container's external driver, the
// one Linux uses) drops the second of two identical consecutive key presses (docs/lessons.md's
// outline.spec.ts note). The expected Markdown at every stage is computed with the same core
// mutations the UI dispatches (`applySetQuestion`, `applyNewQuestion`, `applyAddVariant`,
// `applyUseVariant`, `applyReorderSentences`), never hand-written, so a formatting rule this spec
// got wrong by hand could not hide a real regression.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const GOLDEN = readFileSync(`${FIXTURES}/expected/one-workflow.md`, "utf8");
const FILE = "Untitled-1.md";
const CREATED_AT = "2026-10-05T00:00:00.000Z";

const TOPIC_QUESTIONS = [
  "How did a dip pen work?",
  "What changed with metal nibs?",
  "What do readers take from it?",
] as const;
const BODIES = [
  [
    "Dip pens held thin ink. A writer paused often to reload.",
    "Metal came later and changed the touch. Writers noticed the point glide more.",
  ],
  [
    "A nib made of metal lasts longer. It holds a point for many days.",
    "Writers liked the steadier line it drew. Fewer blots showed on the page.",
  ],
  [
    "This piece argues that choices shape habits. A slight change in nib wear altered daily writing.",
    "Minor habits build up over time. A single choice can change a whole page.",
  ],
] as const;
const REWRITE_SENTENCE_PREFIX = "A writer paused";
const REWRITE_VARIANT = "A writer halted often to reload.";

function hasNoDoubledKeyPress(text: string): boolean {
  for (let at = 1; at < text.length; at += 1) if (text[at] === text[at - 1]) return false;
  return true;
}

// Every string this spec types, checked once: a doubled character would silently come out
// shortened by one key on this container's driver (see the module comment).
for (const text of [...TOPIC_QUESTIONS, ...BODIES.flat(), REWRITE_VARIANT]) {
  assert.ok(hasNoDoubledKeyPress(text), `${JSON.stringify(text)} has two identical characters in a row`);
}

function headingIndices(root: Root): number[] {
  return root.children.flatMap((node, index) => (node.type === "heading" ? [index] : []));
}

function paragraph(text: string): Paragraph {
  return { type: "paragraph", children: [{ type: "text", value: text } as Text] };
}

/** Splice `nodes` in right after root child `at` — the shape a `splitBlock` Enter plus typing
 * leaves behind, for plain text with no mark (this spec's own route, below). */
function insertAfter(root: Root, at: number, nodes: readonly Paragraph[]): Root {
  const children = [...root.children];
  children.splice(at + 1, 0, ...nodes);
  return { ...root, children };
}

/** Step 2 (Outline): the topic question on the existing H1, then two "New question" headings. */
function outlineState(): DocumentState {
  let state: DocumentState = { root: parse("# Untitled-1\n"), sidecar: emptySidecar() };
  state = applySetQuestion(state, 0, TOPIC_QUESTIONS[0]);
  state = applyNewQuestion(state, TOPIC_QUESTIONS[1]);
  state = applyNewQuestion(state, TOPIC_QUESTIONS[2]);
  return state;
}

/** Step 3 (Produce): 2 paragraphs under each of the 3 headings, in document order. */
function producedState(): DocumentState {
  let state = outlineState();
  for (const [index, body] of BODIES.entries()) {
    const at = headingIndices(state.root)[index];
    state = { root: insertAfter(state.root, at, body.map(paragraph)), sidecar: state.sidecar };
  }
  return state;
}

/** Step 4 (Rewrite): one variant on the first paragraph's second sentence, chosen. */
function rewrittenState(): DocumentState {
  const state = producedState();
  const firstParagraph = headingIndices(state.root)[0] + 1;
  const withVariant = applyAddVariant(state, [firstParagraph, 1], REWRITE_VARIANT, CREATED_AT);
  return applyUseVariant(withVariant, [firstParagraph, 1], 0, CREATED_AT);
}

/** Step 5 (Reorder): swap the last paragraph's two sentences — task 3.6's golden. */
function reorderedState(): DocumentState {
  const state = rewrittenState();
  const lastParagraph = state.root.children.length - 1;
  const block = blocksOf(state.root).find((one) => one.path.length === 1 && one.path[0] === lastParagraph);
  assert.ok(block !== undefined, "the last paragraph is not a top-level block");
  return applyReorderSentences(state, (block as { contentId: string }).contentId, [1, 0]);
}

const AFTER_OUTLINE = format(outlineState().root);
const AFTER_PRODUCE = format(producedState().root);
const AFTER_REWRITE = format(rewrittenState().root);
const AFTER_REORDER = format(reorderedState().root);

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

async function waitForMarkdown(expected: string, message: string): Promise<void> {
  await browser.waitUntil(async () => (await readout()).markdown === expected, { timeout: 5000, interval: 50, timeoutMsg: message });
}

async function waitForDisk(path: string, expected: string, message: string): Promise<void> {
  await browser.waitUntil(() => readFileSync(path, "utf8") === expected, { timeout: 5000, interval: 50, timeoutMsg: message });
}

const blockSelector = (at: number): string => `${EDITOR} > :nth-child(${at + 1})`;

/** `blockSelector(at)`, but safe in Produce mode: a heading with a question grows a
 * `.question-hint` widget as an extra preceding sibling (question-hints.ts's `Decoration.widget`
 * at the heading's own offset), which shifts every later block's plain `:nth-child` count by one
 * per hint before it — so this reads the DOM position of the `at`-th real block (skipping every
 * `.question-hint`) and builds the selector from that position instead. */
async function blockSelectorAt(at: number): Promise<string> {
  const domIndex = await browser.execute(
    (sel, index) => {
      const host = document.querySelector(sel);
      if (host === null) return null;
      const blocks = Array.from(host.children).filter((el) => !el.classList.contains("question-hint"));
      const target = blocks[index];
      return target === undefined ? null : Array.from(host.children).indexOf(target);
    },
    EDITOR,
    at,
  );
  assert.ok(domIndex !== null, `block ${at} is not on the page (a question-hint widget may have shifted it)`);
  return blockSelector(domIndex as number);
}
const chip = (index: number): string => `[data-testid="reorder-sentence"][data-index="${index}"]`;

function rewriteCard(block: number, index: number): string {
  return `[data-testid="rewrite-sentence"][data-block="${block}"][data-index="${index}"]`;
}

async function cardActive(selector: string): Promise<string | null> {
  return browser.execute((sel) => document.querySelector(sel)?.getAttribute("data-active") ?? null, selector);
}

async function count(selector: string): Promise<number> {
  return browser.execute((sel) => document.querySelectorAll(sel).length, selector);
}

async function textContentOf(selector: string): Promise<string | null> {
  return browser.execute((sel) => document.querySelector(sel)?.textContent ?? null, selector);
}

/** The centres of the drag handles of `from` and `to`, read in one execute so scrolling one into
 * view cannot push the other back out (reorder.spec.ts's own `handlesOf`). */
async function handlesOf(from: string, to: string): Promise<[{ x: number; y: number }, { x: number; y: number }]> {
  const points = await browser.execute(
    (a, b) => {
      const first = document.querySelector(`${a} .reorder-handle`);
      const second = document.querySelector(`${b} .reorder-handle`);
      if (first === null || second === null) return null;
      return [first, second].map((element) => {
        const box = element.getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      });
    },
    from,
    to,
  );
  assert.ok(points !== null, `${from} or ${to} has no handle on the page`);
  return [points[0], points[1]];
}

/** What the §146 source toggle's CodeMirror view shows (task 3.19, Cmd/Ctrl+/): each `.cm-line`
 * holds one logical line with no `\n` character inside it, so joining them with `\n` is what
 * reconstructs the exact string `format(root)` gave the view — never a DOM `textContent` read
 * straight off the host, which would run every line together. */
async function sourceViewText(): Promise<string> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="source"] .cm-line')).map((line) => line.textContent ?? "").join("\n"),
  );
}

async function openFreshWorkspace(folder: string): Promise<void> {
  await browser.execute((key, value) => localStorage.setItem(key, value), STORAGE_KEY, JSON.stringify({ folder, file: null }));
  await reloadPage();
  await browser.waitUntil(
    () =>
      browser.execute(
        () => (document.querySelector('[data-testid="new-file"]') as HTMLButtonElement | null)?.disabled === false,
      ),
    { timeout: 15000, interval: 25, timeoutMsg: "the restored folder never enabled New File" },
  );
}

async function createNewFile(): Promise<void> {
  await clickCentreOf('[data-testid="new-file"]');
  await browser.waitUntil(
    () =>
      browser.execute(
        (name, editorSel) =>
          document.querySelector('[data-testid="current-file"]')?.textContent === name &&
          document.querySelector(editorSel) !== null &&
          "__essaydown" in window,
        FILE,
        EDITOR,
      ),
    { timeout: 15000, interval: 25, timeoutMsg: `${FILE} never opened after New File` },
  );
}

describe("the one workflow (task 3.6, PRD §3 steps 1-6)", () => {
  let workspace: string;
  let doc: string;

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-one-workflow-"));
    doc = join(workspace, FILE);
  });

  it("step 1: open a fresh folder and create a fresh Untitled file", async function () {
    this.timeout(60000);
    await openFreshWorkspace(workspace);
    await createNewFile();
    assert.equal((await readout()).mode, "outline", "a fresh file does not open in Outline");
    assert.equal((await readout()).markdown, "# Untitled-1\n");
  });

  it("step 2: Outline — the topic question, then 2 more supporting questions", async function () {
    this.timeout(60000);
    const topicField = '[data-testid="question-field"][data-index="0"]';
    await clickCentreOf(topicField);
    await typeText(topicField, TOPIC_QUESTIONS[0]);
    await browser.keys(["Enter"]);
    await waitForMarkdown("# Untitled-1\n", "setting the topic question changed the Markdown");
    assert.equal(
      await textContentOf('[data-testid="outline-section"][data-index="0"] [data-testid="outline-section-title"]'),
      TOPIC_QUESTIONS[0],
    );

    for (const question of [TOPIC_QUESTIONS[1], TOPIC_QUESTIONS[2]]) {
      await clickCentreOf('[data-testid="new-question"]');
      await typeText('[data-testid="new-question"]', question);
      await clickCentreOf('[data-testid="add-question"]');
    }
    await waitForMarkdown(AFTER_OUTLINE, "the two new questions never produced the outlined headings");
    await waitForDisk(doc, AFTER_OUTLINE, "the outlined headings never reached the disk");
  });

  it("step 3: Produce — 2 paragraphs under each of the 3 headings", async function () {
    this.timeout(90000);
    await clickCentreOf('[data-testid="mode-produce"]');
    await browser.waitUntil(async () => (await readout()).mode === "produce", {
      timeout: 5000,
      interval: 25,
      timeoutMsg: "Produce mode never showed",
    });

    // Each heading's index is read off the mirrored state just before it is typed under, exactly
    // as it stands in the live document at that point: the two paragraphs just produced under an
    // earlier heading shift every later one down by 2.
    let state = outlineState();
    for (const [index, body] of BODIES.entries()) {
      const headingAt = headingIndices(state.root)[index];
      // Not `caretToEndOf`: its `ArrowDown` route only reaches a one-line block's end when that
      // block is the document's last one (file-tree.spec.ts's own note) — heading 0 and heading 1
      // here never are. `caretAtText` at the block's own text length is the general route
      // (reorder.spec.ts/rewrite.spec.ts already place a caret this way).
      const headingSelector = await blockSelectorAt(headingAt);
      const headingLength = await browser.execute((sel) => document.querySelector(sel)?.textContent?.length ?? 0, headingSelector);
      await caretAtText(EDITOR, headingSelector, headingLength);
      for (const sentence of body) {
        await browser.keys(["Enter"]);
        await typeText(EDITOR, sentence);
      }
      state = { root: insertAfter(state.root, headingAt, body.map(paragraph)), sidecar: state.sidecar };
      await waitForMarkdown(format(state.root), `producing under heading ${index} never matched`);
    }
    assert.equal(format(state.root), AFTER_PRODUCE, "the mirrored state drifted from the golden's own Produce stage");
    await waitForDisk(doc, AFTER_PRODUCE, "the produced paragraphs never reached the disk");
  });

  it("step 4: Rewrite — one variant on the first paragraph's second sentence, chosen", async function () {
    this.timeout(60000);
    await clickCentreOf('[data-testid="mode-rewrite"]');
    await browser.waitUntil(async () => (await readout()).mode === "rewrite", {
      timeout: 5000,
      interval: 25,
      timeoutMsg: "Rewrite mode never showed",
    });

    const firstParagraph = headingIndices(producedState().root)[0] + 1;
    const card = rewriteCard(firstParagraph, 1);
    const offset = await browser.execute(
      (sel, text) => document.querySelector(sel)?.textContent?.indexOf(text) ?? -1,
      blockSelector(firstParagraph),
      REWRITE_SENTENCE_PREFIX,
    );
    assert.ok(offset >= 0, `paragraph ${firstParagraph} does not contain ${REWRITE_SENTENCE_PREFIX}`);
    await caretAtText(EDITOR, blockSelector(firstParagraph), offset + 2);
    await browser.waitUntil(async () => (await cardActive(card)) === "true", {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "sentence 2's card never became the active one",
    });

    const field = `${card} [data-testid="rewrite-add"]`;
    await clickCentreOf(field);
    await browser.execute((sel) => (document.querySelector(sel) as HTMLTextAreaElement | null)?.focus(), field);
    await typeText(field, REWRITE_VARIANT);
    await pressModChord("Enter");
    await browser.waitUntil(async () => (await count(`${card} [data-testid="rewrite-variant"]`)) === 1, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "Cmd/Ctrl+Enter never added the variant",
    });

    await clickCentreOf(`${card} [data-testid="rewrite-use"]`);
    await waitForMarkdown(AFTER_REWRITE, "'Use this' never produced the rewritten sentence");
    await waitForDisk(doc, AFTER_REWRITE, "the chosen variant never reached the disk");
  });

  it("step 5: Reorder — swap the last paragraph's two sentences", async function () {
    this.timeout(60000);
    await clickCentreOf('[data-testid="mode-reorder"]');
    await browser.waitUntil(async () => (await readout()).mode === "reorder", {
      timeout: 5000,
      interval: 25,
      timeoutMsg: "Reorder mode never showed",
    });

    const lastParagraph = rewrittenState().root.children.length - 1;
    const length = await browser.execute((sel) => document.querySelector(sel)?.textContent?.length ?? 0, blockSelector(lastParagraph));
    assert.ok(length > 0, `the last paragraph (block ${lastParagraph}) has no text`);
    await caretAtText(EDITOR, blockSelector(lastParagraph), Math.floor(length / 2));
    await browser.waitUntil(async () => (await count(chip(0))) === 1 && (await count(chip(1))) === 1, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "the last paragraph's two sentence chips never showed",
    });
    assert.equal(await textContentOf(`${chip(0)} [data-testid="reorder-sentence-text"]`), "Minor habits build up over time.");
    assert.equal(await textContentOf(`${chip(1)} [data-testid="reorder-sentence-text"]`), "A single choice can change a whole page.");

    await dragBetween(...(await handlesOf(chip(1), chip(0))));
    await waitForMarkdown(AFTER_REORDER, "the sentence swap never produced the golden's final Markdown");
    assert.equal(AFTER_REORDER, GOLDEN, "the mirrored reorder stage drifted from expected/one-workflow.md");
    await waitForDisk(doc, GOLDEN, "the final essay never reached the disk");
  });

  it("step 6: toggle to source view and back; the Markdown is unchanged", async function () {
    this.timeout(60000);
    const headingSelector = await blockSelectorAt(0);
    await caretAtText(EDITOR, headingSelector, 2);
    const before = await readout();

    await pressModChord("/");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelector('[data-testid="document"]')?.getAttribute("data-surface") === "source" &&
            document.querySelector('[data-testid="source"] .cm-content') !== null,
        ),
      { timeout: 5000, interval: 50, timeoutMsg: "the source view never appeared" },
    );
    assert.equal(await sourceViewText(), GOLDEN, "the source view does not show the exact canonical Markdown");

    await pressModChord("/");
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelector('[data-testid="document"]')?.getAttribute("data-surface") === "rendered" &&
            document.querySelector('[data-testid="editor"] .ProseMirror') !== null,
        ),
      { timeout: 5000, interval: 50, timeoutMsg: "the rendered editor never came back" },
    );

    const after = await readout();
    assert.equal(after.markdown, GOLDEN, "toggling source and back changed the Markdown");
    assert.equal(after.snapshots, before.snapshots, "toggling source and back changed the snapshot count");
    await waitForDisk(doc, GOLDEN, "the essay on disk changed after toggling source and back");
    assert.equal(readFileSync(doc, "utf8"), GOLDEN);
  });
});
