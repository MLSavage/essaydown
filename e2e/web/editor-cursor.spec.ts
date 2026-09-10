import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.16's acceptance (DECISIONS #review-1-r0 F4): Sol's two reproductions of the cursor
 * crossing from the source view to the rendered one, each driven to the end — the character typed
 * after the swap has to land where the caret was, so the assertion is the exact Markdown pane.
 *
 * Finding 2 is the live buffer's own layout (`alpha\n\n\n\nbeta`, whose canonical form has three
 * lines, not five); finding 3 is the character offsets inside one node, probed on an escape
 * (`a\*b c`) and on a blockquote's continuation prefix (`> alpha\n> beta gamma`). The headless
 * half is `packages/editor/test/toggle.test.ts`, which asserts the (line, ch) and ProseMirror
 * position of each by hand; this file asserts what the user sees instead, and it is the only half
 * where the caret is a real browser caret moved by real arrow keys.
 *
 * Each of the three reproductions was run against the pre-fix code and went red there, with the
 * `X` one, two and two columns off respectively (`betaX`, `a\*bX c`, `> alpha beXta gamma`); the
 * undo case stayed green, because it asserts what the fix must not do.
 */

/** Open `/dev/editor` on an empty store and swap to the source view. */
async function openSource(page: Page): Promise<void> {
  await page.goto("/dev/editor");
  await page.locator(".ProseMirror").click();
  await expect.poll(() => markdown(page)).toBe("");
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("mode")).toHaveText("source");
  await page.locator(".cm-content").waitFor();
}

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

/** Put the caret `ch` columns into the line the caret is currently on. */
async function toColumn(page: Page, ch: number): Promise<void> {
  await page.keyboard.press("Home");
  for (let step = 0; step < ch; step += 1) await page.keyboard.press("ArrowRight");
}

/** Swap back to the rendered view and type one `X` at the carried cursor. */
async function typeXInRendered(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("mode")).toHaveText("rendered");
  await page.locator(".ProseMirror").waitFor();
  await page.keyboard.type("X", { delay: 10 });
}

test.describe("the cursor carried out of the source view (task 1.16)", () => {
  test("Sol finding 2: extra blank lines do not move the next rendered edit", async ({ page }) => {
    await openSource(page);
    await page.keyboard.insertText("alpha\n\n\n\nbeta");
    await expect.poll(() => markdown(page)).toBe("alpha\n\nbeta\n");

    // The caret is after `beta` on the live line 5; put it before the `b`.
    await toColumn(page, 0);
    await typeXInRendered(page);

    await expect.poll(() => markdown(page)).toBe("alpha\n\nXbeta\n");
  });

  test("Sol finding 3: an escaped character does not shift the caret", async ({ page }) => {
    await openSource(page);
    await page.keyboard.insertText("a\\*b c");
    await expect.poll(() => markdown(page)).toBe("a\\*b c\n");

    // Column 3 of `a\*b c` is the `b`: the `\` and the `*` are one character of the document.
    await toColumn(page, 3);
    await typeXInRendered(page);

    await expect.poll(() => markdown(page)).toBe("a\\*Xb c\n");
  });

  test("Sol finding 3: a blockquote's `> ` prefix does not shift the caret", async ({ page }) => {
    await openSource(page);
    await page.keyboard.insertText("> alpha\n> beta gamma");
    await expect.poll(() => markdown(page)).toBe("> alpha\n> beta gamma\n");

    // Column 2 of `> beta gamma` is the `b`; the prefix is not part of the paragraph's text.
    await toColumn(page, 2);
    await typeXInRendered(page);

    // The `X` lands immediately before `beta`, which is this task's whole claim. The soft line
    // break used to collapse to a space here — a separate, pre-existing defect and not the
    // cursor's, which 1.16 pinned as the exact pane of the day (`> alpha Xbeta gamma\n`) with a
    // comment saying this line becomes the expectation below when it is fixed. Task 1.25 fixed it
    // (DECISIONS #review-1-r1 G3, `whitespace: "pre"` on the inline-content node specs), so the
    // tripwire has fired and this is now the assertion it named.
    await expect.poll(() => markdown(page)).toBe("> alpha\n> Xbeta gamma\n");
  });

  test("the translation is not an edit: one Undo takes the typed word back", async ({ page }) => {
    await openSource(page);
    await page.keyboard.insertText("alpha\n\n\n\nbeta");
    await expect.poll(() => markdown(page)).toBe("alpha\n\nbeta\n");

    await toColumn(page, 0);
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    await page.locator(".ProseMirror").waitFor();

    // Nothing was pushed by the swap, so the first Undo takes back the last real edit.
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => markdown(page)).toBe("");
  });
});
