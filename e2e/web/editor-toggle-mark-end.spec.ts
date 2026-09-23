import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.63's browser half (DECISIONS #review-1-r8 N1 — Sol finding 1), Sol's own route.
 *
 * At a block's edge there is no boundary between two inline nodes and no later node, so the
 * cursor map's `innermostAt` never asks about marks and `isLeafEnd` is `false` for a `text` leaf:
 * the source caret was the innermost text's own spelling-table end, *inside* every enclosing
 * delimiter, whatever marks a typed character would take. Typing `see *foo*` in the rendered view
 * closes the run through the emphasis input rule, whose `removeStoredMark`
 * (`packages/editor/src/input.ts`) leaves `storedMarks` `[]` — the next character is plain text —
 * and the toggle then put that character inside the run: `see *fooX*` through the source against
 * `see *foo*X` in the rendered view, one caret and two documents.
 *
 * Both routes to that caret are here, because the marks are what tells them apart and the editor
 * inserts with `storedMarks ?? $pos.marks()` (prosemirror-state's `Transaction.insertText`):
 *
 * - the **input-rule route** (`stored: []`), where no mark is carried and the caret belongs
 *   *outside* the closing `*`;
 * - the **click route** (`stored: null`), where `$pos.marks()` keeps the inclusive `emphasis` and
 *   the caret belongs *inside* it, so the letter extends the run — `see *fooX*`.
 *
 * Caret placement and preconditions (DECISIONS #022, #024, #037): no Home or End key and no
 * modifier chord for the caret (`ControlOrMeta+/` is the app's toggle chord, not a caret motion);
 * the caret is placed by typing or by one click at a point computed from the text node's own
 * `Range` rect; and the precondition is read from the dev bar's selection readout (task 1.62) —
 * the editor's own selection — never from the DOM's, which has two spellings beside a reveal
 * widget. `tests/no-caret-chords-in-e2e.test.ts` guards this file. Helpers are copied from
 * `e2e/web/editor-toggle-code-span-end.spec.ts` (task 1.60, itself from task 1.28's `writeText`
 * spy and task 1.56's click-at-a-measured-point).
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

test.describe("a toggle to source and back with the caret at the end of a block-final emphasis run", () => {
  test("Sol's route: `see *foo*` typed in the rendered view, Cmd/Ctrl+/, `X` typed in the source view — the input rule cleared the stored marks, so the letter stays outside the run", async ({
    page,
  }) => {
    await openRendered(page);
    await page.keyboard.type("see *foo*", { delay: 10 });
    const seed = "see *foo*\n";
    await expect.poll(() => markdown(page)).toBe(seed);
    expect(await page.locator(".ProseMirror em").count()).toBe(1);

    // The precondition, read from the editor's own selection (task 1.62, DECISIONS #037): the
    // caret is at the block's end (`before` is the block's whole text), the document's marks
    // there are the run's, and `stored: []` is what the input rule's `removeStoredMark` left —
    // the one fact that makes the next character plain text.
    await page.getByTestId("selection").waitFor();
    await expect
      .poll(() => selection(page))
      .toEqual({ before: "see foo", empty: true, marks: ["emphasis"], stored: [] });

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    // Before this task the carried column was inside the closing delimiter: `see *fooX*`.
    await page.keyboard.type("X", { delay: 10 });
    const bytes = "see *foo*X\n";
    await expect.poll(() => markdown(page)).toBe(bytes);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    await expect.poll(() => markdown(page)).toBe(bytes);
    expect(await page.locator(".ProseMirror em").count()).toBe(1);
    // The mark's text byte for byte, never a normalising matcher (DECISIONS #022).
    expect(await page.locator(".ProseMirror em").textContent()).toBe("foo");

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(format(parse(copied))).toBe(copied);
  });

  test("the click route: `see *foo*` loaded, the caret clicked to the end of `foo`, Cmd/Ctrl+/, `X` typed in the source view — `$pos.marks()` keeps the inclusive emphasis, so the letter extends the run", async ({
    page,
  }) => {
    const seed = "see *foo*\n";
    await openRendered(page);
    await load(page, "toggle-mark-end.md", seed);
    await expect.poll(() => markdown(page)).toBe(seed);
    expect(await page.locator(".ProseMirror em").count()).toBe(1);
    expect(await page.locator(".ProseMirror em").textContent()).toBe("foo");

    await clickAfter(page, "foo");
    await page.getByTestId("selection").waitFor();
    await expect
      .poll(() => selection(page))
      .toEqual({ before: "see foo", empty: true, marks: ["emphasis"], stored: null });
    // The click moved the DOM selection natively; give ProseMirror's observer a tick to read it
    // before the chord's `toSource` runs (lesson [1.46]).
    await page.waitForTimeout(200);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.type("X", { delay: 10 });
    const bytes = "see *fooX*\n";
    await expect.poll(() => markdown(page)).toBe(bytes);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    await expect.poll(() => markdown(page)).toBe(bytes);
    expect(await page.locator(".ProseMirror em").count()).toBe(1);
    expect(await page.locator(".ProseMirror em").textContent()).toBe("fooX");

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(format(parse(copied))).toBe(copied);
  });
});
