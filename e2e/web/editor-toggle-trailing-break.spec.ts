import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.43's browser half (DECISIONS #review-1-r4 J3 — Claude finding 3, Sol finding 2; the
 * `[1.37]` backlog line's trigger).
 *
 * `cursorMap.toSource` (`packages/editor/src/toggle.ts`) answered a position that a block's
 * correspondence covers but no inline child does with the block's *start*: after a Backspace that
 * leaves a paragraph ending in a `hard_break`, the conversion drops the trailing break, the mdast
 * paragraph is narrower than the editor's, and the toggle to source put the caret at the
 * paragraph's first column. Sol's reproduction, built the way Sol built it: load `abc\` + LF +
 * `def`, click the end of `def`, Backspace three times, `Cmd/Ctrl+/` to source, type `X` — the
 * pane (and the copy) is `abcX`, never `Xabc`. The split-item sibling of this shape is asserted
 * headless only, by `packages/editor/test/position-map-editor-leg.test.ts`'s deletion leg.
 *
 * A copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
 *
 * Caret placement (DECISIONS #022): a click at a computed point — the paragraph's own bounding
 * box, past its last character on its second line, which every browser resolves to that line's
 * end — asserted before anything is typed. `ControlOrMeta+/` is the app's toggle chord, not a
 * caret motion, and is allowed by `tests/no-caret-chords-in-e2e.test.ts` (Home/End chords only).
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
 * A click on the paragraph's own bounding box, past its last character on its *second* line (the
 * one after the `<br>`), three quarters of the way down — a point every browser resolves to that
 * line's end, never a Home/End key or a chord (DECISIONS #022).
 */
async function clickSecondLineEnd(page: Page): Promise<void> {
  const paragraph = page.locator(".ProseMirror p").first();
  const box = await paragraph.boundingBox();
  if (box === null) throw new Error("no paragraph on the page");
  await paragraph.click({ position: { x: box.width - 1, y: (box.height * 3) / 4 } });
}

/**
 * The rendered caret as the DOM selection reports it: the anchor text node's text, byte for byte,
 * and the caret's offset in it (the shape `editor-strikethrough-neighbour.spec.ts` uses).
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

/**
 * The paragraph's `hard_break` nodes as rendered: every `<br>` but ProseMirror's own trailing
 * one (`ProseMirror-trailingBreak`, which it adds after a break that ends a block so the empty
 * last line has a height — a rendering aid, not a node).
 */
function hardBreaks(page: Page): Promise<number> {
  return page.locator(".ProseMirror p br:not(.ProseMirror-trailingBreak)").count();
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

test.describe("a toggle to source after a Backspace leaves a paragraph ending in a hard break", () => {
  test("Sol's reproduction: `abc\\` + LF + `def`, the caret after `def`, Backspace ×3, Cmd/Ctrl+/ then `X` — the source caret is after `abc`, the pane and the copy are `abcX`", async ({
    page,
  }) => {
    const seed = "abc\\\ndef\n";
    await openRendered(page);
    await load(page, "toggle-trailing-break.md", seed);
    await expect.poll(() => markdown(page)).toBe(seed);
    expect(await hardBreaks(page)).toBe(1);

    // The caret placed by a click and asserted before any key: the second line's end.
    await clickSecondLineEnd(page);
    expect(await caret(page)).toEqual({ text: "def", offset: 3 });

    // Three Backspaces take `def` and leave the paragraph `abc` + `hard_break`: the rendered
    // view keeps the break (the tree the Backspace built) while the bytes drop it — the case
    // whose bytes cannot tell the two trees apart, so the tree is asserted (DECISIONS #022).
    await press(page, "Backspace", 3);
    await expect.poll(() => markdown(page)).toBe("abc\n");
    expect(await hardBreaks(page)).toBe(1);

    // The toggle chord (the app's own binding, not a caret motion), then one keystroke: where
    // the source caret landed is what the bytes now say.
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.type("X", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("abcX\n");
    const pane = (await markdown(page)) as string;
    expect(pane).toBe("abcX\n");
    expect(format(parse(pane))).toBe(pane);
    expect(await clickCopyMarkdown(page)).toBe("abcX\n");
  });
});
