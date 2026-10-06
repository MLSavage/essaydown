import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { parse } from "../../../packages/core/src/parse.js";
import { blocksOf } from "../../../packages/core/src/blocks.js";
import { parseSidecar, type Sidecar } from "../../../packages/core/src/sidecar.js";
import { caretAtText, clickCentreOf, dragBetween, editableTextOf, pressModChord, reloadPage, selectText, typeText } from "./routes.js";

// Rewrite mode (task 3.4). Acceptance, on essay-fixture paragraph 4: add 2 variants to sentence 2,
// choose variant 2 → the Markdown equals fixtures/markdown/expected/essay-fixture.rewrite.md with
// inline emphasis preserved; Cmd/Ctrl+Z reverts the sentence and `chosen`; relaunch → the variants
// are still anchored; an edit elsewhere in the paragraph → still anchored; retype the sentence
// entirely → the card is in 'Unattached'; drag it onto sentence 1 → re-anchored.
//
// "Paragraph 4" is the fourth top-level paragraph ("Metal dip pens, …"), sentences counted from 1
// as the acceptance counts them (index 1 is sentence 2). The fixture's prose has no emphasis, so
// variant 2 carries it (`*worse*`) and the golden pins that it survives into the file. Variant 2 is
// chosen after Cmd/Ctrl+Z took it back by Shift+Cmd/Ctrl+Z, which pins redo too and leaves a short
// sentence to retype. No text typed here has a letter twice in a row (outline.spec.ts: WebKitWebDriver
// drops the second of two identical consecutive key presses).
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const CANONICAL = readFileSync(join(FIXTURES, "essay-fixture.canonical.md"), "utf8");
const REWRITTEN = readFileSync(join(FIXTURES, "expected/essay-fixture.rewrite.md"), "utf8");
const FILE = "essay-fixture.md";
const SIDECAR = "essay-fixture.essaydown.json";
const VARIANT_1 = "If anything they sharpened it.";
const VARIANT_2 = "If anything, a metal nib made it *worse*.";
const VARIANT_2_PLAIN = "If anything, a metal nib made it worse.";
const RETYPED = "Nothing was solved by it.";
const MOD_KEY = platform() === "darwin" ? "Meta" : "Control";

/** Root index of the fourth top-level paragraph; the essay has no front matter, so it is also the
 * editor's top-level child index. */
const P4 = blocksOf(parse(CANONICAL)).filter((block) => block.path.length === 1 && block.node.type === "paragraph")[3]
  .path[0];
const BLOCK = `${EDITOR} > :nth-child(${P4 + 1})`;
const card = (index: number): string => `[data-testid="rewrite-sentence"][data-block="${P4}"][data-index="${index}"]`;

interface Readout {
  readonly mode: string | null;
  readonly markdown: string;
  readonly sidecar: Sidecar;
}

async function readout(): Promise<Readout> {
  const raw = await browser.execute(() => {
    const hook = (window as unknown as { __essaydown?: Record<string, () => unknown> }).__essaydown;
    if (hook === undefined) throw new Error("window.__essaydown is not installed");
    return {
      mode: document.querySelector('[data-testid="app-shell"]')?.getAttribute("data-mode") ?? null,
      markdown: hook.markdown() as string,
      sidecar: hook.sidecar() as string,
    };
  });
  return { ...raw, sidecar: parseSidecar(JSON.parse(raw.sidecar)) };
}

/** A sentence card as the sidebar shows it. */
interface CardView {
  readonly active: string | null;
  readonly text: string;
  readonly variants: { text: string; chosen: string | null; checked: boolean }[];
  readonly inView: boolean;
}

