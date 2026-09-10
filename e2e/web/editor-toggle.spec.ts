import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { format, formatWithMap, parse, sentencesOf } from "../../packages/core/src/index.js";

/**
 * Task 1.7's acceptance: the source toggle on `/dev/editor`, driven from a real browser.
 *
 * `packages/editor/test/toggle.test.ts` is the headless half — the cursor map, the source binding
 * and the two keymaps — and this file is the half only a browser can prove: that Cmd/Ctrl+/ really
 * swaps the two views over the one store, that the cursor lands where the position map of task 1.2
 * says it should, that an edit made in CodeMirror is showing in ProseMirror after the swap back,
 * and that the toggle leaves no no-op step on the undo stack.
 *
 * The fixture inputs are read from their own files, never copied into this spec: the essay is read
 * from `fixtures/markdown/essay-fixture.md`, the expected line from `index.json`'s
 * `paragraphStartLines`, and the sentence offset from `sentencesOf` — the same segmenter the
 * product uses.
 */

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURE = `${REPO}fixtures/markdown/essay-fixture.md`;

interface FixtureEntry {
  paragraphStartLines: number[];
}

const essay = readFileSync(FIXTURE, "utf8");
const canonical = format(parse(essay));
const fixtureIndex = JSON.parse(
  readFileSync(`${REPO}fixtures/markdown/index.json`, "utf8"),
) as Record<string, FixtureEntry>;

/** Paragraph 7 of the essay (index 6), and where its second sentence starts inside it. */
const paragraph7 = formatWithMap(parse(essay)).map.entries.filter(
  (entry) => entry.node.type === "paragraph",
)[6];
const paragraph7Text = (paragraph7.node as { children: { value?: string }[] }).children
  .map((child) => child.value ?? "")
  .join("");
const sentence2Start = sentencesOf(paragraph7.node as never)[1].start;
const expectedLine = fixtureIndex["essay-fixture.md"].paragraphStartLines[6];

/** Where a cursor sits in the CodeMirror view: the text of its line, and its offset in that line. */
interface SourceCursor {
  text: string;
  ch: number;
}

/**
 * The CodeMirror cursor read from the DOM selection. CodeMirror renders one `.cm-line` per
 * document line and virtualises the rest, so the line is identified by its *text* and turned into
 * a line number against the canonical string here in Node, where the whole document exists.
 */
function cmCursor(page: Page): Promise<SourceCursor | null> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode ?? null;
    if (anchor === null) return null;
    const element = anchor.nodeType === Node.TEXT_NODE ? anchor.parentElement : (anchor as Element);
    const line = element?.closest(".cm-line") ?? null;
    if (line === null) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let ch = 0;
    let node = walker.nextNode();
    while (node !== null && node !== anchor) {
      ch += node.textContent?.length ?? 0;
      node = walker.nextNode();
    }
    return {
      text: line.textContent ?? "",
      ch: ch + (node === anchor ? selection.anchorOffset : 0),
    };
  });
}

/** The Markdown the store currently holds (the pane serialises the store's snapshot). */
function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

async function openEditor(page: Page): Promise<void> {
  await page.goto("/dev/editor");
  await page.locator(".ProseMirror").click();
  await expect.poll(() => markdown(page)).toBe("");
}

/** Load the essay through the dev-only "Load fixture…" chooser and wait for the store to hold it. */
async function loadEssay(page: Page): Promise<void> {
  await page.getByTestId("fixture-file").setInputFiles(FIXTURE);
  await expect.poll(() => markdown(page)).toBe(canonical);
}

