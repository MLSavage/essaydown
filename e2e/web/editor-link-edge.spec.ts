import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.35's browser half (DECISIONS #review-1-r3 I3 and I4, Claude's reproductions at f90ed50).
 *
 * A link whose text has edge whitespace is a tree `parse` produces from valid Markdown
 * (`[b ](u)` is a link; the brackets, not the whitespace, are what a delimiter beside it
 * flanks), and the editor's strip treated that whitespace as its own to move or drop wherever the
 * link's edge coincided with a boundary the strip owns. At a flanking mark's edge (I3, since
 * 1.30) the space left the mark and kept the link, and the serializer wrote a second,
 * whitespace-only link: `*a [b ](u)* c` came back as `*a [b](u)*[ ](u) c` after any keystroke.
 * At a block's edge (I4, since 1.13) the space was dropped: `see [the essay ](u)` came back as
 * `see [the essay](u)`, a silent rewrite of the user's link text. Both were fixed points, so the
 * fixed-point legs alone never caught them. `packages/editor/test/editor-fixed-point.test.ts`
 * holds the guards and the corpus leg (a space typed inside every link); this is the same tree
 * built the way the finding built it: the file loaded, one letter typed.
 *
 * The rule the pane has to show (`stripUnparsableWhitespace`'s link predicate and the two trims'
 * link stop, schema.ts): a link's edge whitespace is the link's, so the bytes are the seed's own
 * plus the letter, with exactly one link.
 *
 * Caret placement, DECISIONS #022: never a Home or End key and never a modifier chord for caret
 * motion in the rendered view — Cocoa resolves those as scrolls, not document motions. Only
 * motions Blink decides are used here (`ArrowDown` to the block's end, `ArrowUp` to its start),
 * and the caret's text offset is asserted before the letter, so a wrong placement fails there and
 * not only in the bytes.
 *
 * The copy assertion reads the string the app handed `navigator.clipboard.writeText`, recorded
 * by an init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
 */

/** The arguments of the `writeText` calls the app made, newest last, recorded on the window. */
type WriteTextSpy = { calls: string[] };

/** The numeric character reference family, as a pattern (see the fixed-point suite's `ENTITY`). */
const ENTITY = /&#x?[0-9a-fA-F]+;/;

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

/** Type `text` into the source view, then swap back to the rendered one (the app's own toggle keymap). */
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

/**
 * The text of the caret's block before the caret, read from the DOM selection the way
 * `editor-break-in-mark.spec.ts` reads it: walked over the block's text nodes, so that a caret
 * the browser anchors at the start of one text node or the end of the previous one — the same
 * position — reads the same, and a revealed delimiter (task 1.4's widget, a decoration and not
 * document text) contributes nothing.
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

/** The `link` nodes in the pane's own parse, wherever they are. */
function linksIn(bytes: string): number {
  const walk = (node: { type: string; children?: unknown[] }): number =>
    (node.type === "link" ? 1 : 0) +
    ((node.children ?? []) as (typeof node)[]).reduce((sum, child) => sum + walk(child), 0);
  return walk(parse(bytes));
}

/** The four assertions both cases make on the pane after the letter, and on the copy's bytes. */
async function expectOneLinkAndTheBytes(page: Page, bytes: string): Promise<void> {
  await expect.poll(() => markdown(page)).toBe(bytes);
  const pane = (await markdown(page)) as string;
  expect(pane).not.toMatch(ENTITY);
  expect(format(parse(pane))).toBe(pane);
  expect(linksIn(pane)).toBe(1);
  expect(await clickCopyMarkdown(page)).toBe(bytes);
}

test.describe("a link's edge whitespace is the link's, at a mark's edge and at a block's", () => {
  test("I3 (Claude's reproduction): `*a [b ](u)* c` loaded, one letter typed at the block's end — the pane holds the seed's bytes plus the letter, exactly one link, no entity, and the copy is the same bytes", async ({
    page,
  }) => {
    const seed = "*a [b ](u)* c";
    await openRendered(page);
    await seedFromSource(page, seed);
    await expect.poll(() => markdown(page)).toBe(`${seed}\n`);

    // The caret at the block's end by Blink's line motion (twice, so the count does not depend
    // on which line the toggle left the caret on); the precondition asserted on its own.
    await page.locator(".ProseMirror").click();
    await press(page, "ArrowDown", 2);
    expect(await textBeforeCaret(page)).toBe("a b  c");

    // Before this task the pane read `*a [b](u)*[ ](u) cd`: the link's space moved out of the
    // emphasis and kept its link, a second link invented around one space.
    await page.keyboard.type("d");
    await expectOneLinkAndTheBytes(page, "*a [b ](u)* cd\n");
  });

  test("I4 (Claude's reproduction): `see [the essay ](u)` loaded, one letter typed at the block's start — the link's trailing space at the block's end survives, exactly one link, and the copy is the same bytes", async ({
    page,
  }) => {
    const seed = "see [the essay ](u)";
    await openRendered(page);
    await seedFromSource(page, seed);
    await expect.poll(() => markdown(page)).toBe(`${seed}\n`);

    // The caret at the block's start by Blink's line motion (a one-line block, so `ArrowUp`
    // reaches its start on every OS); the precondition asserted on its own.
    await page.locator(".ProseMirror").click();
    await press(page, "ArrowUp", 2);
    expect(await textBeforeCaret(page)).toBe("");

    // Before this task the pane read `Xsee [the essay](u)`: the block's end took the link's
    // space, a silent rewrite of the link text.
    await page.keyboard.type("X");
    await expectOneLinkAndTheBytes(page, "Xsee [the essay ](u)\n");
  });
});
