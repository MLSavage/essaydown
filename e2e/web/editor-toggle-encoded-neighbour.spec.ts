import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.46's browser half (DECISIONS #review-1-r5 K2 — Claude finding 2, Sol finding 2, Grok
 * finding 1; the `[1.40, found outside scope]` backlog line's trigger).
 *
 * After 1.41's Backspace route (`Alpha ~~beta.~~ gamma delta`, the space after the run taken) the
 * serializer writes the letter now flush against the run as `&#x67;`, and `placeChildren`
 * (`packages/core/src/positions.ts`) could not find that text node in its parent's output: the
 * node was `unresolved`, `cursorMap` had no range and no spelling table for it, and `toSource` of
 * a caret inside `gamma` fell to the end of the run before it — inside its closing `~~` — so a
 * toggle to source and one keystroke put the character inside the marked run
 * (`Alpha ~~beta.X~~gamma delta`, Claude's reproduction). This is that route, driven from a real
 * browser: the caret three characters into the neighbour, the toggle chord, `X`, the toggle back,
 * Copy Markdown — the bytes are `Alpha ~~beta.~~&#x67;amXma delta`, a fixed point holding one
 * `delete`, and the rendered paragraph reads `Alpha beta.gamXma delta`.
 *
 * A copy case asserts the string the app handed `navigator.clipboard.writeText`, recorded by an
 * init-script spy, never the OS clipboard read back (task 1.28, DECISIONS #021).
 *
 * Caret placement (DECISIONS #022, #024): a click at a computed point — the paragraph's own
 * bounding box, past its last character on its one line, which every browser resolves to the
 * line's end — asserted as a DOM-selection anchor before any key, then counted `ArrowLeft` and
 * `ArrowRight` with the anchor asserted after each run. Never a Home or End key, never a vertical
 * arrow, never a modifier chord for the caret: `ControlOrMeta+/` is the app's toggle chord, not a
 * caret motion, and `tests/no-caret-chords-in-e2e.test.ts` allows it (Home/End chords only). The
 * chord follows the last arrow only after ProseMirror's observer has had a tick to read the DOM
 * selection (the precedent in `editor-toggle.spec.ts`).
 * Helpers are copied from `editor-strikethrough-neighbour.spec.ts` and
 * `editor-toggle-trailing-break.spec.ts`; `documentText` from `editor-astral-neighbour.spec.ts`.
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

/** The `delete` nodes in `bytes`'s own parse, wherever they are. */
function deletesIn(bytes: string): number {
  const walk = (node: { type: string; children?: unknown[] }): number =>
    (node.type === "delete" ? 1 : 0) +
    ((node.children ?? []) as (typeof node)[]).reduce((sum, child) => sum + walk(child), 0);
  return walk(parse(bytes));
}

/**
 * The paragraph's `textContent` with task 1.4's reveal decorations (`.essaydown-delimiter`, the
 * `~~` widgets drawn on the active line) taken out of a clone first: they are decorations, not
 * document text (lesson [1.45]), and the caret is on this paragraph after the toggle back.
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

test.describe("a toggle to source with the caret inside an attention run's encoded neighbour", () => {
  test("Claude's reproduction: `Alpha ~~beta.~~ gamma delta`, one Backspace after the run, the caret three characters into `gamma`, Cmd/Ctrl+/ then `X`, toggle back — the keystroke lands in the neighbour, never inside the run", async ({
    page,
  }) => {
    const seed = "Alpha ~~beta.~~ gamma delta\n";
    await openRendered(page);
    await load(page, "toggle-encoded-neighbour.md", seed);
    await expect.poll(() => markdown(page)).toBe(seed);
    expect(await page.locator(".ProseMirror del").count()).toBe(1);

    // The caret placed by a click and asserted as an anchor before any key: the line's end.
    await clickParagraphEnd(page);
    await expect.poll(() => caret(page)).toEqual({ text: " gamma delta", offset: 12 });

    await press(page, "ArrowLeft", 11);
    await expect.poll(() => caret(page)).toEqual({ text: " gamma delta", offset: 1 });

    // 1.41's route: the Backspace takes the space and leaves `g` flush against the run's closing
    // `~~`, which the serializer writes as `&#x67;` (1.40's own bytes).
    await page.keyboard.press("Backspace");
    const encoded = "Alpha ~~beta.~~&#x67;amma delta\n";
    await expect.poll(() => markdown(page)).toBe(encoded);

    // Three characters into the neighbour. The anchor's text is what the DOM reports for the
    // text node after the Backspace (`gamma delta`: ProseMirror re-rendered the one node), read
    // and asserted rather than assumed.
    await press(page, "ArrowRight", 3);
    await expect.poll(() => caret(page)).toEqual({ text: "gamma delta", offset: 3 });
    // The arrows moved the DOM selection natively; ProseMirror picks it up from `selectionchange`,
    // which Blink dispatches in the rendering update after the key, so its state can still hold
    // the caret at `gamma`'s start when the very next key arrives — and the chord's `toSource`
    // reads that state. Give the observer a tick, as `editor-toggle.spec.ts` does (attempt 1 saw
    // `X` at the node's start, `Alpha \~\~beta.\~\~Xgamma delta`, without it).
    await page.waitForTimeout(200);

    // The toggle chord (the app's own binding, not a caret motion), then one keystroke: where the
    // source caret landed is what the bytes now say. Before 1.46, `toSource` of this caret was the
    // end of `beta.` — inside the run — and the pane read `Alpha ~~beta.X~~gamma delta`.
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.type("X", { delay: 10 });
    const bytes = "Alpha ~~beta.~~&#x67;amXma delta\n";
    await expect.poll(() => markdown(page)).toBe(bytes);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    await expect.poll(() => markdown(page)).toBe(bytes);
    expect(await page.locator(".ProseMirror del").count()).toBe(1);
    expect(await documentText(page)).toBe("Alpha beta.gamXma delta");

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(bytes);
    expect(format(parse(copied))).toBe(copied);
    expect(deletesIn(copied)).toBe(1);
  });
});
