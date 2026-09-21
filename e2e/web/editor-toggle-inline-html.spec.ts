import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.51's browser half (DECISIONS #review-1-r6 L3 — Claude finding 3, Sol finding 2).
 *
 * `mdast-util-to-markdown/lib/util/container-phrasing.js` (2.1.2, lines 60–80) replaces the line
 * ending at the end of a child's string with one space when the next child is inline `html`, so
 * that the html is not read as flow html on a line of its own — and `placeChildren`
 * (`packages/core/src/positions.ts`) looked the text child's emission up by the string its handler
 * returned, which ends in the line ending the parent took away: the node was `unresolved`,
 * `cursorMap` had no range and no spelling table for it, and every caret in it answered the
 * paragraph's start. Sol's route: `alpha\n<i>beta</i>`, the rendered caret after `alpha` (before
 * the soft line break), toggle, type `X` — the pane read `Xalpha <i>beta</i>`. This is that route,
 * driven from a real browser: the caret placed by a click and arrows, the toggle chord, `X`, the
 * toggle back, Copy Markdown — the bytes are `alphaX <i>beta</i>\n`, a fixed point, and the
 * rendered paragraph reads `alphaX` first.
 *
 * A copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
 *
 * Caret placement (DECISIONS #022, #024): a click at a computed point on the paragraph's own
 * bounding box (its top-left corner, on the first of its two rendered lines — the `\n` is a literal
 * in the text node and `.ProseMirror` is `white-space: pre-wrap`), asserted as a DOM-selection
 * anchor before any key, then `ArrowUp` (Blink's line-start motion on a block's first line) and
 * counted `ArrowRight`, with the anchor asserted after each. Never a line-start or line-end key,
 * never the downward arrow, never a modifier chord for the caret (lesson [1.44]: the acceptance
 * grep counts the words themselves): `ControlOrMeta+/` is the app's toggle chord, not a caret
 * motion, and `tests/no-caret-chords-in-e2e.test.ts` allows it. The chord follows the last arrow only after ProseMirror's observer has had a tick to read
 * the DOM selection (the `[1.46, found outside scope]` line: the precedent in
 * `editor-toggle.spec.ts`). Helpers are copied from `editor-toggle-encoded-neighbour.spec.ts`.
 */

/** The arguments of the `writeText` calls the app made, newest last, recorded on the window. */
type WriteTextSpy = { calls: string[] };

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

/** Open `/dev/editor` on an empty store, with `writeText` spied before any page script runs. */
async function openRendered(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spy = { calls: [] as string[] };
    (window as unknown as { __writeText: WriteTextSpy }).__writeText = spy;
    navigator.clipboard.writeText = (text: string) => {
      spy.calls.push(text);
      return Promise.resolve();
    };
  });
  await page.goto("/dev/editor");
  await page.locator(".ProseMirror").click();
  await expect.poll(() => markdown(page)).toBe("");
}

/** Commit `source` through the dev bar's "Load fixture…" input, as a human would (task 1.14's route). */
async function load(page: Page, name: string, source: string): Promise<void> {
  await page
    .getByTestId("fixture-file")
    .setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(source, "utf8") });
  await expect(page.getByTestId("status")).toHaveText(`Loaded ${name}`);
}

async function press(page: Page, key: string, times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) await page.keyboard.press(key);
}

/**
 * A click on the paragraph's own bounding box at its top-left corner — a point on its first
 * rendered line, which every browser resolves to that line's start, never a Home/End key or a
 * chord (DECISIONS #022).
 */
async function clickParagraphStart(page: Page): Promise<void> {
  const paragraph = page.locator(".ProseMirror p").first();
  const box = await paragraph.boundingBox();
  if (box === null) throw new Error("no paragraph on the page");
  await paragraph.click({ position: { x: 1, y: Math.min(box.height / 4, 8) } });
}

/**
 * The rendered caret as the DOM selection reports it: the anchor text node's text, byte for byte,
 * and the caret's offset in it.
 */
