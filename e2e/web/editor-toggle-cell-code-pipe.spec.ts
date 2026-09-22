import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.59's browser half (DECISIONS #review-1-r7 M4 — Sol finding 2).
 *
 * `mdast-util-gfm-table` (2.0.0) installs `inlineCodeWithTable` at `lib/index.js` lines 291–298:
 * inside a `tableCell` it rewrites every `|` of the base handler's output as `\|`.
 * `inlineCodeSpelling` read only the base handler's shape, so a cell's `` `a\|b` `` (value `a|b`)
 * failed its length check and got no spelling table at all — with `map.unresolved` still empty —
 * and every caret inside the span fell to the node's start.
 *
 * Sol's route, driven here from a real browser: the caret placed after `a` inside the span and
 * asserted as an anchor, `ControlOrMeta+/` to the source view, `X` typed there. Before the fix
 * `cursorMap.toSource` answered the span's *start* — the opening backtick — and the keystroke
 * landed outside the span (`| X`a\|b` |`); it lands between `a` and the escaped pipe, so the
 * bytes are `` | `aX\|b` | `` and the rendered span reads `aX|b`.
 *
 * **The toggle back is the second case, and it is a different defect.** The task text's route
 * types `X` after toggling *back* to the rendered view. That route cannot discriminate this fix
 * and does not reach `aX|b`, because `canonicalCursor` (`packages/editor/src/toggle.ts` 646–658)
 * refines a carried source position through a spelling table only when the innermost live node is
 * a `text` node; for an `inlineCode` node it falls to `range.startLine`/`startCol`, the span's
 * start. That is pipe-independent and table-independent — headlessly, a caret after `a` in
 * `z `ab` y` comes back as the span's start too — so it is outside this task's scope
 * (`toggle.ts` is excluded by the task text) and is filed in docs/V1.1-BACKLOG.md. The second
 * case below asserts that behaviour positively and by name, never as a skipped or expected-to-fail case and never by
 * dropping the route (DECISIONS #032): the caret comes back at the span's start, `X` lands there,
 * and the escaped pipe still survives the whole round trip.
 *
 * A copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
 *
 * Caret placement (DECISIONS #022, #024, #037): one click at a point computed from the span's own
 * text node's `Range` rect, over the pipe (an interior text position, which has one DOM spelling
 * unlike the run's edges — task 1.62) — never a Home or End key, never an arrow, never a modifier
 * chord for the caret. The editor's own selection is read from the dev bar's readout (task 1.62),
 * not the DOM's, so what is asserted is what `toSource` actually reads: `before`, `marks` and
 * `stored`. The chord follows the click only after ProseMirror's observer has had a tick to read
 * the DOM selection (lesson [1.46]). Helpers are copied from `editor-toggle-cell-end.spec.ts`.
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

/** The source view's lines, one per `.cm-line` — CodeMirror renders no line ending of its own. */
function sourceLines(page: Page): Promise<string[]> {
  return page.locator(".cm-line").allTextContents();
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
 * The one `<code>`'s `textContent` with task 1.4's reveal decorations (`.essaydown-delimiter`)
 * taken out of a clone first: they are decorations, not document text (lesson [1.45]), and the
 * caret is on this span's cell after the toggle back.
 */
function codeText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const code = document.querySelector(".ProseMirror code");
    if (code === null) return null;
    const clone = code.cloneNode(true) as Element;
    for (const widget of clone.querySelectorAll(".essaydown-delimiter")) widget.remove();
    return clone.textContent;
  });
}

/**
 * A click at the pipe's own left edge, measured from the span's text node's `Range` rect over its
 * character 1 (the pipe in `a|b`) — an interior text position, which has one DOM spelling, unlike
 * the run's edges the reveal widgets sit beside (task 1.62, DECISIONS #037). The text node is
 * found the way `clickAfter` finds its own, in `editor-toggle-code-span-end.spec.ts`, but rooted
 * at `.ProseMirror code` rather than `.ProseMirror`.
 */
async function clickPipe(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const root = document.querySelector(".ProseMirror code");
    if (root === null) throw new Error("no .ProseMirror code");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let target: Text | null = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.textContent === "a|b") {
        target = node as Text;
        break;
      }
    }
    if (target === null) throw new Error("no text node holding a|b");
    const range = document.createRange();
    range.setStart(target, 1);
    range.setEnd(target, 2);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + 1, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
}

