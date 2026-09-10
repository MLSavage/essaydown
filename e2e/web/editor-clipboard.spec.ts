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
    // Collects what the loop actually loaded, so the coverage assertion after it is a claim about
    // the loop's own execution, not `checked === names.length` — which held for any for-of loop
    // over `names` that never threw, whatever it did inside (task 1.21 F9c's class; G8).
    const checkedNames: string[] = [];
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
      checkedNames.push(name);
    }
    expect(mismatches).toEqual([]);
    // The list comes from what the loop actually loaded, never a count copied from the index.
    expect(checkedNames).toEqual(names);
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

/**
 * Task 1.23 (DECISIONS #review-1-r1 G1, a regression from task 1.17): "Copy Markdown" formatted
 * `store.getState().document.root` directly, so while a source-view burst was still pending (1.17
 * commits it one coalescing window after the last keystroke) the button copied the last committed
 * root and reported "Copied Markdown" anyway — clipboard and status both lied about what was on
 * the clipboard. The fix is `copyMarkdown`'s first statement: flush the source binding before
 * reading the root, mirroring what `toggle` (DevEditor.tsx) already does before its own read.
 *
 * **What a copy case asserts, and what needs the real clipboard** (task 1.28, DECISIONS #021). A
 * copy case asserts the string the app handed `navigator.clipboard.writeText`; a paste case of
 * *foreign* content is the one that needs the real clipboard, because there the source has to be
 * outside the editor — which is why the plain-text case above keeps the clipboard and its
 * permission grant and the three cases below need neither. The three used to read the string back
 * out of the OS clipboard after the app wrote it, and passed here, on ubuntu and on macos; on
 * windows-latest they failed, because Chromium hands plain text to the Windows system
 * clipboard with every line feed converted to a carriage return followed by a line feed, so the
 * read returned a carriage return the app never wrote. The app wrote the right bytes and the
 * assertion had encoded one platform's clipboard convention. `installWriteTextSpy` records the
 * argument instead, so the assertion is byte-exact and independent of what any OS does with it —
 * and the carriage return is named here in words rather than normalised away in an assertion,
 * because a stray one the app itself one day writes must fail rather than be swallowed. The app's
 * real path is still the thing exercised: flush → `format` → `writeText` → the "Copied Markdown"
 * status, which `copyMarkdown` sets only after the write resolves.
 */

/** The arguments of the `writeText` calls the app made, newest last, recorded on the window. */
type WriteTextSpy = { calls: string[] };

/**
 * Replace `navigator.clipboard.writeText` before any of the page's own scripts run, so that what
 * the app writes is recorded on the window instead of being handed to the OS clipboard.
 */
async function installWriteTextSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spy = { calls: [] as string[] };
    (window as unknown as { __writeText: { calls: string[] } }).__writeText = spy;
    navigator.clipboard.writeText = (text: string) => {
      spy.calls.push(text);
      return Promise.resolve();
    };
  });
}

async function openEditor(page: Page): Promise<void> {
  await installWriteTextSpy(page);
  await page.goto("/dev/editor");
  await page.locator(".ProseMirror").click();
  await expect.poll(() => markdown(page)).toBe("");
}

async function toggleToSource(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+/");
  await expect(page.getByTestId("mode")).toHaveText("source");
  await page.locator(".cm-content").waitFor();
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

test.describe("Copy Markdown flushes a pending source burst before it reads the store", () => {
  test("presence: copying inside the coalescing window includes the just-typed text, with no pause and no toggle", async ({
    page,
  }) => {
    await openEditor(page);
    await toggleToSource(page);
    // Well inside the 1 s coalescing window (PRD §6.5): typed and copied with no wait between.
    await page.keyboard.type("alpha", { delay: 10 });
    const written = await clickCopyMarkdown(page);
    expect(written).toBe("alpha\n");
  });

  test("absence: copying after the coalescing window has elapsed reads the same committed text", async ({
    page,
  }) => {
    await openEditor(page);
    await toggleToSource(page);
    await page.keyboard.type("beta", { delay: 10 });
    await page.waitForTimeout(1_500);
    await expect.poll(() => markdown(page)).toBe("beta\n");
    const written = await clickCopyMarkdown(page);
    expect(written).toBe("beta\n");
  });

  test("the rendered view's copy is unchanged: every keystroke there is already committed, so an immediate copy needs no flush", async ({
    page,
  }) => {
    await openEditor(page);
    await page.keyboard.type("gamma", { delay: 10 });
    await expect.poll(() => markdown(page)).toBe("gamma\n");
    const written = await clickCopyMarkdown(page);
    expect(written).toBe("gamma\n");
  });
});
