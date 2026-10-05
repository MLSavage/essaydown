import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 3.12's browser half (DECISIONS #review-1-r9 O7, O8, O9 — Sol r9 findings 1–3; the
 * "stuck in italics" class of Michael's 1.9.r1 note, backlog `[review-1-r10, 1.9.r1 editing
 * feedback]`).
 *
 * The rendered view's typed marks are the reference: a character typed at a caret takes
 * `storedMarks ?? $pos.marks()` (`Transaction.insertText`), and the toggle's `toSource` has to put
 * the source caret where a character typed there takes the same marks. Each case drives one native
 * route twice — once typing `X` straight into the rendered view, once toggling to the source view
 * first and typing `X` there — and asserts that Copy Markdown hands back the same bytes both times,
 * byte for byte with `toBe`. Before task 3.12 each toggle leg wrote other bytes (journal [3.12]):
 *
 * - **O7**, an interior boundary whose typed marks match neither neighbour (`innermostAt` gave it
 *   to the following run): `q [ab](u)*cd* r` at the link's end, and its carried-subset twin
 *   `q *x [ab](u)* r`.
 * - **O8**, the dropped-whitespace shortcut (`beyondDroppedWhitespace` → `betweenNodes`) that
 *   discarded a mark the caret carries: `` *x `bc`* ``, the `x` deleted, the caret past the space.
 * - **O9**, the leaf-start twin of the code-span end rule: `` a`bc` ``, the `a` deleted, so the
 *   caret is at the block's start before a bare code span with stored marks `[]`.
 *
 * Michael's own scenario (type in italics, click onto a plain line, type) is the last case: an
 * observation of the rendered view alone, recorded in the journal.
 *
 * Caret placement (DECISIONS #022, #049; CLAUDE.md): a click at a point computed from a text
 * node's own `Range` rect, `ArrowUp` to a one-line block's start, and counted `ArrowRight` — never
 * Home/End, never a modifier chord for the caret (`ControlOrMeta+/` is the app's toggle). After
 * every native motion the dev bar's selection readout (task 1.62) is polled for the expected
 * caret before the next key (lesson [3.9]), and the chord follows the observer's tick (lesson
 * [1.46]). Helpers are copied from `editor-toggle-stripped-lead.spec.ts`.
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
  await page.getByTestId("editor").waitFor();
  await page.locator(".ProseMirror").click();
  await expect.poll(() => markdown(page)).toBe("");
  await page.getByTestId("selection").waitFor();
}

/** Commit `source` through the dev bar's "Load fixture…" input, as a human would (task 1.14's route). */
async function load(page: Page, name: string, source: string): Promise<void> {
  await page
    .getByTestId("fixture-file")
    .setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(source, "utf8") });
  await expect(page.getByTestId("status")).toHaveText(`Loaded ${name}`);
  await expect.poll(() => markdown(page)).toBe(source);
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
 * A click at the **left edge** of the character at `index` of the text node whose own text is
 * `value` inside `selector` (reveal widgets skipped) — an interior text position, which has one
 * DOM spelling.
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
        if (node.textContent === text && node.parentElement?.closest(".essaydown-delimiter") == null) {
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

/** Press `key` and wait until the editor's own selection readout is `expected` (lesson [3.9]). */
async function pressTo(page: Page, key: string, expected: unknown): Promise<void> {
  await page.keyboard.press(key);
  await expect.poll(() => selection(page)).toEqual(expected);
}

/** One native route: how to seed it and put the caret there, and the readout it must reach. */
interface Route {
  readonly finding: string;
  readonly seed: string;
  /** Places the caret, asserting every step on the readout; the last readout is `caret`. */
  readonly place: (page: Page) => Promise<void>;
  /** The editor's own selection at the caret the toggle carries across. */
  readonly caret: unknown;
  /** The bytes `X` typed straight into the rendered view yields: the reference. */
  readonly direct: string;
}

/** The O7 route: a click inside the link's `ab`, then one `ArrowRight` to the link's end. */
function linkEnd(before: string, marks: string[]): (page: Page) => Promise<void> {
  return async (page) => {
    await clickCharacter(page, ".ProseMirror a", "ab", 1);
    await expect
      .poll(async () => ((await selection(page)) as { before: string }).before)
      .toBe(before.slice(0, -1));
    await pressTo(page, "ArrowRight", { before, empty: true, marks, stored: null });
  };
}

const ROUTES: Route[] = [
  {
    finding: "O7, a non-inclusive link followed by an emphasis run",
    seed: "q [ab](u)*cd* r\n",
    place: linkEnd("q ab", []),
    caret: { before: "q ab", empty: true, marks: [], stored: null },
    direct: "q [ab](u)X*cd* r\n",
  },
  {
    finding: "O7's carried-subset twin, a link at the end of an emphasis run",
    seed: "q *x [ab](u)* r\n",
    place: linkEnd("q x ab", ["emphasis"]),
    caret: { before: "q x ab", empty: true, marks: ["emphasis"], stored: null },
    direct: "q *x [ab](u)X* r\n",
  },
  {
    finding: "O8, the dropped-whitespace gap inside an emphasis run",
    seed: "*x `bc`*\n",
    place: async (page) => {
      await page.locator(".ProseMirror").click();
      await pressTo(page, "ArrowUp", { before: "", empty: true, marks: ["emphasis"], stored: null });
      await page.keyboard.press("Delete");
      await expect.poll(() => markdown(page)).toBe("*`bc`*\n");
      await pressTo(page, "ArrowRight", {
        before: " ",
        empty: true,
        marks: ["emphasis"],
        stored: null,
      });
    },
    caret: { before: " ", empty: true, marks: ["emphasis"], stored: null },
    direct: "*X`bc`*\n",
  },
  {
    finding: "O9, a bare code span at the block's start after a Delete",
    seed: "a`bc`\n",
    place: async (page) => {
      await page.locator(".ProseMirror").click();
      await pressTo(page, "ArrowUp", { before: "", empty: true, marks: [], stored: null });
      await page.keyboard.press("Delete");
      await expect.poll(() => markdown(page)).toBe("`bc`\n");
      await expect
        .poll(() => selection(page))
        .toEqual({ before: "", empty: true, marks: ["inline_code"], stored: [] });
    },
    caret: { before: "", empty: true, marks: ["inline_code"], stored: [] },
    direct: "X`bc`\n",
  },
];

test.describe("the character typed after a toggle takes the marks the rendered view gives it", () => {
  for (const route of ROUTES) {
    for (const toggled of [false, true]) {
      test(`${route.finding}: ${JSON.stringify(route.seed.trimEnd())}, \`X\` typed ${toggled ? "after Cmd/Ctrl+/ in the source view" : "straight into the rendered view"} copies ${JSON.stringify(route.direct.trimEnd())}`, async ({
        page,
      }) => {
        expect(route.seed).toBe(format(parse(route.seed)));
        await openRendered(page);
        await load(page, "typed-marks.md", route.seed);
        await route.place(page);
        expect(await selection(page)).toEqual(route.caret);
        if (toggled) {
          // The motion moved the DOM selection natively; give ProseMirror's observer a tick to
          // read it before the chord's `toSource` runs (lesson [1.46]).
          await page.waitForTimeout(200);
          await page.keyboard.press("ControlOrMeta+/");
          await expect(page.getByTestId("mode")).toHaveText("source");
          await page.locator(".cm-content").waitFor();
        }
        await page.keyboard.type("X", { delay: 10 });
        await expect.poll(() => markdown(page)).toBe(route.direct);
        const copied = await clickCopyMarkdown(page);
        expect(copied).toBe(route.direct);
        expect(format(parse(copied))).toBe(copied);
      });
    }
  }

  test("Michael's scenario (1.9.r1): type inside an italic run, click into a plain line, type — the second character is plain", async ({
    page,
  }) => {
    const seed = "*ab*\n\ncd\n";
    expect(seed).toBe(format(parse(seed)));
    await openRendered(page);
    await load(page, "stuck-in-italics.md", seed);
    await clickCharacter(page, ".ProseMirror em", "ab", 1);
    await expect
      .poll(() => selection(page))
      .toEqual({ before: "a", empty: true, marks: ["emphasis"], stored: null });
    await page.keyboard.type("Y", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("*aYb*\n\ncd\n");
    await clickCharacter(page, ".ProseMirror p:nth-of-type(2)", "cd", 1);
    await expect
      .poll(() => selection(page))
      .toEqual({ before: "c", empty: true, marks: [], stored: null });
    await page.keyboard.type("Z", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("*aYb*\n\ncZd\n");
    expect(await clickCopyMarkdown(page)).toBe("*aYb*\n\ncZd\n");
  });
});
