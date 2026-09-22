import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.60's browser half (DECISIONS #review-1-r7 M5 — Claude finding 4).
 *
 * `inline_code` sets no `inclusive` (`packages/editor/src/schema.ts`), so ProseMirror's default
 * holds and `doc.resolve(end).marks()` at the end of a *block-final* code span is
 * `[inline_code]`: a character typed there joins the span in the rendered view. The cursor map's
 * `isLeafEnd` answered that position after the closing fence all the same, so the source view
 * typed outside the span and the two views disagreed about one caret — ``see `fooX` `` against
 * ``see `foo`X ``. The route here is the one the map now owns: a caret the *user* placed, with
 * no stored marks, which is what a click leaves.
 *
 * The 1.52 (b) case in `editor-toggle-cell-end.spec.ts` drives the other route and is unchanged:
 * there the span is *typed*, and the input rule's `removeStoredMark`
 * (`packages/editor/src/input.ts`) cleared the mark one keystroke earlier, so the editor's
 * `storedMarks` are `[]`, a typed character is plain text, and the caret belongs after the fence.
 * `DevEditor`'s toggle passes `state.storedMarks` to `toSource`, which is what keeps the two
 * routes apart.
 *
 * Caret placement (DECISIONS #022, #024): one click at a point computed from the `foo` text
 * node's own `Range` rect — no Home or End key, no arrow key, no modifier chord for the caret
 * (`ControlOrMeta+/` is the app's toggle chord, not a caret motion). Helpers are copied from
 * `editor-toggle-cell-end.spec.ts` (the `writeText` spy of task 1.28, DECISIONS #021, and the
 * 200 ms tick before the chord, lesson [1.46]); the click-at-a-measured-point helper from
 * `editor-soft-line-breaks.spec.ts` (task 1.56).
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

/** The dev bar's selection readout (task 1.62), parsed — the editor's own selection, not the DOM's. */
async function selection(page: Page): Promise<unknown> {
  const text = await page.getByTestId("selection").textContent();
  return JSON.parse(text ?? "null");
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
 * A click at the right edge of `text`'s last character, measured from that text node's own
 * `Range` rect — one native event, no key in flight, and a point every browser resolves to the
 * end of the run (DECISIONS #024, the route beside arrows).
 */
async function clickAfter(page: Page, text: string): Promise<void> {
  const point = await page.evaluate((value: string) => {
    const root = document.querySelector(".ProseMirror");
    if (root === null) throw new Error("no .ProseMirror root");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let target: Text | null = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.textContent === value) {
        target = node as Text;
        break;
      }
    }
    if (target === null) throw new Error(`no text node holding ${value}`);
    const range = document.createRange();
    range.setStart(target, value.length - 1);
    range.setEnd(target, value.length);
    const rect = range.getBoundingClientRect();
    return { x: rect.right - 1, y: rect.top + rect.height / 2 };
  }, text);
  await page.mouse.click(point.x, point.y);
}

test.describe("a toggle to source and back with the caret at the end of a block-final code span", () => {
  test("Claude's route: `see `foo`` loaded, the caret clicked to the end of `foo`, Cmd/Ctrl+/, `X` typed in the source view — the letter joins the span, as it would in the rendered view", async ({
    page,
  }) => {
    const seed = "see `foo`\n";
    await openRendered(page);
    await load(page, "toggle-code-span-end.md", seed);
    await expect.poll(() => markdown(page)).toBe(seed);
    expect(await page.locator(".ProseMirror code").count()).toBe(1);
    expect(await page.locator(".ProseMirror code").textContent()).toBe("foo");

    // The caret placed by one click at the end of the span's own text, read from the editor's own
    // selection (task 1.62, DECISIONS #037) rather than the DOM's — a caret beside a reveal widget
    // has two DOM spellings, and this is the one route `toSource` actually reads: `before` proves
    // the span's end byte for byte, `marks` proves the click route's `$pos.marks()`, and
    // `stored: null` proves no stored marks (M5's click route).
    await clickAfter(page, "foo");
    await expect
      .poll(() => selection(page))
      .toEqual({ before: "see foo", empty: true, marks: ["inline_code"], stored: null });
    // The click moved the DOM selection natively; give ProseMirror's observer a tick to read it
    // before the chord's `toSource` runs (lesson [1.46]).
    await page.waitForTimeout(200);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    // Before this task the carried column was after the closing fence and the letter landed
    // outside the span: `see `foo`X`.
    await page.keyboard.type("X", { delay: 10 });
    const bytes = "see `fooX`\n";
    await expect.poll(() => markdown(page)).toBe(bytes);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    await expect.poll(() => markdown(page)).toBe(bytes);
    expect(await page.locator(".ProseMirror code").count()).toBe(1);
    // The mark's text byte for byte, never a normalising matcher (DECISIONS #022).
    expect(await page.locator(".ProseMirror code").textContent()).toBe("fooX");

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(format(parse(copied))).toBe(copied);
  });
});
