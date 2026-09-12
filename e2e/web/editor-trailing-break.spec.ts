import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.29's browser half (DECISIONS #review-1-r2 H1, H5 and H6).
 *
 * H1: a `hard_break` left as a paragraph's last node — three Backspace presses from
 * `hard-break.md`'s shape — reached `format`, which wrote it as a bare trailing `\` that `parse`
 * reads as a literal backslash: the Markdown pane showed `one\` + newline, "Copy Markdown" put
 * exactly that on the clipboard, and the copied file did not round-trip (PRD §7). H5: a heading
 * ending the same way reparsed as a paragraph. `packages/editor/test/editor-fixed-point.test.ts`
 * holds the guards and the corpus leg; these cases are the same trees built the way a user builds
 * them, by **deleting** rather than typing, because every previous case in this directory typed.
 *
 * H6: a GFM cell cannot hold a line ending, so a line ending that reaches a cell's text through
 * the browser used to serialise as a numeric character reference for the line feed (asserted
 * absent below, never spelled here). The route the task named — a multi-line plain-text
 * paste — turns out not to reach one: ProseMirror splits the pasted text into one paragraph per
 * line and its fitter closes the cell, the row and the table to place the second paragraph, so the
 * table is cut in two and no cell ever holds the ending. That case therefore asserts only what
 * the finding is about — no entity, and a pane that is a `parse`∘`format` fixed point — and not
 * the split, which is a paste-fitting behaviour outside this task (docs/V1.1-BACKLOG.md), not a
 * shape to pin as correct. The route that does reach a cell's line ending is `insertText` (an IME
 * commit, a drop, the CDP `Input.insertText` Playwright sends): the browser inserts the `\n` into
 * the `white-space: pre-wrap` cell as a character, and `readDOMChange` reads it into the cell's
 * text under `whitespace: "pre"` (task 1.25), the same path a soft break takes in a paragraph.
 * That case asserts the pane holds one space and no entity.
 *
 * A copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
 *
 * Caret placement (DECISIONS #022, the rule stated in `editor-mark-edge.spec.ts`; task 1.38 after
 * #review-1-r3 I6): the rendered caret is placed only by motions Blink decides by itself, so a
 * pass in the Linux container is a pass for every OS — `ArrowDown`, which on a block's last visual
 * line is Blink's motion to the editable root's end (no line to move to, so the caret goes to the
 * content's edge), pressed once per visual line the block renders (a hard break is a `<br>`), the
 * extra presses changing nothing once the edge is reached. Never a Home or End key and never a
 * modifier chord for caret motion in the rendered view: a contenteditable resolves those through
 * the OS's key-binding layer (Cocoa scrolls on them), so on macOS the two chords this file used to
 * press were no-ops that happened to follow a click already at the document's end. Each case
 * asserts the caret is at the block's end — the DOM selection's anchor text and offset,
 * byte-exact — before it deletes or pastes, because its bytes cannot tell a right placement from
 * a wrong one.
 */

/** The arguments of the `writeText` calls the app made, newest last, recorded on the window. */
type WriteTextSpy = { calls: string[] };

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

/** Open `/dev/editor` on an empty store, in the rendered view, with `writeText` spied. */
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

/** Type `text` into the source view, then swap back to the rendered one. */
async function seedFromSource(page: Page, text: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("mode")).toHaveText("source");
  await page.locator(".cm-content").waitFor();
  await page.keyboard.insertText(text);
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("mode")).toHaveText("rendered");
  await page.locator(".ProseMirror").waitFor();
}

async function press(page: Page, key: string, times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) await page.keyboard.press(key);
}

/** To the document's end: `ArrowDown` once per visual line the document renders (see the file comment). */
async function toDocumentEnd(page: Page, lines: number): Promise<void> {
  await press(page, "ArrowDown", lines);
}

/**
 * The rendered caret as the DOM selection reports it: the anchor text node's text, byte for
 * byte, and the caret's offset in it. A caret in a text block is a collapsed selection anchored
 * in a `Text` node; any other shape is reported as its kind so that it fails the location
 * assertion outright instead of reading as an offset in the wrong node.
 */
function caret(page: Page): Promise<{ kind: string; text: string | null; offset: number }> {
  return page.evaluate(() => {
    const selection = document.getSelection();
    if (selection === null || selection.anchorNode === null) {
      return { kind: "none", text: null, offset: -1 };
    }
    if (!selection.isCollapsed) return { kind: "range", text: null, offset: -1 };
    const node = selection.anchorNode;
    if (node.nodeType !== Node.TEXT_NODE) {
      return { kind: `element:${node.nodeName}`, text: null, offset: selection.anchorOffset };
    }
    return { kind: "text", text: node.textContent, offset: selection.anchorOffset };
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
 * Paste one flavour over the caret through the editor's own paste handler, with a real
 * `DataTransfer` and no OS clipboard (`editor-clipboard.spec.ts`'s route). A heading with a hard
 * break inside it is a tree no Markdown file parses to (an ATX heading is one line), so it is
 * built here the one way a user can build it: by pasting rich text that carries a `<br>`.
 */
async function paste(
  page: Page,
  flavour: "text/html" | "text/plain",
  payload: string,
): Promise<void> {
  await page.evaluate(
    ([type, content]) => {
      const dom = document.querySelector(".ProseMirror");
      if (dom === null) throw new Error("no editor on the page");
      const data = new DataTransfer();
      data.setData(type, content);
      dom.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    [flavour, payload],
  );
}

/** Open an empty editor and type the table input rule's row: the caret is left in the first body cell. */
async function openInsideEmptyBodyCell(page: Page): Promise<void> {
  await openRendered(page);
  await page.keyboard.type("|a|b|", { delay: 10 });
  await page.keyboard.press("Enter");
  await expect.poll(() => markdown(page)).toBe("| a | b |\n| - | - |\n|   |   |\n");
}

test.describe("a hard break left last in its block by a deletion never reaches the Markdown", () => {
  test("H1: three Backspaces from hard-break.md's shape leave `one`, and the copy is the same bytes", async ({
    page,
  }) => {
    await openRendered(page);
    await seedFromSource(page, "one\\\ntwo");
    await expect.poll(() => markdown(page)).toBe("one\\\ntwo\n");

    // To the document end (two visual lines), asserted as the end of the continuation line's
    // text, then the whole continuation line deleted: the break is now the paragraph's last
    // node. Before this task the pane read `one\` + newline — a literal backslash to any
    // Markdown reader — and the copy carried the same bytes.
    await toDocumentEnd(page, 2);
    await expect
      .poll(() => caret(page))
      .toEqual({ kind: "text", text: "two", offset: "two".length });
    await press(page, "Backspace", "two".length);
    await expect.poll(() => markdown(page)).toBe("one\n");

    const written = await clickCopyMarkdown(page);
    expect(written).toBe("one\n");
  });

  test("H5: a heading whose continuation is deleted stays an ATX heading", async ({ page }) => {
    await openRendered(page);
    await seedFromSource(page, "## one");
    await expect.poll(() => markdown(page)).toBe("## one\n");
    await page.locator(".ProseMirror").click();
    // To the document end (one visual line), asserted as the end of the heading's text, so the
    // paste lands after `one`.
    await toDocumentEnd(page, 1);
    await expect
      .poll(() => caret(page))
      .toEqual({ kind: "text", text: "one", offset: "one".length });
    await paste(page, "text/html", "<br>two");
    // The serializer has no ATX spelling for a heading holding a break, so the pane shows the
    // break inside the heading as a backslash before a line ending; that is the seed, not the
    // claim.
    await expect.poll(() => markdown(page)).toContain("\\\n");

    await press(page, "Backspace", "two".length);
    // Before this task: `one\` + newline + a blank line — which `parse` reads as a paragraph, the
    // block type lost.
    await expect.poll(() => markdown(page)).toBe("## one\n");
    const written = await clickCopyMarkdown(page);
    expect(written).toBe("## one\n");
  });

  test("H6: a line ending inserted into a table cell becomes one space, never an entity", async ({
    page,
  }) => {
    await openInsideEmptyBodyCell(page);
    // `insertText` is the route that reaches a cell's line ending (see the file comment): the
    // `\n` lands in the cell's text. Before this task the pane read `x`, the entity, `y`.
    await page.keyboard.insertText("x\ny");
    await expect.poll(() => markdown(page)).toBe("| a   | b |\n| --- | - |\n| x y |   |\n");
    expect(await markdown(page)).not.toContain("&#xA;");
    expect(await page.locator(".ProseMirror table").count()).toBe(1);
  });

  test("H6 (the route the task named): a multi-line plain-text paste into a cell reaches no cell line ending, carries no entity and is a fixed point", async ({
    page,
  }) => {
    await openInsideEmptyBodyCell(page);
    await paste(page, "text/plain", "x\ny");
    // The second line does not stay in the cell (see the file comment), so what is asserted is the
    // finding's own property and not the shape the fitter chose.
    await expect.poll(() => markdown(page)).toContain("| x");
    const pane = (await markdown(page)) as string;
    expect(pane).not.toContain("&#xA;");
    expect(pane).toContain("y");
    expect(format(parse(pane))).toBe(pane);
  });
});
