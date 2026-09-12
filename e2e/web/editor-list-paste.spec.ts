import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { List } from "mdast";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.36's browser half (DECISIONS #review-1-r3 I2, Sol's blocker).
 *
 * A `list_item` kept its parsed `spread` after a two-line plain-text paste gave it a second
 * paragraph, so `format` wrote the item as tight — one line ending before its nested list —
 * while the blank line the two paragraphs need made `parse` read the item as loose and write a
 * blank line before the nested list too: "Copy Markdown" put bytes on the clipboard that were
 * not a `parse`∘`format` fixed point and reported "Copied Markdown". The route is the paste:
 * Enter at the end of a list item's paragraph is `splitListItem`, which opens a new item, and
 * the paste fitter is what places a second paragraph *inside* the item.
 * `packages/editor/test/list-spread.test.ts` holds the guards and the two `parse(format(·))`
 * confirmations, `editor-fixed-point.test.ts` the corpus leg titled for the list split; this case
 * is Sol's log replayed on `/dev/editor`: `nested-lists.md` loaded, the first paragraph's end
 * clicked, `X` + newline + `Y` pasted as plain text, "Copy Markdown".
 *
 * The caret is placed by a click, a Blink-decided motion (DECISIONS #022: no Home/End key, no
 * modifier chord), and its text offset is asserted on its own before the paste (lesson
 * [1.10.r3d]: a bytes assertion after an action at a claimed position is satisfied by the same
 * action at the wrong one). The copy asserts the string the app handed `writeText`, recorded by
 * an init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
 */

const NESTED_LISTS = fileURLToPath(
  new URL("../../fixtures/markdown/nested-lists.md", import.meta.url),
);

/** The bytes the reconciliation recorded as the reparse of Sol's copy: the fixed point. */
const EXPECTED =
  "- Top level oneX\n\n  Y\n\n  - Second level one\n    - Third level one\n  - Second level two\n- Top level two\n";

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

/**
 * The text of the caret's top-level block before the caret, walked from the DOM selection and
 * skipping 1.4's delimiter widgets — the caret's precondition, asserted before the paste.
 */
function textBeforeCaret(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    if (anchor === null) return null;
    const element = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element);
    const block = element?.closest(".ProseMirror > *") ?? null;
    if (block === null) return null;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let before = "";
    let node = walker.nextNode();
    while (node !== null && node !== anchor) {
      if (node.parentElement?.closest(".essaydown-delimiter") === null)
        before += node.textContent ?? "";
      node = walker.nextNode();
    }
    return (
      before + (node === anchor ? (anchor.textContent ?? "").slice(0, selection.anchorOffset) : "")
    );
  });
}

/**
 * Count the `selectionchange` events from now on, after the ones already queued have fired: the
 * browser tells the editor where a click put the caret through that event, asynchronously, and
 * a synthetic paste dispatched before it fires lands where the editor last knew the caret to be
 * (typing never sees this: it goes through the DOM, not the editor's selection). The editor's
 * listener is registered at the view's creation, so when this one has counted the click's event
 * the editor's has already run.
 */
async function armSelectionChange(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const counter = window as unknown as { __selectionChanges: number };
        counter.__selectionChanges = 0;
        document.addEventListener("selectionchange", () => {
          counter.__selectionChanges += 1;
        });
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            counter.__selectionChanges = 0;
            resolve();
          }),
        );
      }),
  );
}

function selectionChanges(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __selectionChanges: number }).__selectionChanges,
  );
}

/**
 * Paste plain text over the caret through the editor's own paste handler, with a real
 * `DataTransfer` and no OS clipboard (`editor-trailing-break.spec.ts`'s route).
 */
async function pastePlainText(page: Page, payload: string): Promise<void> {
  await page.evaluate((content) => {
    const dom = document.querySelector(".ProseMirror");
    if (dom === null) throw new Error("no editor on the page");
    const data = new DataTransfer();
    data.setData("text/plain", content);
    dom.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, payload);
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

test.describe("a two-line paste into a tight list item (task 1.36)", () => {
  test("I2 (Sol's log): nested-lists.md loaded, `X` + newline + `Y` pasted at the first paragraph's end — the pane and the copy are the same bytes, a fixed point, and the item holds two paragraphs then its nested list", async ({
    page,
  }) => {
    await openRendered(page);
    await page.getByTestId("fixture-file").setInputFiles(NESTED_LISTS);
    await expect(page.getByTestId("status")).toHaveText("Loaded nested-lists.md");
    await expect
      .poll(() => markdown(page))
      .toBe(
        "- Top level one\n  - Second level one\n    - Third level one\n  - Second level two\n- Top level two\n",
      );

    // The caret at the first paragraph's end by a click at the right edge of its box — Blink's
    // own hit test puts the caret at the line's end — and the precondition asserted on its own.
    const first = page.locator(".ProseMirror li p").first();
    const box = await first.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;
    await armSelectionChange(page);
    await first.click({ position: { x: box.width - 2, y: box.height / 2 } });
    await expect.poll(() => selectionChanges(page)).toBeGreaterThan(0);
    expect(await textBeforeCaret(page)).toBe("Top level one");

    // Before this task the pane read `- Top level oneX` + blank line + `  Y` and then the nested
    // list on the very next line: bytes whose reparse writes a blank line before that list.
    await pastePlainText(page, "X\nY");
    await expect.poll(() => markdown(page)).toBe(EXPECTED);

    // The item's structure is what the paste built: two paragraphs, then the nested list.
    const children = await page
      .locator(".ProseMirror > ul > li")
      .first()
      .evaluate((li) => Array.from(li.children, (child) => child.tagName));
    expect(children).toEqual(["P", "P", "UL"]);

    const written = await clickCopyMarkdown(page);
    expect(written).toBe(EXPECTED);
    expect(format(parse(written))).toBe(written);
    const [outer] = parse(written).children as List[];
    expect(outer.children[0].children.map((child) => child.type)).toEqual([
      "paragraph",
      "paragraph",
      "list",
    ]);
    expect(outer.children[0].spread).toBe(true);
    expect(outer.spread).toBe(false);
  });
});
