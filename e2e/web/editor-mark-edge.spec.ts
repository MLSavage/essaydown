import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.30's browser half (DECISIONS #review-1-r2 H8, Sol finding 2).
 *
 * The r1 backlog had deferred the space-reference family's emphasis-edge member as unreachable while no
 * mark-toggle command is bound; it is one keystroke away. A caret at the end of an emphasised
 * word sits *inside* the mark — every flanking mark in this schema is inclusive, and
 * `readDOMChange` inserts typed text with the marks of the position — so a space typed there
 * becomes `emphasis[text("b ")]`, a tree no Markdown file parses to (CommonMark §6.2: a closing
 * delimiter after whitespace is not right-flanking), which the serializer spelled as
 * `a *b` + a numeric character reference for the space, the closing `*`, another reference, `c`.
 * `packages/editor/test/editor-fixed-point.test.ts` holds the guards and
 * the corpus leg; these cases are the same shape built by ordinary key events on `/dev/editor`.
 *
 * The rendered document keeps the space where it was typed (the `<em>` still holds `b `; the
 * strip runs on the way out, where the pane, the copy button and the store read the same tree),
 * so the first case reads the `<em>`'s text to prove the space went *inside* the mark and the
 * absence case reads it to prove the space went outside. What the acceptance asserts is the
 * pane's bytes: no character reference, and a `parse`∘`format` fixed point.
 *
 * Two rules from the 1.verify.r3h gate (DECISIONS #022), where this file's H8 case was red on
 * macos-latest alone. (1) The rendered caret is placed only by motions Blink decides by itself,
 * so a pass in the Linux container is a pass for every OS: arrow keys — in a one-line block
 * `ArrowUp` reaches the block's start and `ArrowDown` its end — and then a counted
 * `ArrowRight`/`ArrowLeft`. Never a Home or End key and never a modifier chord for caret motion
 * in the rendered view: a contenteditable resolves those through the OS's key-binding layer
 * (Cocoa scrolls on Home and End; its document motion is a Cmd+Arrow), so the gate's run left the
 * caret where `seedFromSource`'s click had put it, the paragraph's end, typed the space after
 * `c`, and the trailing-whitespace clause stripped it to the seed's own bytes. (2) Every
 * assertion on the `<em>`'s text is byte-exact — `textContent()` compared with `toBe` — because
 * the matcher that normalises whitespace is the one that let that miss through (`<em>b</em>`
 * satisfied its check for `b` plus a space), and the pane's bytes are the same whether the space
 * was typed inside the mark and moved out by the clause or typed outside it after the delimiter,
 * so the `<em>` read is the only assertion that proves the keystroke built the finding's tree.
 */

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

/** Open `/dev/editor` on an empty store, in the rendered view. */
async function openRendered(page: Page): Promise<void> {
  await page.goto("/dev/editor");
  await page.locator(".ProseMirror").click();
  await expect.poll(() => markdown(page)).toBe("");
}

/** Type `text` into the source view, then swap back to the rendered one and focus it. */
async function seedFromSource(page: Page, text: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("mode")).toHaveText("source");
  await page.locator(".cm-content").waitFor();
  await page.keyboard.insertText(text);
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("mode")).toHaveText("rendered");
  await page.locator(".ProseMirror").waitFor();
  await page.locator(".ProseMirror").click();
}

async function press(page: Page, key: string, times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) await page.keyboard.press(key);
}

/** The `<em>`'s text, byte for byte (no whitespace normalisation). */
function emText(page: Page): Promise<string | null> {
  return page.locator(".ProseMirror em").textContent();
}

/** The pane's bytes hold no character reference for a space and are a `parse`∘`format` fixed point. */
async function expectClean(page: Page, bytes: string): Promise<void> {
  await expect.poll(() => markdown(page)).toBe(bytes);
  const pane = (await markdown(page)) as string;
  expect(pane).not.toContain("&#x20;");
  expect(format(parse(pane))).toBe(pane);
}

test.describe("a space typed at a mark edge never reaches the Markdown as a character reference", () => {
  test("H8 (Sol's reproduction): `a *b* c`, the caret after `b`, one space — the space lands inside the mark and the pane is clean", async ({
    page,
  }) => {
    await openRendered(page);
    await seedFromSource(page, "a *b* c");
    await expect.poll(() => markdown(page)).toBe("a *b* c\n");

    // To the block's start (one line, so `ArrowUp` is Blink's line-start motion), then three
    // characters right: `a`, the space, `b`. The caret is now immediately after `b`, inside the
    // emphasis.
    await page.keyboard.press("ArrowUp");
    await press(page, "ArrowRight", "a b".length);
    await page.keyboard.press("Space");

    // The typed space is inside the mark in the document (the finding's tree)…
    expect(await emText(page)).toBe("b ");
    // …and the pane holds the two spaces the document now has between `b` and `c` — the typed
    // one, moved out of the mark, and the seed's own — with no entity. Before this task it read
    // `a *b`, a numeric character reference for the space, `*`, another reference, `c`.
    await expectClean(page, "a *b*  c\n");

    // The same keystroke on `a *b*c` (no space of its own after the mark): the pane reads
    // `a *b* c`, the one space being the typed one.
    await openRendered(page);
    await seedFromSource(page, "a *b*c");
    await expect.poll(() => markdown(page)).toBe("a *b*c\n");
    await page.keyboard.press("ArrowUp");
    await press(page, "ArrowRight", "a b".length);
    await page.keyboard.press("Space");
    expect(await emText(page)).toBe("b ");
    await expectClean(page, "a *b* c\n");
  });

  test("the absence case: a space typed after the closing delimiter, outside the mark, is unchanged", async ({
    page,
  }) => {
    await openRendered(page);
    await seedFromSource(page, "a *b* c");
    await expect.poll(() => markdown(page)).toBe("a *b* c\n");

    // To the block's end (one line, so `ArrowDown` is Blink's line-end motion), then one
    // character left: the caret is before `c`, after the space that follows the mark — a
    // position whose marks are none.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Space");

    // The mark's text is untouched; the space is the unmarked run's, as it was typed.
    expect(await emText(page)).toBe("b");
    await expectClean(page, "a *b*  c\n");
  });

  test("the input rule: `*word*` typed from nothing, then a space, reads `*word*` whichever tree the rule leaves the caret in", async ({
    page,
  }) => {
    await openRendered(page);
    await page.keyboard.type("*word*", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("*word*\n");
    expect(await emText(page)).toBe("word");

    // The rule removes the stored mark, so the space is meant to be typed outside the emphasis;
    // the DOM caret may still sit inside the `<em>`. Either way the block's end takes the space,
    // and the `<em>` holds exactly `word` or exactly `word` plus that one space — the two trees
    // the title admits, named here rather than hidden behind a normalising matcher.
    await page.keyboard.press("Space");
    expect(await emText(page)).toMatch(/^word ?$/);
    await expectClean(page, "*word*\n");

    // …and a letter after it shows which side of the mark the space is on: outside.
    await page.keyboard.type("x", { delay: 10 });
    expect(await emText(page)).toBe("word");
    await expectClean(page, "*word* x\n");
  });
});
