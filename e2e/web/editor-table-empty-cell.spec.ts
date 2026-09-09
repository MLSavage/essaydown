import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.15's browser half (DECISIONS #review-1-r0 F3): the cursor toggle out of the empty body
 * cell the table input rule of task 1.3 creates.
 *
 * `packages/core/test/positions.test.ts` proves that the position map now places a table's rows
 * and cells from the grid the serializer wrote, and that an empty cell is the zero-width point
 * between its delimiters. This is the half only a browser can prove: that the caret the input rule
 * leaves in that cell really does arrive in the source view inside the same two delimiters, over a
 * real ProseMirror, a real CodeMirror and a real keydown — which before the fix it did not, since
 * the cell had no range and the cursor fell back to the end of the last node that had one.
 *
 * The canonical text is written here, once, and every asserted line and `ch` is derived from it.
 */

/** What `|a|b|` + Enter serialises to: a header row, the delimiter row, an empty body row. */
const CANONICAL = "| a | b |\n| - | - |\n|   |   |\n";

/** The 0-based index of the body row's line, and of the empty cell under test. */
const BODY_LINE = 2;
const BODY_TEXT = CANONICAL.split("\n")[BODY_LINE];

/** The `ch` offsets of the body row's delimiters, read off the canonical text. */
const delimiters = [...BODY_TEXT].flatMap((char, index) => (char === "|" ? [index] : []));

/** Where a cursor sits in the CodeMirror view: the text of its line, and its offset in that line. */
interface SourceCursor {
  text: string;
  ch: number;
}

/**
 * The CodeMirror cursor read from the DOM selection, as `editor-toggle.spec.ts` reads it:
 * CodeMirror renders one `.cm-line` per document line and virtualises the rest, so the line is
 * identified by its text and turned into a line number here, where the whole document exists.
 */
function cmCursor(page: Page): Promise<SourceCursor | null> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    if (anchor === null) return null;
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
    return {
      text: line.textContent ?? "",
      ch: ch + (node === anchor ? selection.anchorOffset : 0),
    };
  });
}

/** The Markdown the store currently holds (the pane serialises the store's snapshot). */
function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

test.describe("the cursor toggle out of a new table's empty body cell", () => {
  test("lands inside that cell's own delimiters in the source view", async ({ page }) => {
    await page.goto("/dev/editor");
    await page.locator(".ProseMirror").click();
    await expect.poll(() => markdown(page)).toBe("");

    // The input rule of task 1.3: the typed row becomes the header and the caret is left in the
    // first cell of the empty body row it adds. Nothing is clicked afterwards, so the toggle below
    // carries exactly that caret.
    await page.keyboard.type("|a|b|", { delay: 10 });
    await page.keyboard.press("Enter");
    await expect.poll(() => markdown(page)).toBe(CANONICAL);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");

    const cursor = await expect
      .poll(async () => (await cmCursor(page))?.text ?? null)
      .toBe(BODY_TEXT)
      .then(() => cmCursor(page));
    expect(cursor).not.toBeNull();

    // The line: its text occurs once in the canonical string, so its index is its line number.
    const lines = CANONICAL.split("\n");
    expect(lines.indexOf(BODY_TEXT)).toBe(lines.lastIndexOf(BODY_TEXT));
    expect(lines.indexOf(cursor!.text)).toBe(BODY_LINE);

    // The column: strictly between the first cell's two delimiters, and one past the padding
    // space the serializer writes after the opening one.
    expect(cursor!.ch).toBeGreaterThan(delimiters[0]);
    expect(cursor!.ch).toBeLessThan(delimiters[1]);
    expect(cursor!.ch).toBe(delimiters[0] + 2);
  });
});
