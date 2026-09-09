import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

/**
 * Task 1.14's acceptance (DECISIONS #review-1-r0 F2): the ProseMirror schema had `toDOM` for every
 * node type and mark and no `parseDOM`, so the editor's *own* copy → paste — which runs the
 * schema's `DOMSerializer` on the way out and its `DOMParser` on the way back — rebuilt the
 * clipboard's HTML as plain text: `# Heading` and `**bold**`, selected, copied and pasted over
 * themselves, came back as `Heading` and `bold`.
 *
 * `packages/editor/test/parse-dom.test.ts` is the headless half (every renderer has an inverse,
 * every `getAttrs` reads back what its `toDOM` wrote). It cannot run the trip itself: vitest runs
 * in Node here and no DOM implementation is in the lockfile, and PRD §4 forbids adding one. So the
 * corpus leg is here, in a real browser, over every fixture in `fixtures/markdown/index.json`.
 *
 * **What drives the clipboard.** The copy and paste are dispatched as real `ClipboardEvent`s
 * carrying a real `DataTransfer`, on the editor's own element — the same two handlers
 * `prosemirror-view` registers for a keyboard copy/paste, reading and writing the same
 * `event.clipboardData`. The bytes therefore make the whole trip (serialise → `text/html` →
 * parse), which is what the finding is about. What this does *not* exercise is the browser's own
 * keystroke → clipboard binding; that is deliberate, because the OS clipboard is one shared
 * resource and these specs run in parallel workers on three OSes. The plain-text case below is the
 * one that does go through the real clipboard, because pasting *foreign* content is exactly the
 * case where the source has to be outside the editor.
 */

const FIXTURES = fileURLToPath(new URL("../../fixtures/markdown", import.meta.url));

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

/** `<name>.canonical.md` is `format(parse(<name>.md))` — the string the Markdown pane shows. */
function canonicalOf(name: string): string {
  return readFileSync(`${FIXTURES}/${name.replace(/\.md$/, "")}.canonical.md`, "utf8");
}

function markdown(page: Page): Promise<string | null> {
  return page.getByTestId("markdown").textContent();
}

/** Commit `source` through the dev bar's "Load fixture…" input, as a human would. */
async function load(page: Page, name: string, source: string): Promise<void> {
  await page
    .getByTestId("fixture-file")
    .setInputFiles({ name, mimeType: "text/markdown", buffer: Buffer.from(source, "utf8") });
  await expect(page.getByTestId("status")).toHaveText(`Loaded ${name}`);
}

async function selectAll(page: Page): Promise<void> {
  await page.locator(".ProseMirror").click();
  await page.keyboard.press("ControlOrMeta+a");
}

/**
 * Copy the current selection and paste it straight back over itself, through the editor's own
 * clipboard handlers. Returns the two flavours the copy wrote, so a case can assert on them.
 */
async function copyPasteOverSelection(page: Page): Promise<{ html: string; text: string }> {
  return page.evaluate(() => {
    const dom = document.querySelector(".ProseMirror");
    if (dom === null) throw new Error("no editor on the page");
    const out = new DataTransfer();
    dom.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData: out, bubbles: true, cancelable: true }),
    );
    const html = out.getData("text/html");
    const text = out.getData("text/plain");
    const back = new DataTransfer();
    back.setData("text/html", html);
    back.setData("text/plain", text);
    dom.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: back, bubbles: true, cancelable: true }),
    );
    return { html, text };
  });
}

test.describe("the editor's own copy → paste over the corpus", () => {
  test("every fixture in index.json is byte-identical before and after", async ({ page }) => {
    await page.goto("/dev/editor");
    const mismatches: string[] = [];
    let checked = 0;
    for (const name of names) {
      const before = canonicalOf(name);
      await load(page, name, readFileSync(`${FIXTURES}/${name}`, "utf8"));
      await expect.poll(() => markdown(page), { message: name }).toBe(before);
      await selectAll(page);
      const { html } = await copyPasteOverSelection(page);
      // Not vacuous: the copy really did put this document on the clipboard as HTML.
      if (before !== "" && !html.includes("data-pm-slice")) mismatches.push(`${name}: no slice`);
      await expect.poll(() => markdown(page), { message: name }).toBe(before);
      const after = await markdown(page);
      if (after !== before) mismatches.push(name);
      checked += 1;
    }
    expect(mismatches).toEqual([]);
    // The count comes from the index, never from a literal written here.
    expect(checked).toBe(Object.keys(index).length);
  });
});

