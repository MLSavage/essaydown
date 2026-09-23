import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.64's browser half (DECISIONS #review-1-r8 N2 — Sol finding 2).
 *
 * The editor keeps every character the user types; `stripUnparsableWhitespace`
 * (`packages/editor/src/schema.ts`) does not — a space left leading at a block's start is dropped,
 * because no parse of the bytes could produce it. Before this task the inline correspondence
 * (`correspondences`/`walkInline`, `packages/editor/src/toggle.ts`) derived its live ProseMirror
 * positions from the *normalised* tree's widths, so every character after such a space was mapped
 * one place off — in both directions at once, which is why the inverse `toRendered(toSource(p))`
 * held while both answers were wrong and no round-trip leg could see it.
 *
 * Sol's route, driven here from a real browser. Load `` a `cd` b ``, delete the first character
 * so the block's lead is a space the conversion drops, put the caret between `c` and `d` inside
 * the span, toggle to the source view and type `X`. Before the fix `toSource` answered column 3 —
 * the rendered view holds `` `cXd` b `` and the source view wrote `` `cdX` b ``, one column late.
 * It answers column 2, and the two views write the same bytes. The second case is the same route
 * over `a **cd** b`, the strong twin: a mark whose delimiters are two characters wide, so a
 * correspondence that is off by the dropped lead lands somewhere else again.
 *
 * Caret placement (DECISIONS #022, #024, #037): clicks only, each at a point computed from the
 * target character's own text node `Range` rect — an interior text position, which has one DOM
 * spelling, unlike a run's edges where task 1.4's reveal widgets sit (task 1.62) — never a Home or
 * End key, never a modifier chord for the caret. What is asserted is the **editor's own**
 * selection, read from the dev bar's readout (task 1.62), never the DOM's own selection API:
 * `before` proves
 * the position byte for byte, `marks` proves the click route's `$pos.marks()`, and `stored: null`
 * proves no stored marks. The chord follows a click only after ProseMirror's observer has had a
 * tick to read the DOM selection (lesson [1.46]). Helpers are copied from
 * `editor-toggle-cell-code-pipe.spec.ts`.
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
  // The dev bar's selection readout is what every caret assertion below reads; it is written on
  // the plugin's construction, so it is already there before the first fixture is loaded.
  await page.getByTestId("selection").waitFor();
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
 * One element's `textContent` with task 1.4's reveal decorations (`.essaydown-delimiter`) taken
 * out of a clone first: they are decorations, not document text (lesson [1.45]).
 */
function markText(page: Page, selector: string): Promise<string | null> {
  return page.evaluate((one) => {
    const element = document.querySelector(one);
    if (element === null) return null;
    const clone = element.cloneNode(true) as Element;
    for (const widget of clone.querySelectorAll(".essaydown-delimiter")) widget.remove();
    return clone.textContent;
  }, selector);
}

/**
 * A click at the **left edge** of the character at `index` of the text node whose own text is
 * `value`, inside `selector` — measured from that node's own `Range` rect, the shape of
 * `clickPipe` in `editor-toggle-cell-code-pipe.spec.ts` (task 1.62, DECISIONS #037). Every
 * position this spec clicks is an interior one, so it has a single DOM spelling and needs no key
 * after the click.
 */
async function clickCharacter(
  page: Page,
  selector: string,
  value: string,
  index: number,
): Promise<void> {
  const point = await page.evaluate(
    ({ one, text, at }) => {
      const root = document.querySelector(one);
      if (root === null) throw new Error(`no ${one}`);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let target: Text | null = null;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.textContent === text) {
          target = node as Text;
          break;
        }
      }
      if (target === null) throw new Error(`no text node holding ${JSON.stringify(text)}`);
      const range = document.createRange();
      range.setStart(target, at);
      range.setEnd(target, at + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    },
    { one: selector, text: value, at: index },
  );
  await page.mouse.click(point.x, point.y);
}

