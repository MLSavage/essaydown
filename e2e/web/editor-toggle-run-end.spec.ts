import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.53's browser half (DECISIONS #review-1-r6 L6 — Claude finding 5).
 *
 * The two views disagreed about the same caret at a marked run's end: `innermostAt`
 * (`packages/editor/src/toggle.ts`) handed a boundary to the later node, so the rendered caret at
 * the end of `~~beta.~~` (DOM anchor `{ text: "beta.", offset: 5 }`) toggled to the source column
 * *after* the closing `~~`, where a letter cannot close the run (CommonMark §6.2: `~~beta.~~X` is
 * not right-flanking after `.`) and the toggle back showed the delimiters as escaped literal text
 * (`Alpha \~\~beta.\~\~X gamma`, Claude's reproduction) — while the same caret typed in the
 * rendered view extends the run (ProseMirror's inclusive marks, `ResolvedPos.marks()`). Since
 * 1.53 the boundary belongs to the node whose marks are `doc.resolve(pos).marks()`, the run, and
 * the source caret lands inside the closing delimiter. This is that route, driven from a real
 * browser: the caret at the run's end, the toggle chord, `X`, the toggle back, Copy Markdown —
 * the bytes are `Alpha ~~beta.X~~ gamma`, a fixed point holding one `<del>` whose text is
 * `beta.X`, and no backslash in the pane.
 *
 * A copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
 *
 * Caret placement (DECISIONS #022, #024): a click on the paragraph, `ArrowUp` to the one-line
 * block's start, then counted `ArrowRight` with the anchor asserted after each run. Never a Home
 * or End key, never a modifier chord for the caret: `ControlOrMeta+/` is the app's toggle chord,
 * not a caret motion, and `tests/no-caret-chords-in-e2e.test.ts` allows it (Home/End chords
 * only). The chord follows the last arrow only after ProseMirror's observer has had a tick to
 * read the DOM selection (the precedent in `editor-toggle.spec.ts`, lesson [1.46]).
 * Helpers are copied from `editor-toggle-encoded-neighbour.spec.ts` (task 1.46), the 200 ms tick
 * before the chord included.
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

/**
 * Fires `key` `times` times for a counted horizontal motion, waiting after each press for the DOM
 * caret to differ from its reading taken before that press — the fix for the blind, unsynchronised
 * press the 1.verify.r6h gate's a1 run caught one short (editor-soft-line-breaks.spec.ts:111,
 * DECISIONS #review-1-r6 L7, #034). A count crossing a node boundary (the anchor text changes, the
 * offset resets) is covered by "differs": the reading taken after a press never equals the one
 * taken before it. This form is for `ArrowLeft`/`ArrowRight`/`Backspace`, which always move the
 * caret on a genuine press; a vertical motion pressed past the edge it reaches never differs and
 * uses the edge form (`pressToEdge`) instead — the four sites in this directory that press a
 * vertical arrow more than once (DECISIONS #034).
 */
async function press(page: Page, key: string, times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) {
    const previous = JSON.stringify(await caret(page));
    await page.keyboard.press(key);
    await expect.poll(async () => JSON.stringify(await caret(page)) !== previous).toBe(true);
  }
}

/**
 * A click on the paragraph's own bounding box, near its first character on its one line, asserted
 * as an anchor before any key; `ArrowUp` then takes the caret to the line's start, a motion Blink
 * alone decides — never a Home/End key or a chord (DECISIONS #022, #024).
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

/** The `delete` nodes in `bytes`'s own parse, wherever they are. */
function deletesIn(bytes: string): number {
  const walk = (node: { type: string; children?: unknown[] }): number =>
    (node.type === "delete" ? 1 : 0) +
    ((node.children ?? []) as (typeof node)[]).reduce((sum, child) => sum + walk(child), 0);
  return walk(parse(bytes));
}

/**
 * The paragraph's `textContent` with task 1.4's reveal decorations (`.essaydown-delimiter`, the
 * `~~` widgets drawn on the active line) taken out of a clone first: they are decorations, not
 * document text (lesson [1.45]), and the caret is on this paragraph after the toggle back.
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

test.describe("a toggle to source with the caret at a marked run's end", () => {
  test("Claude's reproduction: `Alpha ~~beta.~~ gamma`, the caret after `beta.`, Cmd/Ctrl+/ then `X`, toggle back — the keystroke extends the run in both views, never escapes its delimiters", async ({
    page,
  }) => {
    const seed = "Alpha ~~beta.~~ gamma\n";
    await openRendered(page);
    await load(page, "toggle-run-end.md", seed);
    await expect.poll(() => markdown(page)).toBe(seed);
    expect(await page.locator(".ProseMirror p").count()).toBe(1);
    expect(await page.locator(".ProseMirror del").count()).toBe(1);

    // The caret placed by a click and asserted as an anchor before any key; `ArrowUp` on a
    // one-line block is Blink's line-start motion.
    await clickParagraphStart(page);
    await expect.poll(() => caret(page)).toEqual({ text: "Alpha ", offset: 0 });
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => caret(page)).toEqual({ text: "Alpha ", offset: 0 });

    // Six to the right, to the boundary before the run, then five more to the run's end. The
    // anchor is what the DOM reports, read and asserted rather than assumed: Blink keeps the
    // caret in the node it moved through, so the run's end reads as `beta.` at offset 5.
    await press(page, "ArrowRight", 6);
    await expect.poll(() => caret(page)).toEqual({ text: "Alpha ", offset: 6 });
    await press(page, "ArrowRight", 5);
    await expect.poll(() => caret(page)).toEqual({ text: "beta.", offset: 5 });
    // The arrows moved the DOM selection natively; ProseMirror picks it up from `selectionchange`
    // in the rendering update after the key, so give the observer a tick before the chord reads
    // its state (lesson [1.46]; `editor-toggle.spec.ts`'s precedent).
    await page.waitForTimeout(200);

    // The toggle chord (the app's own binding, not a caret motion), then one keystroke: where the
    // source caret landed is what the bytes now say. Before 1.53, `toSource` of this caret was
    // the column after the closing `~~`, and the pane read `Alpha \~\~beta.\~\~X gamma`.
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.type("X", { delay: 10 });
    const bytes = "Alpha ~~beta.X~~ gamma\n";
    await expect.poll(() => markdown(page)).toBe(bytes);
    expect(await markdown(page)).not.toContain("\\");

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    await expect.poll(() => markdown(page)).toBe(bytes);
    expect(await markdown(page)).not.toContain("\\");
    const dels = page.locator(".ProseMirror del");
    expect(await dels.count()).toBe(1);
    expect(await dels.first().textContent()).toBe("beta.X");
    expect(await documentText(page)).toBe("Alpha beta.X gamma");

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(format(parse(copied))).toBe(copied);
    expect(deletesIn(copied)).toBe(1);
  });
});
