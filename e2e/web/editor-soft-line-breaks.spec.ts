import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.25's browser half (DECISIONS #review-1-r1 G3 and G4).
 *
 * G3: typing one character anywhere in a paragraph that holds a Markdown soft line break used to
 * rewrite *every* line break in that paragraph to a space. The headless suites could not see it,
 * because it is not a property of the model conversion at all: `prosemirror-view` reparses the DOM
 * the browser just mutated (`readDOMChange` → `parseBetween`) and derives its whitespace mode from
 * the parent node type's own `whitespace` property, never from a `parseDOM` rule's
 * `preserveWhitespace`. Only a real `contenteditable` runs that path, so only this file can prove
 * the `whitespace: "pre"` added to `paragraph`, `heading` and `table_cell` is the setting that
 * repairs it.
 *
 * G4: with soft breaks now surviving typing, the whitespace micromark strips has more boundaries
 * than the block's two ends task 1.13 closed — the start of the line after a hard break
 * (CommonMark §6.7) and both sides of every soft break (§6.8). A space typed at one of those used
 * to reach `format`, whose `unsafe` table encodes a space before a line ending as `&#x20;`.
 *
 * Caret placement is by counted `ArrowRight`/`ArrowLeft` from a document end, never by `Home`/
 * `End`: a soft break is a literal `\n` inside a text node and the rendered view wraps it as
 * ordinary whitespace, so the *visual* lines a `Home` press navigates are the browser's wrap
 * points and not the source's lines. Counting characters is what makes these cases mean the
 * position their titles claim.
 *
 * Run against the branch base (`git checkout e038619 -- packages/editor/src/schema.ts`), the first
 * three cases go red and the absence case stays green; recorded in the journal for task 1.25.
 */

const HARD_BREAK_FIXTURE = fileURLToPath(
  new URL("../../fixtures/markdown/hard-break.md", import.meta.url),
);

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

/** Open `/dev/editor` on an empty store, in the rendered view. */
async function openRendered(page: Page): Promise<void> {
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

test.describe("a soft line break survives typing, and the whitespace around it never reaches the Markdown", () => {
  test("G3: a character typed at the end of a wrapped paragraph keeps the break", async ({
    page,
  }) => {
    await openRendered(page);
    await seedFromSource(page, "alpha\nbeta gamma");
    await expect.poll(() => markdown(page)).toBe("alpha\nbeta gamma\n");

    // The caret is carried to the end of `beta gamma`, where the source view left it.
    await page.keyboard.type("X", { delay: 10 });

    // Before this task: `alpha beta gammaX\n` — one keystroke rewrote a break the user typed.
    await expect.poll(() => markdown(page)).toBe("alpha\nbeta gammaX\n");
  });

  test("G4: a space typed at the end of the first line of a wrapped paragraph carries no entity", async ({
    page,
  }) => {
    await openRendered(page);
    await seedFromSource(page, "alpha\nbeta gamma");
    await expect.poll(() => markdown(page)).toBe("alpha\nbeta gamma\n");

    // To the document start, then five characters right: after `alpha`, before the break.
    await page.keyboard.press("ControlOrMeta+Home");
    await press(page, "ArrowRight", "alpha".length);
    await page.keyboard.type(" ", { delay: 10 });

    // CommonMark §6.8 removes the space at the end of the line, so the bytes are unchanged.
    await expect.poll(() => markdown(page)).toBe("alpha\nbeta gamma\n");
    expect(await markdown(page)).not.toContain("&#x20;");
  });

  test("G4: a space typed at the start of the line after a hard break carries no entity", async ({
    page,
  }) => {
    await openRendered(page);
    await page.getByTestId("fixture-file").setInputFiles(HARD_BREAK_FIXTURE);
    await expect(page.getByTestId("status")).toHaveText("Loaded hard-break.md");
    await expect
      .poll(() => markdown(page))
      .toBe("First line of the paragraph\\\nSecond line after a hard break.\n");

    // To the document end, then left across the whole continuation line: the caret lands
    // immediately after the hard break, which is where Claude's reproduction types.
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("ControlOrMeta+End");
    await press(page, "ArrowLeft", "Second line after a hard break.".length);
    await page.keyboard.type(" ", { delay: 10 });

    // CommonMark §6.7 ignores the leading spaces of the continuation line. Before this task the
    // same keystroke gave `\\\n&#x20;Second line after a hard break.\n`.
    await expect
      .poll(() => markdown(page))
      .toBe("First line of the paragraph\\\nSecond line after a hard break.\n");
    expect(await markdown(page)).not.toContain("&#x20;");
  });

  test("the absence case: a paragraph with no soft break is unchanged", async ({ page }) => {
    await openRendered(page);
    await seedFromSource(page, "alpha beta");
    await expect.poll(() => markdown(page)).toBe("alpha beta\n");

    await page.keyboard.type("X", { delay: 10 });

    // The same string this case produced before the task: nothing about a paragraph without a
    // break changes, which is what makes the three cases above attributable to the break.
    await expect.poll(() => markdown(page)).toBe("alpha betaX\n");
  });
});