test.describe("the structures the finding named survive their own copy → paste", () => {
  // [case name, Markdown, the selectors that exist only if the structure came back]
  const cases: [string, string, string[]][] = [
    ["a heading", "# Heading\n\n## Second\n", [".ProseMirror h1", ".ProseMirror h2"]],
    ["strong and emphasis", "**bold** and *slanted*\n", [".ProseMirror strong", ".ProseMirror em"]],
    ["a nested list", "- one\n  - inner\n- two\n", [".ProseMirror ul li ul li"]],
    ["a table", "| a | b |\n| :- | -: |\n| c | d |\n", [".ProseMirror table tbody tr td"]],
    [
      "a fenced code block",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```\n",
      [".ProseMirror pre code"],
    ],
    [
      "a raw HTML block",
      '<div class="note">\n  <strong>source, not markup</strong>\n</div>\n',
      [".ProseMirror div.essaydown-raw"],
    ],
  ];

  for (const [name, source, selectors] of cases) {
    test(`${name} round-trips through the clipboard`, async ({ page }) => {
      await page.goto("/dev/editor");
      await load(page, `${name.replace(/\W+/g, "-")}.md`, source);
      // The pane's own canonical string, not the input: `format` re-lays-out a table's columns,
      // and the acceptance is "byte-identical before and after", not "equal to what I typed".
      await expect.poll(() => markdown(page)).not.toBe("");
      const before = await markdown(page);
      for (const selector of selectors)
        expect(await page.locator(selector).count()).toBeGreaterThan(0);
      await selectAll(page);
      await copyPasteOverSelection(page);
      await expect.poll(() => markdown(page)).toBe(before);
      // The structure is still structure, not the plain text the missing rules used to produce.
      for (const selector of selectors)
        expect(await page.locator(selector).count()).toBeGreaterThan(0);
    });
  }

  test("the heading case is the finding's own reproduction, to the byte", async ({ page }) => {
    await page.goto("/dev/editor");
    await load(page, "sol-report-paste.md", "# Heading\n\n**bold**\n");
    await expect.poll(() => markdown(page)).toBe("# Heading\n\n**bold**\n");
    await selectAll(page);
    await copyPasteOverSelection(page);
    await expect.poll(() => markdown(page)).toBe("# Heading\n\n**bold**\n");
    // Before the fix this was `Heading\n\nbold\n`: two paragraphs, no mark.
    expect(await markdown(page)).not.toBe("Heading\n\nbold\n");
    expect(await page.locator(".ProseMirror h1").count()).toBe(1);
    expect(await page.locator(".ProseMirror strong").count()).toBe(1);
  });
});

test.describe("an opaque raw node comes back by its value, and its text stays text", () => {
  const value = '<div class="note">\n  <strong>source, not markup</strong>\n</div>';

  test("the pasted document holds the same raw value and creates no element from it", async ({
    page,
  }) => {
    await page.goto("/dev/editor");
    await load(page, "raw-block.md", `${value}\n`);
    const box = page.locator(".ProseMirror div.essaydown-raw");
    await expect(box).toHaveCount(1);
    await expect.poll(() => markdown(page)).not.toBe("");
    const before = await markdown(page);
    expect(before).toContain("<strong>source, not markup</strong>");
    await selectAll(page);
    await copyPasteOverSelection(page);
    await expect.poll(() => markdown(page)).toBe(before);
    await expect(box).toHaveCount(1);
    // The value is what the node carries, and it is what the box shows.
    expect(await box.getAttribute("data-essaydown-raw")).toBe(value);
    expect(await box.textContent()).toBe(value);
    // …and nothing in that text became an element: the `<strong>` inside it is six characters.
    expect(await page.locator(".ProseMirror strong").count()).toBe(0);
    expect(await box.locator("*").count()).toBe(0);
  });
});

test.describe("plain text pasted from outside the editor stays plain", () => {
  test("a paragraph takes the clipboard's characters, not the markup they spell", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/dev/editor");
    await load(page, "plain-target.md", "ab\n");
    await page.locator(".ProseMirror p").click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await page.evaluate(() => navigator.clipboard.writeText("**still plain**"));
    await page.keyboard.press("ControlOrMeta+v");
    await expect(page.locator(".ProseMirror p")).toHaveText("a**still plain**b");
    expect(await page.locator(".ProseMirror strong").count()).toBe(0);
    expect(await page.locator(".ProseMirror em").count()).toBe(0);
  });
});