async function cardView(selector: string): Promise<CardView | null> {
  return browser.execute((sel) => {
    const element = document.querySelector(sel);
    const panel = document.querySelector('[data-testid="rewrite-panel"]');
    if (element === null || panel === null) return null;
    const box = element.getBoundingClientRect();
    const frame = panel.getBoundingClientRect();
    return {
      active: element.getAttribute("data-active"),
      text: element.querySelector('[data-testid="rewrite-sentence-text"]')?.firstChild?.textContent ?? "",
      variants: Array.from(element.querySelectorAll('[data-testid="rewrite-variant"]')).map((variant) => ({
        text: variant.querySelector('[data-testid="rewrite-variant-text"]')?.textContent ?? "",
        chosen: variant.getAttribute("data-chosen"),
        checked: (variant.querySelector('[data-testid="rewrite-variant-radio"]') as HTMLInputElement | null)?.checked ?? false,
      })),
      inView: box.top >= frame.top - 1 && box.top < frame.bottom,
    };
  }, selector);
}

async function orphanTexts(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('[data-testid="rewrite-orphan-text"]')).map((one) => one.textContent ?? ""),
  );
}

async function centreOf(selector: string): Promise<{ x: number; y: number }> {
  const centre = await browser.execute((sel) => {
    const element = document.querySelector(sel);
    if (element === null) return null;
    element.scrollIntoView({ block: "nearest" });
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  }, selector);
  assert.ok(centre !== null, `${selector} is not on the page`);
  return centre;
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
  await clickCentreOf('[data-testid="mode-rewrite"]');
  await browser.waitUntil(async () => (await readout()).mode === "rewrite", {
    timeout: 5000,
    interval: 25,
    timeoutMsg: "Rewrite mode never showed",
  });
}

/** The caret into paragraph 4 at the start of the sentence that begins with `prefix`, and the
 * sidebar showing that sentence's card as the active one. */
async function caretInto(prefix: string, index: number): Promise<void> {
  const offset = (await editableTextOf(BLOCK)).indexOf(prefix);
  assert.ok(offset >= 0, `paragraph 4 does not contain ${prefix}`);
  await caretAtText(EDITOR, BLOCK, offset + 2);
  await browser.waitUntil(async () => (await cardView(card(index)))?.active === "true", {
    timeout: 5000,
    interval: 50,
    timeoutMsg: `the card of sentence ${index + 1} never became the active one`,
  });
}