/** The seed, exactly the lines the reconciliation ran: one body cell holding `` `a\|b` ``. */
const SEED = "| h |\n| - |\n| `a\\|b` |\n";

/** The seed's canonical form, which is what both views show: the columns padded to the span. */
const CANONICAL = "| h      |\n| ------ |\n| `a\\|b` |\n";

/**
 * Loads the seed, asserts both views agree on it, and leaves the caret after `a` inside the span,
 * asserted as an anchor before and after the one counted arrow.
 */
async function seedWithCaretAfterA(page: Page): Promise<void> {
  await openRendered(page);
  await load(page, "toggle-cell-code-pipe.md", SEED);
  // The pane shows `format(root)`, so it is the seed's canonical form: the columns padded.
  expect(CANONICAL).toBe(format(parse(SEED)));
  await expect.poll(() => markdown(page)).toBe(CANONICAL);
  // One code span, and the table extension's escape is not part of the value the view shows.
  await expect.poll(() => page.locator(".ProseMirror code").count()).toBe(1);
  expect(await codeText(page)).toBe("a|b");

  // The caret placed by one click at an interior text position — the pipe's left edge, which has
  // one DOM spelling and needs no key after the click (task 1.62) — asserted from the editor's own
  // selection: `before` proves the position byte for byte, `marks` proves the click route's
  // `$pos.marks()`, and `stored: null` proves no stored marks (M5's click route).
  await clickPipe(page);
  await expect
    .poll(() => selection(page))
    .toEqual({ before: "a", empty: true, marks: ["inline_code"], stored: null });
  // The click moved the DOM selection natively; give ProseMirror's observer a tick to read it
  // before the chord's `toSource` runs (lesson [1.46]).
  await page.waitForTimeout(200);
}

test.describe("a caret inside a code span holding a pipe, in a table cell", () => {
  test("Sol's route: the caret after `a` in `` `a\\|b` ``, Cmd/Ctrl+/, then `X` typed in the source view — the bytes are `` | `aX\\|b` | ``, never `| X`a\\|b` |`", async ({
    page,
  }) => {
    await seedWithCaretAfterA(page);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.type("X", { delay: 10 });
    // The source view holds the user's own bytes, so only the one cell's column grew; before the
    // fix `toSource` answered the span's start and this line read `| X`a\|b` |`.
    await expect
      .poll(() => sourceLines(page))
      .toEqual(["| h      |", "| ------ |", "| `aX\\|b` |", ""]);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    // The serializer pads every column to its widest cell, so the whole string is the canonical
    // form of the three rows with `aX|b` in the body cell — and never `` `Xa\|b` ``.
    const bytes = "| h       |\n| ------- |\n| `aX\\|b` |\n";
    expect(bytes).toBe(format(parse("| h |\n| - |\n| `aX\\|b` |\n")));
    await expect.poll(() => markdown(page)).toBe(bytes);
    expect(await codeText(page)).toBe("aX|b");

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(copied.split("\n")[2]).toBe("| `aX\\|b` |");
    expect(format(parse(copied))).toBe(copied);
  });

  test("the task text's round trip, bounded by name: `canonicalCursor` has no `inlineCode` branch, so the caret comes back at the span's start and `X` lands there (docs/V1.1-BACKLOG.md, `[1.59, found outside scope]`)", async ({
    page,
  }) => {
    await seedWithCaretAfterA(page);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    // `canonicalCursor` (toggle.ts 646–658) carries a source position through a spelling table
    // only for a `text` node; the innermost live node here is the `inlineCode`, so it answers the
    // node's start, as the readout reads it: nothing before the caret in the cell's own textblock,
    // still inside the span.
    await expect
      .poll(() => selection(page))
      .toEqual({ before: "", empty: true, marks: ["inline_code"], stored: null });

    await page.keyboard.type("X", { delay: 10 });
    // The keystroke lands at the span's start, inside the span: `Xa|b`, not `aX|b`. Everything
    // this task owns still holds — the pipe is still one character of the value, still written
    // `\|` by the table extension, and the whole document is still a fixed point.
    const bytes = "| h       |\n| ------- |\n| `Xa\\|b` |\n";
    expect(bytes).toBe(format(parse("| h |\n| - |\n| `Xa\\|b` |\n")));
    await expect.poll(() => markdown(page)).toBe(bytes);
    expect(await codeText(page)).toBe("Xa|b");

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(copied.split("\n")[2]).toBe("| `Xa\\|b` |");
    expect(format(parse(copied))).toBe(copied);
  });
});
