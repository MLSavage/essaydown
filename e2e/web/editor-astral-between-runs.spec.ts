import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.49's browser half (DECISIONS #review-1-r6 L1 — Sol finding 1, Grok finding 1; Sol's
 * route, `/logs/reviews/1/r6/sol/between-browser.mjs`).
 *
 * 1.45 widened the lone-surrogate reference `mdast-util-to-markdown`'s `container-phrasing.js`
 * writes for an astral neighbour of one attention run — but only in the two forms one rewrite
 * alone produces (a reference beside a *raw* mate). One astral character that is the closing
 * neighbour of one run and the opening neighbour of the next receives both rewrites on its one
 * two-unit child, `encodeAfter` on the high unit and `encodingInfo.before` on the low one, and
 * came out as `&#xD83D;&#xDE00;` — two references that reparse to U+FFFD U+FFFD while the
 * rendered text still showed the emoji and Copy Markdown reported success. format.ts's
 * `SPLIT_PAIR` now names that third form and widens it to the code-point reference
 * (`&#x1F600;`), the bytes `strikethrough-flanking.test.ts`'s `(emphasis, emphasis, 😀 U+1F600)`
 * guard asserts.
 *
 * The route is loaded, then edited with ordinary caret motion: `*a.* 😀 *(b)*` through the
 * fixture-file input, the two spaces around the emoji taken by one Backspace and one Delete so
 * the emoji sits flush between the two runs. Caret placement is by the click, `ArrowUp` (a
 * one-line block's start on every OS) and counted `ArrowRight`, with the DOM-selection anchor
 * asserted before every count and after every edit (DECISIONS #022, #024); never a Home or End
 * key, never a downward arrow, never a modifier chord (`tests/no-caret-chords-in-e2e.test.ts`
 * guards this file too). A surrogate pair is one caret step in Blink and two units in the anchor's
 * offset — the offset is asserted, not assumed.
 *
 * The copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021); the bytes are
 * asserted with `toBe`, never a normalising matcher (DECISIONS #022); the fixed point is computed
 * twice, in this process from `packages/core` and in the page from the same module served by Vite
 * (Sol's instrument); and the parsed text values joined are compared to the paragraph's own text
 * — the one instrument that sees U+FFFD. Helpers are copied from
 * `editor-astral-neighbour.spec.ts` and `editor-toggle-encoded-neighbour.spec.ts`.
 */

/** The arguments of the `writeText` calls the app made, newest last, recorded on the window. */
type WriteTextSpy = { calls: string[] };

/** `packages/core/src/index.ts` on disk, for the page-side import through Vite's `/@fs/` route. */
const CORE_INDEX = fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url));

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

async function press(page: Page, key: string, times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) await page.keyboard.press(key);
}

/**
 * The rendered caret as the DOM selection reports it: the anchor text node's text, byte for byte,
 * and the caret's offset in it (UTF-16 units, so a surrogate pair counts two).
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

/**
 * The paragraph's `textContent` with task 1.4's reveal decorations (`.essaydown-delimiter`, the
 * `*` widgets drawn on the active line) taken out of a clone first: they are decorations, not
 * document text (lesson [1.45]), and the caret is on this paragraph throughout.
 */
function documentText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const paragraph = document.querySelector(".ProseMirror p");
    if (paragraph === null) return null;
    const clone = paragraph.cloneNode(true) as Element;
    for (const widget of clone.querySelectorAll(".essaydown-delimiter")) widget.remove();
    return clone.textContent;
  });
}

/** Every `value`-bearing node's text in `bytes`'s own parse, joined in document order. */
function textValuesOf(bytes: string): string {
  const out: string[] = [];
  const walk = (node: { value?: string; children?: unknown[] }): void => {
    if (typeof node.value === "string") out.push(node.value);
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(parse(bytes));
  return out.join("");
}

/** `format(parse(bytes))` computed inside the page, from the core module Vite serves. */
function formatParseInPage(page: Page, bytes: string): Promise<string> {
  return page.evaluate(
    async ({ modulePath, source }) => {
      const core = (await import(/* @vite-ignore */ `/@fs${modulePath}`)) as {
        parse: (value: string) => unknown;
        format: (root: unknown) => string;
      };
      return core.format(core.parse(source));
    },
    { modulePath: CORE_INDEX, source: bytes },
  );
}

test.describe("an astral character left flush between two emphasis runs reaches the Markdown whole", () => {
  test("Sol's reproduction: `*a.* 😀 *(b)*` loaded, the two spaces around the emoji taken by Backspace and Delete — the emoji is one code-point reference, the pane and the copy are the guard's bytes, a fixed point, and the parsed text equals the paragraph's", async ({
    page,
  }) => {
    const seed = "*a.* 😀 *(b)*\n";
    await openRendered(page);
    await load(page, "astral-between-runs.md", seed);
    await expect.poll(() => markdown(page)).toBe(seed);
    await expect(page.locator(".ProseMirror em")).toHaveCount(2);

    // The caret placed by the click, then `ArrowUp` to the one-line paragraph's start, then three
    // `ArrowRight` — `a`, `.`, and the run's end into the text node after it. The anchor is what
    // the DOM reports (Sol's log: `{ text: " 😀 ", offset: 1 }`), asserted, not assumed.
    const paragraph = page.locator(".ProseMirror p").first();
    await paragraph.click();
    await page.keyboard.press("ArrowUp");
    await press(page, "ArrowRight", 3);
    await expect.poll(() => caret(page)).toEqual({ text: " 😀 ", offset: 1 });

    // The space before the emoji taken: the emoji is now the closing neighbour of `*a.*`.
    await page.keyboard.press("Backspace");
    await expect.poll(() => markdown(page)).toBe("*a.*&#x1F600; *(b)*\n");
    await expect.poll(() => caret(page)).toEqual({ text: "😀 ", offset: 0 });

    // One `ArrowRight` steps over the whole emoji — one caret step in Blink, two UTF-16 units in
    // the anchor's offset.
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => caret(page)).toEqual({ text: "😀 ", offset: 2 });

    // The space after the emoji taken: the emoji is now also the opening neighbour of `*(b)*`.
    // Before 1.49 the pane read `*a.*&#xD83D;&#xDE00;*(b)*` here (Sol's log), while the rendered
    // paragraph still showed the emoji.
    await page.keyboard.press("Delete");
    const bytes = "*a.*&#x1F600;*(b)*\n";
    await expect.poll(() => markdown(page)).toBe(bytes);
    const pane = (await markdown(page)) as string;
    expect(pane).not.toContain("&#xD");
    expect(format(parse(pane))).toBe(pane);
    expect(await formatParseInPage(page, pane)).toBe(pane);

    await expect(page.locator(".ProseMirror em")).toHaveCount(2);
    const paragraphText = await documentText(page);
    expect(paragraphText).toBe("a.😀(b)");
    expect(textValuesOf(pane)).toBe(paragraphText);

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(format(parse(copied))).toBe(copied);
    expect(textValuesOf(copied)).toBe(paragraphText);
  });
});
