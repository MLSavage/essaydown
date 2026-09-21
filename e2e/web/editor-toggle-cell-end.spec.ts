import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.52's browser half (DECISIONS #review-1-r6 L5 — Claude finding 4; #030 Decision 2 and
 * #031 for the trailing-leaf member).
 *
 * The cursor map (`packages/editor/src/toggle.ts`) answered the position at the end of a table
 * cell's text with the *row's* first position: `toSource` of a cell's end is the column before
 * the cell's padding, `nodeAt` there answers the row (the text's range excludes that column, the
 * row's does not), and `delimiterPosition` returned the row's `pmStart` for anything that is not
 * a mark. Claude's route: the caret at the end of `zq`, toggle, toggle back — the caret was at
 * the start of `ab`, and a keystroke landed in a different cell (`| Xab | zq |`). The same
 * branch put the caret after a trailing inline-code run at the run's start, so a space typed in
 * the source view after `see `foo`` landed before the span. Both routes are driven here from a
 * real browser: the caret placed and asserted, the toggle chord, the keystroke, the toggle back,
 * Copy Markdown — the bytes are asserted whole with `toBe`, and each is a parse∘format fixed
 * point.
 *
 * A copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
 *
 * Caret placement (DECISIONS #022, #024): a click on the cell at a computed point on its own box
 * (its left edge, so the anchor is asserted at offset 0 before any key; a vertical arrow inside a
 * table's body row is no line-start motion — Blink moves the caret out of the cell), then counted
 * `ArrowRight` with the anchor asserted after the run — never a Home or End key, never a vertical
 * arrow, never a modifier chord for the caret: `ControlOrMeta+/` is the app's toggle chord, not a
 * caret motion. The chord follows
 * the last arrow only after ProseMirror's observer has had a tick to read the DOM selection
 * (lesson [1.46]; the precedent in `editor-toggle.spec.ts`). Helpers are copied from
 * `editor-toggle-encoded-neighbour.spec.ts`; `documentText` from `editor-astral-neighbour.spec.ts`.
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

async function press(page: Page, key: string, times: number): Promise<void> {
  for (let step = 0; step < times; step += 1) await page.keyboard.press(key);
}

/**
 * The rendered caret as the DOM selection reports it: the anchor text node's text, byte for byte,
 * and the caret's offset in it.
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
 * delimiter widgets drawn on the active line) taken out of a clone first: they are decorations,
 * not document text (lesson [1.45]), and the caret is on this paragraph after the toggle back.
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

/**
 * A click on the cell's own bounding box at its left edge, on its one line — a computed point
 * every browser resolves to the cell's start, never a Home/End key or a chord (DECISIONS #022).
 */
async function clickCellStart(page: Page, text: string): Promise<void> {
  const cell = page.locator(".ProseMirror td, .ProseMirror th", { hasText: text }).first();
  const box = await cell.boundingBox();
  if (box === null) throw new Error(`no cell holding ${text} on the page`);
  await cell.click({ position: { x: 1, y: box.height / 2 } });
}

test.describe("a toggle to source and back with the caret at the end of a table cell", () => {
  test("Claude's route: `| ab | zq |`, the caret at the end of `zq`, Cmd/Ctrl+/ twice, then `X` — the keystroke lands in that cell, at its end", async ({
    page,
  }) => {
    const seed = "| h1 | h2 |\n| -- | -- |\n| ab | zq |\n";
    await openRendered(page);
    await load(page, "toggle-cell-end.md", seed);
    await expect.poll(() => markdown(page)).toBe(seed);
    // Four cells, header row included (the editor renders every cell as a `td`).
    expect(await page.locator(".ProseMirror td").count()).toBe(4);

    // The caret placed by a click on the `zq` cell and asserted as an anchor before any key:
    // the cell's start (a vertical arrow is no line-start motion inside a table's body row —
    // Blink moves the caret out of the cell, to `ab`'s end, attempt 1 saw), then two to the
    // right, to the end of `zq`.
    await clickCellStart(page, "zq");
    await expect.poll(() => caret(page)).toEqual({ text: "zq", offset: 0 });
    await press(page, "ArrowRight", 2);
    await expect.poll(() => caret(page)).toEqual({ text: "zq", offset: 2 });
    // The arrows moved the DOM selection natively; give ProseMirror's observer a tick to read
    // it before the chord's `toSource` runs (lesson [1.46]).
    await page.waitForTimeout(200);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    // The anchor unchanged by the round trip: before 1.52 it was `{ text: "ab", offset: 0 }`.
    await expect.poll(() => caret(page)).toEqual({ text: "zq", offset: 2 });

    await page.keyboard.type("X", { delay: 10 });
    // The serializer pads every column to its widest cell, so the whole string is the canonical
    // form of the three rows with `zqX` in the body's second cell — and never `| Xab | zq |`.
    const bytes = "| h1 | h2  |\n| -- | --- |\n| ab | zqX |\n";
    expect(bytes).toBe(format(parse("| h1 | h2 |\n| -- | -- |\n| ab | zqX |\n")));
    await expect.poll(() => markdown(page)).toBe(bytes);

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(copied).toContain("| ab | zqX |");
    expect(format(parse(copied))).toBe(copied);
  });

  test("Claude's inline-code route: `see `foo`` typed, Cmd/Ctrl+/, ` bar` typed in the source view, toggle back — the space lands after the span", async ({
    page,
  }) => {
    await openRendered(page);
    // Typed, not loaded: the caret is where the input rule left it, at the end of the block
    // after the code span, with nothing clicked afterwards.
    await page.keyboard.type("see `foo`", { delay: 10 });
    await expect.poll(() => page.locator(".ProseMirror code").count()).toBe(1);
    expect(await page.locator(".ProseMirror code").textContent()).toBe("foo");
    await expect.poll(() => markdown(page)).toBe("see `foo`\n");

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    // Before 1.52 the source caret was at the span's start (no spelling table; then, after
    // 1.51's table, before its closing fence) and the space went inside it.
    await page.keyboard.type(" bar", { delay: 10 });
    const bytes = "see `foo` bar\n";
    await expect.poll(() => markdown(page)).toBe(bytes);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    await expect.poll(() => markdown(page)).toBe(bytes);
    expect(await page.locator(".ProseMirror code").count()).toBe(1);
    expect(await page.locator(".ProseMirror code").textContent()).toBe("foo");
    expect(await documentText(page)).toBe("see foo bar");

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(format(parse(copied))).toBe(copied);
  });
});