function diskSidecar(path: string): Sidecar | null {
  if (!existsSync(path)) return null;
  try {
    return parseSidecar(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

async function addVariant(index: number, text: string): Promise<void> {
  const field = `${card(index)} [data-testid="rewrite-add"]`;
  const before = (await cardView(card(index)))?.variants.length ?? 0;
  await centreOf(field);
  await clickCentreOf(field);
  // `clickCentreOf`'s embedded branch focuses buttons, inputs and the editor, not a textarea.
  await browser.execute((sel) => (document.querySelector(sel) as HTMLTextAreaElement | null)?.focus(), field);
  await typeText(field, text);
  await pressModChord("Enter");
  await browser.waitUntil(async () => (await cardView(card(index)))?.variants.length === before + 1, {
    timeout: 5000,
    interval: 50,
    timeoutMsg: `Cmd/Ctrl+Enter never added ${text}`,
  });
}

describe("Rewrite mode (task 3.4)", () => {
  let workspace: string;
  let doc: string;
  let sidecarPath: string;

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-rewrite-"));
    doc = join(workspace, FILE);
    sidecarPath = join(workspace, SIDECAR);
    writeFileSync(doc, CANONICAL);
    await openThroughRestore(workspace, FILE);
  });

  it("add 2 variants to sentence 2 and choose variant 2: the Markdown equals expected/essay-fixture.rewrite.md", async function () {
    this.timeout(90000);
    assert.ok(REWRITTEN.includes("*worse*"), "the golden lost the emphasis it pins");
    await caretInto("If anything they", 1);
    const active = await cardView(card(1));
    assert.ok(active?.inView, "the sidebar did not scroll the caret's sentence into view");
    assert.equal((await cardView(card(0)))?.active, "false");

    await addVariant(1, VARIANT_1);
    await addVariant(1, VARIANT_2);
    let view = (await cardView(card(1))) as CardView;
    assert.deepEqual(
      view.variants.map((variant) => variant.text),
      [VARIANT_1, VARIANT_2],
    );
    assert.deepEqual(
      view.variants.map((variant) => variant.checked),
      [false, true],
      "Cmd/Ctrl+Enter did not select the variant it added",
    );
    assert.equal((await readout()).markdown, CANONICAL, "adding a variant changed the Markdown");

    await clickCentreOf(`${card(1)} [data-testid="rewrite-variant"]:nth-child(2) [data-testid="rewrite-variant-radio"]`);
    await clickCentreOf(`${card(1)} [data-testid="rewrite-use"]`);
    await browser.waitUntil(async () => (await readout()).markdown === REWRITTEN, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "'Use this' never produced expected/essay-fixture.rewrite.md",
    });
    const after = await readout();
    assert.equal(after.sidecar.rewrites.length, 1);
    assert.equal(after.sidecar.rewrites[0].chosen, 1);
    view = (await cardView(card(1))) as CardView;
    assert.equal(view.text, VARIANT_2);
    assert.deepEqual(
      view.variants.map((variant) => variant.chosen),
      ["false", "true"],
    );
    const emphasis = await browser.execute((sel) => document.querySelector(`${sel} em`)?.textContent ?? null, BLOCK);
    assert.equal(emphasis, "worse", "the rendered paragraph lost the variant's emphasis");
    await browser.waitUntil(() => readFileSync(doc, "utf8") === REWRITTEN && diskSidecar(sidecarPath)?.rewrites[0]?.chosen === 1, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "the chosen variant never reached the disk",
    });
  });

  it("Cmd/Ctrl+Z reverts the sentence and chosen; Shift+Cmd/Ctrl+Z puts both back", async function () {
    this.timeout(60000);
    await pressModChord("z");
    await browser.waitUntil(async () => (await readout()).markdown === CANONICAL, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "Cmd/Ctrl+Z never reverted the sentence",
    });
    const undone = await readout();
    assert.equal(undone.sidecar.rewrites[0].chosen, null, "Cmd/Ctrl+Z left chosen set");
    assert.equal(undone.sidecar.rewrites[0].variants.length, 2, "Cmd/Ctrl+Z took a variant too");
    assert.deepEqual(
      ((await cardView(card(1))) as CardView).variants.map((variant) => variant.chosen),
      ["false", "false"],
    );

    await browser.keys([MOD_KEY, "Shift", "z"]);
    await browser.waitUntil(async () => (await readout()).markdown === REWRITTEN, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "Shift+Cmd/Ctrl+Z never redid 'Use this'",
    });
    assert.equal((await readout()).sidecar.rewrites[0].chosen, 1);
    await browser.waitUntil(() => readFileSync(doc, "utf8") === REWRITTEN && diskSidecar(sidecarPath)?.rewrites[0]?.chosen === 1, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "the redone choice never reached the disk",
    });
  });

  it("relaunch: the variants are still anchored to sentence 2", async function () {
    this.timeout(60000);
    await openThroughRestore(workspace, FILE);
    assert.equal((await readout()).markdown, REWRITTEN);
    await caretInto("If anything,", 1);
    const view = (await cardView(card(1))) as CardView;
    assert.equal(view.text, VARIANT_2);
    assert.deepEqual(
      view.variants.map((variant) => [variant.text, variant.chosen]),
      [
        [VARIANT_1, "false"],
        [VARIANT_2, "true"],
      ],
    );
    assert.equal(((await cardView(card(0))) as CardView).variants.length, 0);
    assert.deepEqual(await orphanTexts(), []);
  });

  it("an edit elsewhere in the paragraph: still anchored", async function () {
    this.timeout(60000);
    const offset = (await editableTextOf(BLOCK)).indexOf("Metal");
    assert.equal(offset, 0);
    await caretAtText(EDITOR, BLOCK, "Metal".length);
    await typeText(EDITOR, " ink");
    await browser.waitUntil(async () => (await readout()).markdown.includes("Metal ink dip pens"), {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "the edit in sentence 1 never reached the store",
    });
    const view = (await cardView(card(1))) as CardView;
    assert.deepEqual(
      view.variants.map((variant) => variant.text),
      [VARIANT_1, VARIANT_2],
    );
    assert.deepEqual(await orphanTexts(), []);
    await browser.waitUntil(() => readFileSync(doc, "utf8").includes("Metal ink dip pens"), {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "the edit never reached the disk",
    });
    await browser.waitUntil(
      () => {
        const sidecar = diskSidecar(sidecarPath);
        return sidecar !== null && sidecar.orphans.length === 0 && sidecar.rewrites[0]?.anchor.text === VARIANT_2_PLAIN;
      },
      { timeout: 5000, interval: 50, timeoutMsg: "the entry on disk lost its sentence after the edit" },
    );
  });

  it("retype the sentence entirely: the card is in 'Unattached'", async function () {
    this.timeout(60000);
    // Sentence 2 is the paragraph's last, so it runs to the block's end. Offsets are in the
    // block's plain-text coordinate (`editableTextOf`, routes.ts): the caret's block shows its
    // marks' delimiters (`*worse*`) as `contenteditable="false"` widgets, which that coordinate
    // skips, so the range runs from the sentence's first words to the end of the block's own text.
    const content = await editableTextOf(BLOCK);
    const range = { from: content.indexOf("If anything, a metal nib"), to: content.length, content };
    assert.ok(range.from > 0, `sentence 2 is not in paragraph 4: ${JSON.stringify(range.content)}`);
    await selectText(EDITOR, BLOCK, range.from, range.to);
    await typeText(EDITOR, RETYPED);
    await browser.waitUntil(async () => (await orphanTexts()).length === 1, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "the retyped sentence's card never went to 'Unattached'",
    });
    assert.ok((await readout()).markdown.includes(`reservoir problem. ${RETYPED}`), "the retype did not replace sentence 2");
    assert.deepEqual(await orphanTexts(), [VARIANT_2_PLAIN]);
    assert.equal(((await cardView(card(1))) as CardView).text, RETYPED);
    assert.equal(((await cardView(card(1))) as CardView).variants.length, 0);
    await browser.waitUntil(
      () => {
        const sidecar = diskSidecar(sidecarPath);
        return sidecar !== null && sidecar.rewrites.length === 0 && sidecar.orphans.length === 1;
      },
      { timeout: 5000, interval: 50, timeoutMsg: "the orphan never reached the sidecar on disk" },
    );
  });

  it("drag the unattached card onto sentence 1: re-anchored", async function () {
    this.timeout(60000);
    const handle = await centreOf('[data-testid="rewrite-orphan"] [data-testid="rewrite-orphan-handle"]');
    const target = await centreOf(card(0));
    await dragBetween(handle, target);
    await browser.waitUntil(async () => (await orphanTexts()).length === 0, {
      timeout: 5000,
      interval: 50,
      timeoutMsg: "the drop never re-anchored the card",
    });
    const view = (await cardView(card(0))) as CardView;
    assert.deepEqual(
      view.variants.map((variant) => variant.text),
      [VARIANT_1, VARIANT_2],
    );
    assert.equal(((await cardView(card(1))) as CardView).variants.length, 0);
    const state = await readout();
    assert.equal(state.sidecar.orphans.length, 0);
    assert.deepEqual(state.sidecar.rewrites[0].anchor.pos, [P4, 0]);
    assert.match(state.sidecar.rewrites[0].anchor.text, /^Metal ink dip pens/);
    await browser.waitUntil(
      () => {
        const sidecar = diskSidecar(sidecarPath);
        return sidecar !== null && sidecar.orphans.length === 0 && sidecar.rewrites[0]?.anchor.pos.join() === `${P4},0`;
      },
      { timeout: 5000, interval: 50, timeoutMsg: "the re-anchored entry never reached the disk" },
    );
  });
});
