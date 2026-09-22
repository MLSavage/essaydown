import { expect, test, type Page } from "@playwright/test";
import { format, parse } from "../../packages/core/src/index.js";

/**
 * Task 1.57's browser half (DECISIONS #review-1-r7 M1 — Claude finding 1).
 *
 * Task 1.49's third `SPLIT_PAIR` form — a high-surrogate reference directly followed by a
 * low-surrogate reference — is pure ASCII, and it was applied to the whole string
 * `mdast-util-to-markdown`'s `containerPhrasing` returns, so it rewrote the literal bytes
 * `&#xD83D;&#xDE00;` inside a code span to `&#x1F600;`. Claude's route is this one: in the
 * browser the rendered `<code>` showed the author's own bytes while the pane, the clipboard and
 * "Copied Markdown" carried the rewritten ones — the two views disagreed about a verbatim leaf
 * (PRD §6.1). This case reads both: the rendered text of the code span, and the bytes the app
 * handed `navigator.clipboard.writeText`.
 *
 * A copy case asserts the string the app handed `writeText`, recorded by an init-script spy,
 * never the OS clipboard read back (task 1.28, DECISIONS #021). The fixed point is computed in
 * the test process from the imports this file already has, never through a route built inside the
 * page (lesson [1.55]).
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

/**
 * The rendered code span's `textContent`, read from a clone with task 1.4's reveal decorations
 * (`.essaydown-delimiter`, the backticks drawn on the active line) removed: they are decorations,
 * not document text (lesson [1.45]).
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

test.describe("a code span holding the literal bytes of a split surrogate pair", () => {
  test("Claude's copy route: `see `&#xD83D;&#xDE00;` here` renders and copies the author's own bytes, never `&#x1F600;`", async ({
    page,
  }) => {
    const seed = "see `&#xD83D;&#xDE00;` here\n";
    await openRendered(page);
    await load(page, "code-span-references.md", seed);

    // The seed is a fixed point, so the pane shows it unchanged; before this task it showed
    // ``see `&#x1F600;` here``, and the rendered `<code>` below disagreed with it.
    await expect.poll(() => markdown(page)).toBe(seed);
    expect(await page.locator(".ProseMirror code").count()).toBe(1);
    expect(await codeText(page)).toBe("&#xD83D;&#xDE00;");

    const copied = await clickCopyMarkdown(page);
    expect(copied).toBe(seed);
    // The fixed point in the test process, from this file's own imports (lesson [1.55]).
    expect(format(parse(copied))).toBe(copied);
  });
});
