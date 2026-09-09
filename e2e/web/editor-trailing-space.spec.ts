import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.13's acceptance (DECISIONS #review-1-r0 F1): a trailing space typed before Enter used to
 * reach the serializer, which encodes a space before a line ending as a numeric character
 * reference. The fix strips the whitespace micromark strips on the way out of the editor's tree
 * (`trimBlockEnds`, schema.ts), and `packages/editor/test/editor-fixed-point.test.ts` is the
 * headless half that covers it.
 *
 * This is the half a headless run cannot give: a real `contenteditable`, where the browser writes
 * the typed space into the DOM and `prosemirror-view` reads it back, so the space genuinely is in
 * the document when the Markdown pane serialises it. Presence and absence are the same string —
 * that is the point of the fix — so the pair only means something because the presence case is
 * known to have produced the entity before the fix (recorded in the journal, not assertable here
 * without shipping the defect).
 */

async function openBlankEditor(page: Page): Promise<void> {
  await page.goto("/dev/editor");
  await page.locator(".ProseMirror").click();
  await expect.poll(() => page.getByTestId("markdown").textContent()).toBe("");
}

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

test.describe("a trailing space typed on /dev/editor never reaches the Markdown", () => {
  test("presence: X, space, Enter, Y is exactly X\\n\\nY\\n", async ({ page }) => {
    await openBlankEditor(page);
    await page.keyboard.type("X ", { delay: 10 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("Y", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("X\n\nY\n");
    expect(await markdown(page)).not.toContain("&#x20;");
  });

  test("absence: X, Enter, Y is the same string", async ({ page }) => {
    await openBlankEditor(page);
    await page.keyboard.type("X", { delay: 10 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("Y", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("X\n\nY\n");
  });

  test("a list item typed with a trailing space carries no entity", async ({ page }) => {
    await openBlankEditor(page);
    await page.keyboard.type("- one ", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("- one\n");
    expect(await markdown(page)).not.toContain("&#x20;");
  });

  test("a heading typed with a trailing space carries no entity", async ({ page }) => {
    await openBlankEditor(page);
    await page.keyboard.type("## Title ", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("## Title\n");
    expect(await markdown(page)).not.toContain("&#x20;");
  });
});
