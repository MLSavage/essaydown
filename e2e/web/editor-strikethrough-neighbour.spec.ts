import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.41's browser half (DECISIONS #review-1-r4 J1, both r4 reviewers' reproductions).
 *
 * 1.40 added the serializer's `delete` handler (the flanking property's other side: a strikethrough
 * run's neighbour is encoded exactly when the outside character is a letter or digit and the inside
 * edge is punctuation), and `packages/editor/test/typing-legs.ts`'s **mark's neighbour** legs (task
 * 1.41's headless half) proved it over the whole corpus. This file is the same tree, built the way
 * both reviewers built it by hand: a strikethrough run typed or loaded, the caret moved to just
 * after the unmarked whitespace that follows it, one Backspace.
 *
 * (a) Claude's reproduction: `Alpha ~~beta.~~ gamma delta` — a Backspace over the space after
 * `~~beta.~~` leaves `g` (a letter) directly against the run's closing `~~`, so the serializer
 * writes it as `&#x67;` (`strikethrough-flanking.test.ts`'s own doc comment names this exact
 * deletion; its guard `(closing, letter outside, punctuation inside)` asserts the same bytes).
 * (b) Sol's reproduction: `~~a [b ](u)~~ c` — the same Backspace against a link-holding run leaves
 * `c` encoded the same way (`(closing, letter outside, link inside)`).
 *
 * Both bytes are read from 1.40's own guards, asserted here with `toBe`, and are a `parse`∘`format`
 * fixed point holding exactly one `delete` node — the tree 1.40's handler exists for, this time
 * built by the editor rather than by `parse` on a literal string.
 *
 * A copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
 *
 * Caret placement (DECISIONS #022): a click at a computed point — the paragraph's own bounding box,
 * past its last character, which every browser resolves to the line's end — and then counted
 * `ArrowLeft` from an anchor asserted on its own. Never a Home or End key, never a modifier chord:
 * `tests/no-caret-chords-in-e2e.test.ts` guards it for every file in this directory, this one
 * included.
 */

/** The arguments of the `writeText` calls the app made, newest last, recorded on the window. */
type WriteTextSpy = { calls: string[] };

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

/** Open `/dev/editor` on an empty store, with `writeText` spied before any page script runs. */
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

/** Commit `source` through the dev bar's "Load fixture…" input, as a human would (task 1.14's route). */
async function load(page: Page, name: string, source: string): Promise<void> {
  await page
    .getByTestId("fixture-file")
    .setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(source, "utf8") });
  await expect(page.getByTestId("status")).toHaveText(`Loaded ${name}`);
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
 * A click on the paragraph's own bounding box, past its last character on its one line — a point
 * every browser resolves to the line's end, never a Home/End key or a chord (DECISIONS #022).
 */
async function clickParagraphEnd(page: Page): Promise<void> {
  const paragraph = page.locator(".ProseMirror p").first();
  const box = await paragraph.boundingBox();
  if (box === null) throw new Error("no paragraph on the page");
  await paragraph.click({ position: { x: box.width - 1, y: box.height / 2 } });
}

/**
 * The rendered caret as the DOM selection reports it: the anchor text node's text, byte for byte,
 * and the caret's offset in it (the shape `editor-trailing-break.spec.ts` and
 * `editor-soft-line-breaks.spec.ts` use), narrowed to the two fields this file asserts.
 */
function caret(page: Page): Promise<{ text: string | null; offset: number }> {
  return page.evaluate(() => {
    const selection = document.getSelection();
    if (selection === null || selection.anchorNode === null) return { text: null, offset: -1 };
    if (!selection.isCollapsed) return { text: null, offset: -1 };
    const node = selection.anchorNode;
    if (node.nodeType !== Node.TEXT_NODE) return { text: null, offset: selection.anchorOffset };
    return { text: node.textContent, offset: selection.anchorOffset };
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

/** The `delete` nodes in `bytes`'s own parse, wherever they are. */
function deletesIn(bytes: string): number {
  const walk = (node: { type: string; children?: unknown[] }): number =>
    (node.type === "delete" ? 1 : 0) +
    ((node.children ?? []) as (typeof node)[]).reduce((sum, child) => sum + walk(child), 0);
  return walk(parse(bytes));
}

/**
 * The assertions both cases make once the Backspace has run: the pane's bytes, that they parse to
 * exactly one `delete` node and are a fixed point, and the copy's bytes — byte-exact throughout,
 * never a normalising matcher (DECISIONS #022). `renderedDels` is the real DOM's own `<del>` count,
 * which is not always the node count: a mark wraps each of the run's inline children separately
 * (case b's link splits the run's one `delete` node into two `<del>` elements either side of the
 * `<a>`), so it is asserted at the caller, against what the seed's own markup shows before the
 * Backspace too — a count read from the DOM, never assumed.
 */
async function expectOneDeleteAndTheBytes(page: Page, bytes: string): Promise<void> {
  await expect.poll(() => markdown(page)).toBe(bytes);
  const pane = (await markdown(page)) as string;
  expect(format(parse(pane))).toBe(pane);
  expect(deletesIn(pane)).toBe(1);
  expect(await clickCopyMarkdown(page)).toBe(bytes);
}

test.describe("a Backspace over the whitespace beside a strikethrough run reaches the Markdown clean", () => {
  test("Claude's reproduction: `Alpha ~~beta.~~ gamma delta`, the caret after the space, one Backspace — the neighbour letter is encoded, the pane and the copy are 1.40's own bytes", async ({
    page,
  }) => {
    const seed = "Alpha ~~beta.~~ gamma delta\n";
    await openRendered(page);
    await load(page, "strikethrough-neighbour-a.md", seed);
    await expect.poll(() => markdown(page)).toBe(seed);
    expect(await page.locator(".ProseMirror del").count()).toBe(1);

    await clickParagraphEnd(page);
    await expect.poll(() => caret(page)).toEqual({ text: " gamma delta", offset: 12 });

    await press(page, "ArrowLeft", 11);
    await expect.poll(() => caret(page)).toEqual({ text: " gamma delta", offset: 1 });

    // Before 1.40 this reached the serializer's `opaqueHandlers()` fallback, which wrote the run's
    // `~` markers unescaped against the letter that used to sit behind a space — a byte sequence
    // `parse` does not read back as a `delete` (DECISIONS #review-1-r4 J1).
    await page.keyboard.press("Backspace");
    await expectOneDeleteAndTheBytes(page, "Alpha ~~beta.~~&#x67;amma delta\n");
    expect(await page.locator(".ProseMirror del").count()).toBe(1);
  });

  test("Sol's reproduction: `~~a [b ](u)~~ c`, the caret after the space, one Backspace — the neighbour letter beside a link-holding run is encoded the same way", async ({
    page,
  }) => {
    const seed = "~~a [b ](u)~~ c\n";
    await openRendered(page);
    await load(page, "strikethrough-neighbour-b.md", seed);
    await expect.poll(() => markdown(page)).toBe(seed);
    // The run's one `delete` node wraps a text child and a link child, each marked separately, so
    // the DOM shows two `<del>` elements either side of the `<a>` (confirmed against the rendered
    // markup, not assumed) — unchanged by the Backspace, which touches only the whitespace outside
    // the run.
    expect(await page.locator(".ProseMirror del").count()).toBe(2);

    await clickParagraphEnd(page);
    await expect.poll(() => caret(page)).toEqual({ text: " c", offset: 2 });

    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => caret(page)).toEqual({ text: " c", offset: 1 });

    await page.keyboard.press("Backspace");
    await expectOneDeleteAndTheBytes(page, "~~a [b ](u)~~&#x63;\n");
    expect(await page.locator(".ProseMirror del").count()).toBe(2);
  });
});
