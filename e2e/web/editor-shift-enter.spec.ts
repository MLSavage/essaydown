import { expect, test, type Page } from "@playwright/test";

/**
 * Task 3.16's browser half: Michael's 2.9 note (#006-mac-sync-smoke) — "Shift+Enter doesn't insert
 * a line break, and I'd like it to." `packages/editor/test/input.test.ts` covers
 * `insertHardBreak`'s branches headlessly; this file proves the same key, dispatched as a real
 * keyboard event, reaches `prosemirror-view`'s keymap handling and serialises to the expected
 * bytes.
 *
 * Caret placement (CLAUDE.md, DECISIONS #022/#024): counted `ArrowLeft` from the block's end, where
 * typing leaves the caret on every OS — never Home/End or a modifier chord in the contenteditable.
 * The guard before the key that follows the motion reads the dev bar's own selection readout
 * (task 1.62), not the DOM's: `selectionchange` lands one rendering step after the key, and
 * `insertHardBreak` reads ProseMirror's own selection, the same class of race lesson [3.9] names
 * for `Backspace`/`Delete`.
 */

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

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

/** A counted `ArrowLeft`, waiting after each press for the DOM caret to differ (DECISIONS #034). */
async function pressArrowLeft(page: Page, times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) {
    const previous = JSON.stringify(await caret(page));
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => JSON.stringify(await caret(page)) !== previous).toBe(true);
  }
}

/** The dev bar's selection readout (task 1.62), parsed — the editor's own selection, not the DOM's. */
async function selectionBefore(page: Page): Promise<string | null> {
  const text = await page.getByTestId("selection").textContent();
  return (JSON.parse(text ?? "null") as { before: string | null }).before;
}

async function openBlankEditor(page: Page): Promise<void> {
  await page.goto("/dev/editor");
  await page.locator(".ProseMirror").click();
  await expect.poll(() => markdown(page)).toBe("");
}

test.describe("Shift+Enter inserts a hard line break", () => {
  test("between two words, typing continues after the break", async ({ page }) => {
    await openBlankEditor(page);
    await page.keyboard.type("alphabeta", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("alphabeta\n");

    await pressArrowLeft(page, "beta".length);
    await expect
      .poll(() => caret(page))
      .toEqual({ kind: "text", text: "alphabeta", offset: "alpha".length });
    await expect.poll(() => selectionBefore(page)).toBe("alpha");

    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("X", { delay: 10 });

    await expect.poll(() => markdown(page)).toBe("alpha\\\nXbeta\n");
  });
});
