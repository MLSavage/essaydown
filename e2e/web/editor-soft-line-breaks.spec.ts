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
 * block, where it has no line to move to and Blink's motion goes to the block's edge, or from a
 * line's left edge, where the landing is the previous line's start whatever the font measures
 * (G4 below, task 1.55 after the 1.verify.r7h gate, DECISIONS #035 — the landing is asserted);
 * anywhere else in a block that renders more than one line a vertical arrow lands by the caret's
 * x, the wrapping and the font metrics, so two presses left the 1.verify.r4h gate at offset 3 on
 * ubuntu and 11 on windows in the two-line paragraph below. A counted route never crosses a soft
 * break leftwards when the same position is reachable within its own line from an asserted anchor
 * (#035: that one step is the press the per-step poll named on windows-latest at the r6h and r7h
 * gates). Never a Home or End key and never a modifier chord for caret
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

/**
 * A computed-point click made bounded (DECISIONS #review-1-r9 O3, #041 D1): the click was lost
 * once in three full-suite container runs, or landed after the layout it was computed from
 * moved. Up to three tries, each re-reading `geometry` immediately before its own
 * `page.mouse.click` and then polling the caret with a short bound; the first try whose caret
 * reads `expected` stops the loop. The try count is never asserted here and no timing magnitude
 * from any one run enters this helper (#037, #039) — each poll uses Playwright's own default
 * timeout. The caller's own `expect.poll(() => caret(page))` still asserts the precondition
 * afterwards, exactly as before this helper existed; that assertion, not this one, is what a
 * genuinely lost click still fails.
 */
async function clickAtComputedPoint(
  page: Page,
  geometry: () => Promise<{ x: number; y: number }>,
  expected: { kind: string; text: string | null; offset: number },
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const point = await geometry();
    await page.mouse.click(point.x, point.y);
    try {
      await expect.poll(() => caret(page)).toEqual(expected);
      return;
    } catch {
      // The next try re-reads the geometry; the caller's own poll is the final assertion.
    }
  }
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

    // The anchor: the paragraph's end, where the source view left the caret, asserted first.
    await expect
      .poll(() => caret(page))
      .toEqual({
        kind: "text",
        text: "alpha\nbeta gamma",
        offset: "alpha\nbeta gamma".length,
      });

    // Every arrow route to the end of the first line has now failed on windows-latest at this one
    // position, by a third route in a row (the blind eleven lefts, 1.verify.r6h a1, #029; the
    // polled eleven lefts, 1.verify.r7h a1, #035; up-then-rights, 1.verify.r7.g1h a1, #036): the
    // gate's log put the ten lefts at offset 6 and the vertical arrow at offset 0, both as
    // asserted, but the five rights that followed landed at offset 11 — the caret was back at 6
    // before the first right, i.e. ProseMirror reverted the native vertical motion it had not yet
    // observed when the next key arrived (the `[1.46, found outside scope]` class: PM learns a
    // caret move from `selectionchange`, dispatched in the rendering update after the key, and
    // windows-latest is reliably not past that step before the next synthetic key lands, unlike
    // the container and the other two runners). A click is one native event with no second key in
    // flight, so the caret is placed there instead: a `Range` over the last character of `alpha`,
    // in the paragraph's own text node, gives the geometry to click at (DECISIONS #024, the route
    // beside arrows).
    const geometry = () =>
      page.evaluate(() => {
        const root = document.querySelector(".ProseMirror");
        if (root === null) throw new Error("no .ProseMirror root");
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let target: Text | null = null;
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          if (node.textContent === "alpha\nbeta gamma") {
            target = node as Text;
            break;
          }
        }
        if (target === null) throw new Error("text node not found");
        const range = document.createRange();
        range.setStart(target, "alpha".length - 1);
        range.setEnd(target, "alpha".length);
        const rect = range.getBoundingClientRect();
        return { x: rect.right - 1, y: rect.top + rect.height / 2 };
      });
    const expectedCaret = { kind: "text", text: "alpha\nbeta gamma", offset: "alpha".length };
    await clickAtComputedPoint(page, geometry, expectedCaret);
    await expect.poll(() => caret(page)).toEqual(expectedCaret);
    await page.keyboard.type(" ", { delay: 10 });

    // The discriminator the bytes cannot give (DECISIONS #022: a case whose bytes cannot tell two
    // trees apart asserts the tree): a space typed at the paragraph's end, at the second line's
    // start or here gives the same Markdown (CommonMark strips all three), so the rendered text
    // node is asserted to hold the space before the LF — the end of the first line.
    await expect
      .poll(() => caret(page).then((c) => c.text))
      .toBe("alpha \nbeta gamma");

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