test.describe("source toggle on /dev/editor", () => {
  test("carries the cursor of paragraph 7 sentence 2 to index.json's paragraph line", async ({
    page,
  }) => {
    await openEditor(page);
    await loadEssay(page);

    // The 7th `<p>` of the rendered view is the 7th mdast paragraph; asserted rather than assumed,
    // so an indexing mismatch fails here and not inside the cursor assertion.
    const seventh = page.locator(".ProseMirror p").nth(6);
    await expect(seventh).toHaveText(paragraph7Text);

    // Put the cursor at the start of sentence 2 by placing a collapsed DOM range there;
    // ProseMirror picks the selection up from `selectionchange`.
    await seventh.click();
    await page.evaluate(
      ({ index, offset }) => {
        const paragraph = document.querySelectorAll(".ProseMirror p")[index];
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        let seen = 0;
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const length = node.textContent?.length ?? 0;
          if (seen + length >= offset) {
            const range = document.createRange();
            range.setStart(node, offset - seen);
            range.collapse(true);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            return;
          }
          seen += length;
        }
        throw new Error("the paragraph is shorter than the sentence offset");
      },
      { index: 6, offset: sentence2Start },
    );
    // ProseMirror reads the DOM selection on its own schedule, so give its observer a tick.
    await page.waitForTimeout(200);

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");

    const cursor = await expect
      .poll(async () => (await cmCursor(page))?.text ?? null)
      .toBe(paragraph7Text)
      .then(() => cmCursor(page));
    expect(cursor).not.toBeNull();

    // The line's text is unique in the canonical string, so its index is the line number.
    const lines = canonical.split("\n");
    expect(lines.indexOf(cursor!.text)).toBe(lines.lastIndexOf(cursor!.text));
    expect(lines.indexOf(cursor!.text) + 1).toBe(expectedLine);
    expect(cursor!.ch).toBe(sentence2Start);
  });

  test("an edit made in the source view is showing in the rendered view after the swap back", async ({
    page,
  }) => {
    await openEditor(page);
    await page.keyboard.type("alpha", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("alpha\n");

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();
    await page.keyboard.type(" beta", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("alpha beta\n");

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");
    await expect(page.locator(".ProseMirror")).toHaveText("alpha beta");
    await expect.poll(() => markdown(page)).toBe("alpha beta\n");
  });

  test("200 seeded random toggle-and-edit operations never throw, and invariant A holds", async ({
    page,
  }) => {
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(message.text());
    });

    await openEditor(page);

    // mulberry32, seeded once: the same 200 operations run on every machine and every attempt.
    let seed = 0x1f7_c9d3;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Tokens that a half-typed document is made of: an unclosed fence, a lone table row, a heading
    // marker with nothing after it. §6.5 says every one of them is a legal intermediate state.
    const tokens = ["word ", "\n", "# ", "- ", "> ", "```js\n", "*", "|a|b|", "`", "x"];

    let toggles = 0;
    for (let step = 0; step < 200; step += 1) {
      const roll = random();
      if (roll < 0.25) {
        await page.keyboard.press("ControlOrMeta+/");
        toggles += 1;
      } else if (roll < 0.4) {
        await page.keyboard.press(random() < 0.5 ? "ArrowLeft" : "ArrowRight");
      } else if (roll < 0.5) {
        await page.keyboard.press("Backspace");
      } else {
        await page.keyboard.insertText(tokens[Math.floor(random() * tokens.length)]);
      }
    }

    expect(failures).toEqual([]);
    // Every toggle landed: the run ends in the view its own parity names, so a chord swallowed by
    // a view that had lost focus would show up here rather than passing as a quiet no-op.
    expect(toggles).toBeGreaterThan(0);
    await expect(page.getByTestId("mode")).toHaveText(toggles % 2 === 0 ? "rendered" : "source");
    const text = await markdown(page);
    expect(text).not.toBeNull();
    // Invariant A on what the 200 operations left behind: the canonical string re-parses and
    // re-serialises to itself.
    expect(format(parse(text!))).toBe(text);
  });

  test("a toggle leaves no no-op undo step: one Cmd/Ctrl+Z takes the word back", async ({
    page,
  }) => {
    await openEditor(page);
    await page.keyboard.type("word", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("word\n");

    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("rendered");

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => markdown(page)).toBe("");

    // Lowercase z: the keyCode fallback route (`Shift-Mod-z`, `store.ts`'s
    // KEY_NAMES.redoFromKeyCode). Task 1.21 F9b (DECISIONS #review-1-r0): Playwright synthesises
    // `Shift+z` as `key: "z"` with `shiftKey` set, an event no keyboard produces for a letter key,
    // but it is exactly the shape `w3c-keyname`'s keyCode fallback resolves to `Shift-Mod-z`, so
    // this one case is kept, on purpose, to cover that route. `editor-undo.spec.ts` covers the
    // shifted-letter route (`Mod-Z`) with the capital spelling instead.
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => markdown(page)).toBe("word\n");
  });

  test("undo/redo chords reach the store while the source view is focused", async ({ page }) => {
    // Task 1.21 F9a (DECISIONS #review-1-r0): every existing chord e2e presses undo/redo with the
    // rendered (ProseMirror) view focused; `@codemirror/view`'s `keymap` facet resolves `Mod-` from
    // its own module-level platform constant exactly as `prosemirror-keymap` does (1.verifyh), and
    // nothing had ever dispatched a real keydown at the source view to prove `sourceUndoKeymap`
    // reaches the store through it. Two bursts more than the 1 s coalescing window apart (PRD
    // §6.5), so undo and redo each have one exact step to land on.
    await openEditor(page);
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();

    await page.keyboard.type("first", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("first\n");

    await page.waitForTimeout(1_500);
    await page.keyboard.type(" second", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("first second\n");

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => markdown(page)).toBe("first\n");

    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect.poll(() => markdown(page)).toBe("first second\n");
  });

  /**
   * Sol's two reproductions from the r1 review (DECISIONS #review-1-r1 G2), as real chords in a
   * real browser. Both press Undo *inside* the coalescing window, which is the case the chord test
   * above deliberately steps around by putting 1.5 s between its bursts: the source view commits
   * on the burst boundary (task 1.17), so a chord pressed inside the window used to run against
   * history that did not contain what was on screen, and the pull it caused then dropped the burst.
   *
   * Each press is followed by an assertion on both halves — the Markdown pane (the store) and the
   * CodeMirror surface (the buffer) — because the defect showed as the two disagreeing.
   * `packages/editor/test/toggle.test.ts`'s five cases pin the grouping arithmetic where the clock
   * is injected; these two prove the wiring in the product, chord to keymap to binding to store.
   */
  test("reproduction (a): Undo inside the first burst empties the surface", async ({ page }) => {
    await openEditor(page);
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();

    await page.keyboard.type("first", { delay: 10 });
    await expect(page.locator(".cm-content")).toHaveText("first");
    await page.keyboard.press("ControlOrMeta+z");

    // The Undo settled the burst and then stepped back over it, so both halves are empty. Before
    // the fix the surface still read "first": the Undo found an empty history and did nothing.
    await expect(page.locator(".cm-content")).toHaveText("");
    await expect.poll(() => markdown(page)).toBe("");

    // And it stays empty: the burst timer has nothing left to commit a window later.
    await page.waitForTimeout(1_500);
    await expect(page.locator(".cm-content")).toHaveText("");
    expect(await markdown(page)).toBe("");
  });

  test("reproduction (b): Undo inside the second burst keeps the first, and Redo restores it", async ({
    page,
  }) => {
    await openEditor(page);
    await page.keyboard.press("ControlOrMeta+/");
    await expect(page.getByTestId("mode")).toHaveText("source");
    await page.locator(".cm-content").waitFor();

    await page.keyboard.type("first", { delay: 10 });
    // Sol's 1.2 s: long enough for the first burst's own timer to fire (one window) and for the
    // next keystroke to be a second burst. Waited rather than polled, so the second burst starts
    // where the reproduction starts it — a quarter-second after the first burst's commit ran,
    // which is the distance that used to merge the two into one undo entry.
    await page.waitForTimeout(1_200);
    await expect.poll(() => markdown(page)).toBe("first\n");

    await page.keyboard.type(" second", { delay: 10 });
    await page.keyboard.press("ControlOrMeta+z");

    await expect(page.locator(".cm-content")).toHaveText("first");
    await expect.poll(() => markdown(page)).toBe("first\n");

    await page.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(page.locator(".cm-content")).toHaveText("first second");
    await expect.poll(() => markdown(page)).toBe("first second\n");
  });
});
