import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.4's acceptance: the reveal-on-active-line decorations, seen in a real browser's DOM.
 *
 * The document is typed rather than loaded — task 1.3's input rules turn `# Title` into a heading
 * and `**world**` into a strong span — so the delimiters asserted here are decorations and cannot
 * be leftover characters of the text: `**` is not in the document at any point after the rule
 * fires, and the Markdown pane beside the editor shows the same document either way.
 *
 * The acceptance names **8 assertions**, and there are exactly eight `expect` calls below,
 * numbered A1–A8 in the test titles. The helpers wait with `waitForFunction`, not with `expect`,
 * so the count stays exactly eight.
 */

const EDITOR = ".ProseMirror";
const DELIMITER = ".essaydown-delimiter";

/** Open the dev route and wait for an empty, focused editor. */
async function openBlankEditor(page: Page): Promise<void> {
  await page.goto("/dev/editor");
  await page.locator(EDITOR).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="markdown"]')?.textContent === "",
  );
}

/**
 * Type the acceptance's document: a level-1 heading and a paragraph whose last word is strong.
 * The cursor is left at the end of the paragraph, i.e. inside the strong span's block.
 */
async function typeDocument(page: Page): Promise<void> {
  await openBlankEditor(page);
  await page.keyboard.type("# Title", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Hello **world**", { delay: 10 });
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="markdown"]')?.textContent ===
      "# Title\n\nHello **world**\n",
  );
}

/** The rendered text of a block, delimiters included — what a reader of the block sees. */
function blockText(page: Page, selector: string): Promise<string> {
  return page.locator(`${EDITOR} ${selector}`).evaluate((node) => node.textContent ?? "");
}

/** Click into a block and wait for the decorations to follow the cursor. */
async function putCursorIn(page: Page, selector: string): Promise<void> {
  await page.locator(`${EDITOR} ${selector}`).click();
  await page.waitForFunction(
    ([editor, delimiter, block]) => {
      const active = document.querySelector(`${editor} ${block}`);
      return active !== null && active.querySelector(delimiter) !== null;
    },
    [EDITOR, DELIMITER, selector] as const,
  );
}

test.describe("reveal on the active line, on /dev/editor", () => {
  test("A1–A2: the cursor inside a strong span reveals `**` adjacent to the text", async ({
    page,
  }) => {
    await typeDocument(page);
    // A1: the literal delimiters are in the DOM, on both sides of the word.
    expect(await blockText(page, "p")).toBe("Hello **world**");
    // A2: and adjacent to the text — the immediate siblings of the <strong> element, outside it,
    // so they are neither bold nor part of the strong span's own text.
    expect(
      await page.locator(`${EDITOR} p strong`).evaluate((node) => ({
        before: node.previousElementSibling?.textContent,
        after: node.nextElementSibling?.textContent,
        strong: node.textContent,
      })),
    ).toEqual({ before: "**", after: "**", strong: "world" });
  });

  test("A3–A4: another block's delimiters are hidden while the cursor is elsewhere", async ({
    page,
  }) => {
    await typeDocument(page);
    // A3: the heading's `#` is not shown while the cursor is in the paragraph.
    expect(await blockText(page, "h1")).toBe("Title");
    // A4: nothing in the heading carries the delimiter class either.
    expect(await page.locator(`${EDITOR} h1 ${DELIMITER}`).count()).toBe(0);
  });

  test("A5–A8: the heading's `#` follows the same rule, and moving back restores the `**`", async ({
    page,
  }) => {
    await typeDocument(page);
    await putCursorIn(page, "h1");
    // A5: the heading now shows its own marker.
    expect(await blockText(page, "h1")).toBe("# Title");
    // A6: drawn before the text, as the first child of the heading.
    expect(
      await page
        .locator(`${EDITOR} h1`)
        .evaluate((node) => node.firstElementChild?.getAttribute("data-delimiter")),
    ).toBe("# ");
    // A7: and the paragraph's `**` were removed when the cursor left it.
    expect(await blockText(page, "p")).toBe("Hello world");
    // A8: moving the cursor back swaps them again — the paragraph reveals, the heading hides.
    await putCursorIn(page, "p");
    expect({
      heading: await blockText(page, "h1"),
      paragraph: await blockText(page, "p"),
    }).toEqual({ heading: "Title", paragraph: "Hello **world**" });
  });
});
