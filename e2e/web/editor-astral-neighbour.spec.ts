import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.45's browser half (DECISIONS #review-1-r5 K1, Claude's typed route).
 *
 * 1.40 and 1.41 closed the flanking family for the BMP: the serializer encodes the neighbour a
 * mark cannot form against, and the corpus legs proved it — over ASCII. The member that ended r5
 * is astral: `mdast-util-to-markdown`'s `container-phrasing.js` encodes the neighbour one UTF-16
 * unit wide, so an emoji directly after `*wow!*` came out as `&#xD83D;` + a raw low surrogate, a
 * reference that reparses to U+FFFD — Copy Markdown reported "Copied Markdown" with the character
 * destroyed. format.ts's `root` handler now wraps `containerPhrasing` and widens the split pair to
 * the code-point reference (`&#x1F600;`), the bytes `strikethrough-flanking.test.ts`'s
 * `(emphasis, closing, punctuation inside, astral symbol outside)` guard asserts.
 *
 * The route is typed, not loaded, so the tree is the editor's own: `Alpha *wow!*` (the emphasis
 * input rule closes the mark at the second `*`; one `<em>` holding `wow!` is asserted first), then
 * `😀 delta` typed after it. No deletion, no arrow, no Home/End key, no chord — the caret is placed
 * by the click and by typing alone (`tests/no-caret-chords-in-e2e.test.ts` guards this file too).
 *
 * The copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021); the bytes are
 * asserted with `toBe`, never a normalising matcher (DECISIONS #022), and the parsed text values
 * joined are compared to the paragraph's own `textContent` — the one instrument that sees U+FFFD.
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
 * document text — `*` is in the document at no point after the input rule fires — and the
 * comparison is with what the reader sees of the document, U+FFFD included.
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

test.describe("an astral character typed directly after a closed emphasis reaches the Markdown whole", () => {
  test("Claude's reproduction: `Alpha *wow!*` then `😀 delta` — the emoji is encoded as one code-point reference, the pane and the copy are the guard's bytes, and the parsed text equals the paragraph's", async ({
    page,
  }) => {
    await openRendered(page);

    await page.keyboard.type("Alpha *wow!*", { delay: 10 });
    const em = page.locator(".ProseMirror em");
    await expect(em).toHaveCount(1);
    expect(await em.textContent()).toBe("wow!");

    await page.keyboard.type("😀 delta", { delay: 10 });

    // Before 1.45 the pane held `Alpha *wow!*&#xD83D;` + U+DE00 + ` delta`: the emphasis input rule
    // had closed the mark against `!`, the serializer decided to encode the emoji beside it, and
    // encoded its first UTF-16 unit alone (DECISIONS #review-1-r5 K1).
    const bytes = "Alpha *wow!*&#x1F600; delta\n";
    await expect.poll(() => markdown(page)).toBe(bytes);
    const pane = (await markdown(page)) as string;
    expect(pane).not.toContain("&#xD");
    expect(format(parse(pane))).toBe(pane);

    const paragraphText = await documentText(page);
    expect(paragraphText).toBe("Alpha wow!😀 delta");
    expect(textValuesOf(pane)).toBe(paragraphText);

    expect(await clickCopyMarkdown(page)).toBe(bytes);
  });
});
