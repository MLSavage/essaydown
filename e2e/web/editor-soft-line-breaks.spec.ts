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
 * to reach `format`, whose `unsafe` table encodes a space before a line ending as a numeric
 * character reference.
 *
 * Caret placement (DECISIONS #022 and #024, the rule stated in `editor-mark-edge.spec.ts`; task
 * 1.38 after #review-1-r3 I6, repaired by task 1.39 after the 1.verify.r4h gate): in the rendered
 * view a position is reached by counted horizontal arrows (`ArrowLeft`/`ArrowRight`) from an anchor
 * the case asserts first — the block's end, where `seedFromSource`'s click and the `.ProseMirror`
 * click leave the caret on every OS. The count is a property of the document's characters: under
 * the editor's `white-space: pre-wrap` a soft break is one LF in the text node, a hard break one
 * `<br>`, each a single caret position. A vertical arrow (up or down) is used only in a one-line
 * block, where it has no line to move to and Blink's motion goes to the block's edge; in a block
 * that renders more than one line a vertical arrow lands by the caret's x, the wrapping and the
 * font metrics, so two presses left the 1.verify.r4h gate at offset 3 on ubuntu and 11 on windows
 * in the two-line paragraph below. Never a Home or End key and never a modifier chord for caret
 * motion in the rendered view: a contenteditable resolves those through the OS's key-binding
 * layer (Cocoa scrolls on them; its document motion is a Cmd+Arrow), so the 1.verify.r3h gate
 * typed where the seed had left the caret. "Blink-only" means decided from the document's
 * characters alone, not merely handled by Blink. Each case asserts its position, as the DOM
 * selection's anchor text and offset (byte-exact), at the anchor and again before it types: the
 * bytes of a space typed at a line's *end* and at a paragraph's end are the same (CommonMark
 * strips both), so only the location assertion can fail on a wrong-end placement.
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

    // The anchor: the paragraph's end, where the source view left the caret, asserted first. Then
    // left across the second line and the break (the LF is one character in the text node):
    // after `alpha`, before the break. The location assertion is the one that can fail on a
    // wrong-end placement: a space typed at the paragraph's end gives the same bytes as one typed
    // here (both are stripped), so "bytes unchanged" alone proves nothing about the first line.
    await expect
      .poll(() => caret(page))
      .toEqual({
        kind: "text",
        text: "alpha\nbeta gamma",
        offset: "alpha\nbeta gamma".length,
      });
    await press(page, "ArrowLeft", "beta gamma".length + 1);
    await expect
      .poll(() => caret(page))
      .toEqual({ kind: "text", text: "alpha\nbeta gamma", offset: "alpha".length });
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

    // The anchor: the click's caret at the block's end, asserted as the end of the continuation
    // line's text, then left across the whole continuation line: the caret lands immediately
    // after the hard break, which is where Claude's reproduction types.
    await page.locator(".ProseMirror").click();
    await expect
      .poll(() => caret(page))
      .toEqual({
        kind: "text",
        text: "Second line after a hard break.",
        offset: "Second line after a hard break.".length,
      });
    await press(page, "ArrowLeft", "Second line after a hard break.".length);
    await page.keyboard.type(" ", { delay: 10 });

    // CommonMark §6.7 ignores the leading spaces of the continuation line. Before this task the
    // same keystroke gave the backslash, the line ending, a numeric character reference for the
    // space, then `Second line after a hard break.`.
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