/** One case: the Markdown that seeds it, the element the run renders as, and the mark it carries. */
interface Case {
  /** The seed, whose first character this route deletes. */
  seed: string;
  /** The bytes both views hold once it is deleted: the lead is gone, the span is at column 1. */
  stripped: string;
  /** The bytes after `X` is typed between `c` and `d` in the source view. */
  typed: string;
  /** The element the run renders as, and the mark name the readout reports for it. */
  selector: string;
  mark: string;
}

/**
 * Loads a case's seed, deletes the block's first character so its lead is a space the conversion
 * drops, and leaves the caret between `c` and `d` inside the run — every step asserted from the
 * editor's own selection readout, and the last one followed by the observer's tick.
 */
async function seedWithStrippedLead(page: Page, one: Case): Promise<void> {
  await openRendered(page);
  await load(page, "toggle-stripped-lead.md", one.seed);
  await expect.poll(() => markdown(page)).toBe(one.seed);
  expect(one.seed).toBe(format(parse(one.seed)));

  // The caret at the block's very first character, placed by one click at its left edge: nothing
  // before it in the paragraph, no marks, no stored marks (the click route).
  await clickCharacter(page, ".ProseMirror p", "a ", 0);
  await expect
    .poll(() => selection(page))
    .toEqual({ before: "", empty: true, marks: [], stored: null });

  // Forward-delete the `a`. What is left in the *editor* is a leading space the conversion drops,
  // so the bytes lose both characters while the live document keeps the space — the whole of N2.
  await page.keyboard.press("Delete");
  await expect
    .poll(() => selection(page))
    .toEqual({ before: "", empty: true, marks: [], stored: null });
  await expect.poll(() => markdown(page)).toBe(one.stripped);

  // The caret between `c` and `d`, inside the run: one click at `d`'s left edge, an interior text
  // position. `before` is `" c"` — the space the bytes no longer hold, and the `c` — which is the
  // readout proving the live document still carries the dropped character.
  await clickCharacter(page, one.selector, "cd", 1);
  await expect
    .poll(() => selection(page))
    .toEqual({ before: " c", empty: true, marks: [one.mark], stored: null });
  // The click moved the DOM selection natively; give ProseMirror's observer a tick to read it
  // before the chord's `toSource` runs (lesson [1.46]).
  await page.waitForTimeout(200);
}

const CASES: Case[] = [
  {
    seed: "a `cd` b\n",
    stripped: "`cd` b\n",
    typed: "`cXd` b\n",
    selector: ".ProseMirror code",
    mark: "inline_code",
  },
  {
    seed: "a **cd** b\n",
    stripped: "**cd** b\n",
    typed: "**cXd** b\n",
    selector: ".ProseMirror strong",
    mark: "strong",
  },
];

test.describe("a caret after whitespace the conversion drops at a block's start", () => {
  for (const one of CASES) {
    test(`Sol's route over ${JSON.stringify(one.seed.trimEnd())}: the first character deleted, the caret between \`c\` and \`d\`, Cmd/Ctrl+/, then \`X\` typed in the source view — the bytes are ${JSON.stringify(one.typed.trimEnd())}, never one column late`, async ({
      page,
    }) => {
      await seedWithStrippedLead(page, one);

      await page.keyboard.press("ControlOrMeta+/");
      await expect(page.getByTestId("mode")).toHaveText("source");
      await page.locator(".cm-content").waitFor();
      await page.keyboard.type("X", { delay: 10 });
      // The source view holds the user's own bytes. Before the fix the correspondence counted the
      // *stripped* tree's widths as live distances, so `toSource` answered one column late and
      // this line read the `d` before the `X`.
      await expect.poll(() => sourceLines(page)).toEqual([one.typed.trimEnd(), ""]);

      await page.keyboard.press("ControlOrMeta+/");
      await expect(page.getByTestId("mode")).toHaveText("rendered");
      await expect.poll(() => markdown(page)).toBe(one.typed);
      expect(await markText(page, one.selector)).toBe("cXd");

      const copied = await clickCopyMarkdown(page);
      expect(copied).toBe(one.typed);
      // The fixed point: what the user is handed re-parses and re-formats to itself.
      expect(format(parse(copied))).toBe(copied);
    });
  }
});