function caret(page: Page): Promise<{ text: string | null; offset: number }> {
  return page.evaluate(() => {
    const selection = document.getSelection();
    if (selection === null || selection.anchorNode === null) return { text: null, offset: -1 };
    if (!selection.isCollapsed) return { text: null, offset: -1 };
    const node = selection.anchorNode;
    if (node.nodeType !== Node.TEXT_NODE) return { text: null, offset: selection.anchorOffset };
    return { text: node.textContent, offset: selection.anchorOffset };
  });
}

/** Click "Copy Markdown" and return the one string the app handed `writeText`. */
async function clickCopyMarkdown(page: Page): Promise<string> {
  await page.getByTestId("copy-markdown").click();
  await expect(page.getByTestId("status")).toHaveText("Copied Markdown");
  const calls = await page.evaluate(
    () => (window as unknown as { __writeText: WriteTextSpy }).__writeText.calls,
  );
  expect(calls).toHaveLength(1);
  return calls[0];
}

/**
 * The paragraph's `textContent` with task 1.4's reveal decorations (`.essaydown-delimiter`)
 * taken out of a clone first: they are decorations, not document text (lesson [1.45]), and the
 * caret is on this paragraph after the toggle back.
 */
function documentText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const paragraph = document.querySelector(".ProseMirror p");
    if (paragraph === null) return null;
    const clone = paragraph.cloneNode(true) as Element;
    for (const widget of clone.querySelectorAll(".essaydown-delimiter")) widget.remove();
    return clone.textContent;
  });
}

test.describe("a toggle to source with the caret before a soft line break that precedes inline html", () => {
  test("Sol's reproduction: `alpha\\n<i>beta</i>`, the caret after `alpha`, Cmd/Ctrl+/ then `X`, toggle back — the keystroke lands after `alpha`, never at the paragraph's start", async ({
    page,
  }) => {
    const seed = "alpha\n<i>beta</i>\n";
    await openRendered(page);
    await load(page, "toggle-inline-html.md", seed);
    // The seed is not a fixed point: the rendered editor's first serialisation writes the soft
    // line break before the inline tag as one space (container-phrasing.js 60–80), so the pane
    // shows the canonical bytes while the ProseMirror text node still holds `alpha\n`.
    const canonical = format(parse(seed));
    expect(canonical).toBe("alpha <i>beta</i>\n");
    await expect.poll(() => markdown(page)).toBe(canonical);
    expect(await page.locator(".ProseMirror p").count()).toBe(1);

    // The caret placed by a click on the first rendered line and asserted as an anchor before any
    // key: the paragraph's text node holds the literal `\n`, and the click lands at its start.
    await clickParagraphStart(page);
    await expect.poll(() => caret(page)).toEqual({ text: "alpha\n", offset: 0 });

    // `ArrowUp` on a block's first line is Blink's line-start motion; then five to the right, to
    // the position after `alpha` and before the soft line break — Sol's anchor.
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => caret(page)).toEqual({ text: "alpha\n", offset: 0 });
    await press(page, "ArrowRight", 5);
    await expect.poll(() => caret(page)).toEqual({ text: "alpha\n", offset: 5 });
    // The arrows moved the DOM selection natively; ProseMirror picks it up from `selectionchange`
    // in the rendering update after the key, so give the observer a tick before the chord reads
    // its state (the `[1.46, found outside scope]` line; `editor-toggle.spec.ts`'s precedent).
    await page.waitForTimeout(200);

    // The toggle chord (the app's own binding, not a caret motion), then one keystroke: where the
    // source caret landed is what the bytes now say. Before 1.51, `toSource` of this caret was
    // the paragraph's start, and the pane read `Xalpha <i>beta</i>`.
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.type("X", { delay: 10 });
    const bytes = "alphaX <i>beta</i>\n";
    await expect.poll(() => markdown(page)).toBe(bytes);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    await expect.poll(() => markdown(page)).toBe(bytes);
    const rendered = await documentText(page);
    expect(rendered?.startsWith("alphaX")).toBe(true);

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(format(parse(copied))).toBe(copied);
  });
});
