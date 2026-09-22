import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";
import type { Nodes } from "mdast";

/**
 * Task 1.58's browser half (DECISIONS #review-1-r7 M2 — Claude finding 2, Sol finding 1).
 *
 * `mdast-util-to-markdown`'s `containerPhrasing` replaced the trailing line ending of the
 * *previous* result by one space before an `html` child whatever node wrote it, so the `break`
 * handler's `\` + line ending became `\` + a space: no parser reads that as a break, and the
 * backslash is rendered as text the writer never typed. Sol's route is this one
 * (`/logs/reviews/1/r7/sol/hardbreak-browser.mjs`): load `alpha\` + a line ending + `<i>beta</i>`,
 * one document `<br>` is rendered, Copy Markdown reports success — and handed over
 * `alpha\ <i>beta</i>`, break count 1 → 0. This case reads the rendered `br` and the bytes the
 * app handed `navigator.clipboard.writeText`.
 *
 * A copy case asserts the string the app handed `writeText`, recorded by an init-script spy,
 * never the OS clipboard read back (task 1.28, DECISIONS #021). The fixed point and the break
 * count are computed in the test process from the imports this file already has, never through a
 * route built inside the page (lesson [1.55]).
 *
 * No caret is placed and no caret key is pressed: the discriminator is the bytes, which the load
 * and the Copy button reach on their own. Helpers are copied from
 * `editor-toggle-inline-html.spec.ts`.
 */

/** The arguments of the `writeText` calls the app made, newest last, recorded on the window. */
type WriteTextSpy = { calls: string[] };

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

/** Every `break` anywhere in `tree`, counted by a walk rather than by a pattern over the bytes. */
function breakCount(tree: Nodes): number {
  let count = tree.type === "break" ? 1 : 0;
  if ("children" in tree) {
    for (const child of tree.children) count += breakCount(child as Nodes);
  }
  return count;
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
  await expect.poll(() => markdown(page)).toBe("");
}

/** Commit `source` through the dev bar's "Load fixture…" input, as a human would (task 1.14's route). */
async function load(page: Page, name: string, source: string): Promise<void> {
  await page
    .getByTestId("fixture-file")
    .setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(source, "utf8") });
  await expect(page.getByTestId("status")).toHaveText(`Loaded ${name}`);
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

test.describe("a hard break before an inline html tag", () => {
  test("Sol's copy route: `alpha\\` + a line ending + `<i>beta</i>` renders one br and copies the break back", async ({
    page,
  }) => {
    const seed = "alpha\\\n<i>beta</i>\n";
    await openRendered(page);
    await load(page, "hard-break-before-inline-html.md", seed);

    // The seed is a fixed point, so the pane shows it unchanged; before this task it showed
    // `alpha\ <i>beta</i>`, a literal backslash and no break at all.
    await expect.poll(() => markdown(page)).toBe(seed);

    // The document's own `br`, counted with ProseMirror's trailing-break placeholder excluded:
    // this paragraph ends in a raw-html widget, so ProseMirror appends its own
    // `<br class="ProseMirror-trailingBreak">` after a `ProseMirror-separator` image to give the
    // block a last line. That placeholder is the view's, not the document's — the same reading as
    // task 1.4's reveal decorations (lesson [1.45]) — and the raw `br` count here is 2.
    expect(await page.locator(".ProseMirror p br.ProseMirror-trailingBreak").count()).toBe(1);
    expect(await page.locator(".ProseMirror p br:not(.ProseMirror-trailingBreak)").count()).toBe(1);

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(seed);
    // The break survives the round trip, and the bytes are their own fixed point — both computed
    // in the test process, from this file's own imports (lesson [1.55]).
    expect(breakCount(parse(copied))).toBe(1);
    expect(format(parse(copied))).toBe(copied);
  });
});
