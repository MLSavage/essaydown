import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.34's browser half (DECISIONS #review-1-r3 I1, Claude's reproduction at f90ed50).
 *
 * A `hard_break` left as the last node of an emphasis, strong or strikethrough run **with unmarked
 * text after it** — one Backspace inside an emphasised verse loaded from a file, since every
 * loaded file supplies the break — reached `format`, which wrote the break's line ending as a
 * numeric character reference inside the delimiters and escaped the character after them: the
 * pane read `*roses are red\`, the entity, `*`, the escaped dash, and "Copy Markdown" put exactly
 * that on the clipboard — bytes whose parse holds no break at all, and a fixed point, so the
 * fixed-point legs alone never caught it. `packages/editor/test/editor-fixed-point.test.ts` holds
 * the guards and the corpus leg (the deletion to every marked run's end); this is the same tree
 * built the way the finding built it, by deleting in the browser.
 *
 * The rule the pane has to show (`stripUnparsableWhitespace`'s mark-edge clause, schema.ts): the
 * break leaves the mark, so the delimiters close before it and the continuation follows it
 * unmarked — `*roses are red*\` + newline + `— anon`, with the leading space of the continuation
 * dropped as after any hard break.
 *
 * Caret placement, DECISIONS #022: never a Home or End key and never a modifier chord for caret
 * motion in the rendered view — Cocoa resolves those as scrolls, not document motions, so a case
 * that used them was green on Linux and Windows and red on macOS. Only motions Blink decides are
 * used here (`ArrowDown` to the block's end, counted `ArrowLeft`s), and the caret's text offset
 * is asserted before the deletion, so a wrong placement fails there and not only in the bytes.
 *
 * The copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
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

/**
 * The rendered caret as the DOM selection reports it: the anchor text node's text, byte for byte,
 * and the caret's offset in it (the shape `editor-astral-between-runs.spec.ts` uses).
 */
function caret(page: Page): Promise<{ text: string | null; offset: number }> {
  return page.evaluate(() => {
    const selection = document.getSelection();
    if (selection === null || selection.anchorNode === null) return { text: null, offset: -1 };
    if (!selection.isCollapsed) return { text: null, offset: -1 };
    const anchor = selection.anchorNode;
    const anchorOffset = selection.anchorOffset;
    if (anchor.nodeType === Node.TEXT_NODE) return { text: anchor.textContent, offset: anchorOffset };
    // Blink anchors the selection on an ancestor element, at the child index, when the caret
    // sits right after text abutting a contenteditable="false" widget (a revealed delimiter) —
    // the same position `textBeforeCaret` below already treats as equivalent to the end of the
    // preceding text node, by walking the block's text nodes; without this a repeated Backspace
    // that keeps the caret in that spot reads the same child count every time and `press`'s
    // differ poll never sees it change.
    const element = (anchor as Element).closest?.(".ProseMirror > *") ?? anchor.parentElement?.closest(".ProseMirror > *");
    const block = element ?? null;
    if (block === null) return { text: null, offset: anchorOffset };
    const range = document.createRange();
    range.setStart(anchor, anchorOffset);
    range.collapse(true);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    let node = walker.nextNode();
    while (node !== null) {
      if (range.comparePoint(node, node.textContent?.length ?? 0) > 0) break;
      // A revealed delimiter's own text ("*", "**", ...) is a decoration, not document text —
      // `textBeforeCaret` above excludes it the same way.
      if (node.parentElement?.closest(".essaydown-delimiter") === null) last = node as Text;
      node = walker.nextNode();
    }
    if (last === null) return { text: null, offset: anchorOffset };
    return { text: last.textContent, offset: last.textContent?.length ?? 0 };
  });
}

/**
 * Fires `key` `times` times for a counted horizontal motion, waiting after each press for the DOM
 * caret to differ from its reading taken before that press — the fix for the blind, unsynchronised
 * press the 1.verify.r6h gate's a1 run caught one short (editor-soft-line-breaks.spec.ts:111,
 * DECISIONS #review-1-r6 L7, #034). A count crossing a node boundary (the anchor text changes, the
 * offset resets) is covered by "differs": the reading taken after a press never equals the one
 * taken before it. This form is for `ArrowLeft`/`ArrowRight`/`Backspace`, which always move the
 * caret on a genuine press; a vertical motion pressed past the edge it reaches never differs and
 * uses `pressToEdge` below instead.
 */
async function press(page: Page, key: string, times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) {
    const previous = JSON.stringify(await caret(page));
    await page.keyboard.press(key);
    await expect.poll(async () => JSON.stringify(await caret(page)) !== previous).toBe(true);
  }
}

/**
 * Fires `key` `times` times, waiting after each press for the DOM caret to settle (two consecutive
 * reads agreeing) before firing the next one — the form for a vertical motion pressed more than
 * once to reach a one-line block's edge regardless of which line the caret started on, where a
 * later press genuinely leaves the caret in place and `press`'s differ-after-each form would time
 * out waiting for a change that is never coming. The spec's own anchor assertion after the call is
 * what checks the edge was actually reached (DECISIONS #review-1-r6 L7, #034).
 */
async function pressToEdge(page: Page, key: string, times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) {
    await page.keyboard.press(key);
    let previous: string | undefined;
    await expect.poll(async () => {
      const current = JSON.stringify(await caret(page));
      const settled = previous === current;
      previous = current;
      return settled;
    }).toBe(true);
  }
}

/**
 * The text of the caret's block before the caret, read from the DOM selection the way
 * `editor-table-empty-cell.spec.ts` reads CodeMirror's: walked over the block's text nodes, so
 * that a caret the browser anchors at the start of one text node or the end of the previous one
 * — the same position — reads the same. A `<br>` contributes nothing, as in `textContent`, and
 * neither does a revealed delimiter (task 1.4's widget, a decoration and not document text).
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

test.describe("a hard break left last in a marked run by a deletion never reaches the Markdown as an entity", () => {
  test("I1 (Claude's reproduction): the second line of an emphasised verse deleted back to its break — the pane closes the mark before the break, keeps the break, carries no entity, and the copy is the same bytes", async ({
    page,
  }) => {
    const seed = "*roses are red\\\nviolets are blue* — anon";
    const line = "violets are blue";
    const after = " — anon";
    await openRendered(page);
    await seedFromSource(page, seed);
    await expect.poll(() => markdown(page)).toBe(`${seed}\n`);

    // The caret after `blue`: to the block's end by Blink's line motion (twice, so the count does
    // not depend on which line the toggle left the caret on), then back over the unmarked tail.
    await page.locator(".ProseMirror").click();
    await pressToEdge(page, "ArrowDown", 2);
    await press(page, "ArrowLeft", after.length);
    // The precondition, asserted on its own: the caret sits at the end of the verse's second
    // line (the block's text so far, the `<br>` contributing nothing), so the deletion below
    // ends at the break and nowhere else.
    expect(await textBeforeCaret(page)).toBe(`roses are red${line}`);

    // One Backspace per character of the second line: the last one leaves the break as the
    // emphasis run's last node, with ` — anon` after it. Before this task the pane read the
    // opening delimiter, `roses are red`, a backslash, the entity for the line feed, the closing
    // delimiter and an escaped dash — a fixed point whose parse held no break.
    await press(page, "Backspace", line.length);
    const bytes = "*roses are red*\\\n— anon\n";
    await expect.poll(() => markdown(page)).toBe(bytes);
    const pane = (await markdown(page)) as string;
    expect(pane).not.toMatch(ENTITY);
    expect(format(parse(pane))).toBe(pane);
    // The break survived the trip: the pane's own parse still holds it, and inside no mark.
    const paragraph = parse(pane).children[0] as { children: { type: string }[] };
    expect(paragraph.children.map((child) => child.type)).toEqual(["emphasis", "break", "text"]);

    const written = await clickCopyMarkdown(page);
    expect(written).toBe(bytes);
  });
});
