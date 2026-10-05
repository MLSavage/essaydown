import { expect, test, type Page } from "@playwright/test";

/**
 * Task 3.14 (DECISIONS #review-1-r6 L9): a URL typed in the rendered view reached the serializer as
 * one `text` node and the Markdown pane showed `See https\://example.com/a\_b for details.` —
 * backslashes the writer never typed. The headless halves are `packages/core/test/url-bytes.test.ts`
 * and `packages/editor/test/url-typing.test.ts`; this is the half a real `contenteditable` gives:
 * the browser writes the typed characters, `prosemirror-view` reads them back, and the pane
 * serialises the document the editor really holds.
 */

async function openBlankEditor(page: Page): Promise<void> {
  await page.goto("/dev/editor");
  await page.locator(".ProseMirror").click();
  await expect.poll(() => page.getByTestId("markdown").textContent()).toBe("");
}

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

test.describe("a URL typed on /dev/editor keeps the writer's bytes in the Markdown pane", () => {
  test("the task's sentence: no backslash, no `<…>`", async ({ page }) => {
    await openBlankEditor(page);
    await page.keyboard.type("See https://example.com/a_b for details.", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("See https://example.com/a_b for details.\n");
  });

  test("the URL followed by `.` at the end of the block", async ({ page }) => {
    await openBlankEditor(page);
    await page.keyboard.type("Read https://example.com/a_b.", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("Read https://example.com/a_b.\n");
  });

  test("absence: an underscore pair outside a URL is still escaped as before", async ({ page }) => {
    await openBlankEditor(page);
    await page.keyboard.type("See example a_b for details.", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("See example a\\_b for details.\n");
  });
});
