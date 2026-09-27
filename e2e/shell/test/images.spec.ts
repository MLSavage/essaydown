import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadPage } from "./routes.js";

// Images (task 2.6, PRD §6.4): paste/drag -> save_image -> `![](assets/<docstem>/<file>)`; the
// rendered view resolves a relative `src` against the document's own directory and renders it
// through `convertFileSrc`; a broken path renders a labelled placeholder.
//
// A paste is dispatched as a real `ClipboardEvent` carrying a real `DataTransfer` with an image
// `File`, directly on the editor's own DOM element (e2e/web/editor-clipboard.spec.ts's established
// route for exercising `prosemirror-view`'s own paste handler, ported here) — never the OS
// clipboard, which cannot be automated headlessly and is one shared resource across parallel
// workers anyway. Every read goes through `browser.execute`, never one of the six commands
// `@wdio/tauri-service` hooks with a ~5-6 s focus check (docs/lessons.md [2.4]); this file never
// calls `$()` at all, since nothing here needs a real WebDriver click.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const PLACEHOLDER = '[data-testid="image-placeholder"]';
// Scoped to `.image-node`, the wrapper `image-view.ts`'s `NodeView` puts around every rendered
// `img`: ProseMirror itself appends its own `<img class="ProseMirror-separator">` at a trailing
// inline position (its own cursor-placement workaround, unrelated to any document content), which
// a bare `${EDITOR} img` selector would count as one more image than the document actually holds.
const IMAGE = `${EDITOR} .image-node img`;

// A minimal valid 1x1 transparent PNG (67 bytes) — real bytes, so the webview's own image decoder
// (not a stub) is what proves "renders".
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function exists(selector: string): Promise<boolean> {
  return browser.execute((sel) => document.querySelector(sel) !== null, selector);
}

async function textContentOf(selector: string): Promise<string> {
  return browser.execute((sel) => document.querySelector(sel)?.textContent ?? "", selector);
}

async function count(selector: string): Promise<number> {
  return browser.execute((sel) => document.querySelectorAll(sel).length, selector);
}

async function imageLoaded(selector: string): Promise<boolean> {
  return browser.execute((sel) => {
    const img = document.querySelector(sel);
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
  }, selector);
}

async function naturalWidthOf(selector: string): Promise<number> {
  return browser.execute((sel) => {
    const img = document.querySelector(sel);
    return img instanceof HTMLImageElement ? img.naturalWidth : -1;
  }, selector);
}

async function waitFor(predicate: () => Promise<boolean>, timeout: number, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(predicate, { timeout, interval: 50, timeoutMsg });
}

async function openThroughRestore(folder: string, file: string): Promise<void> {
  await browser.execute(
    (key, value) => localStorage.setItem(key, value),
    STORAGE_KEY,
    JSON.stringify({ folder, file }),
  );
  await reloadPage();
  await waitFor(
    async () => (await textContentOf('[data-testid="current-file"]')) === file && (await exists(EDITOR)),
    15000,
    `${file} never opened in the editor`,
  );
}

/** Dispatches a `paste` event carrying one image `File` on the editor's own DOM element —
 * `image-paste.ts`'s `handlePaste` reads `event.clipboardData.files`, exactly what a real OS
 * paste of a screenshot or a copied image would carry. The event is a plain `Event` with
 * `clipboardData` defined on it directly (`Object.defineProperty`, not the `ClipboardEvent`
 * constructor's `clipboardData` init field), because that field is a Chromium-only convenience
 * this WebKitGTK build does not honour — the defined property is read exactly the same way by the
 * handler either way, on any engine. */
async function pasteImage(base64: string, mime: string): Promise<void> {
  await browser.execute(
    (editorSel, b64, type) => {
      const editor = document.querySelector(editorSel);
      if (editor === null) throw new Error("editor not on the page");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], "clipboard-image", { type });
      const data = new DataTransfer();
      data.items.add(file);
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      editor.dispatchEvent(event);
    },
    EDITOR,
    base64,
    mime,
  );
}

describe("images: paste, broken paths and cross-folder relative paths", () => {
  let workspace: string;

  before(() => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-images-"));
    writeFileSync(join(workspace, "a.md"), "# A\n");
    writeFileSync(join(workspace, "two-pastes.md"), "# Two\n");
    writeFileSync(join(workspace, "missing-ref.md"), "![](missing.png)\n");
    mkdirSync(join(workspace, "sub"), { recursive: true });
    mkdirSync(join(workspace, "shared"), { recursive: true });
    writeFileSync(join(workspace, "sub", "doc.md"), "![](../shared/img.png)\n");
    writeFileSync(join(workspace, "shared", "img.png"), Buffer.from(PNG_1X1_BASE64, "base64"));
  });

  it("pasting a 1x1 PNG saves it, writes the relative Markdown path, and renders in the webview", async () => {
    await openThroughRestore(workspace, "a.md");
    await pasteImage(PNG_1X1_BASE64, "image/png");
    await waitFor(async () => (await count(IMAGE)) === 1, 5000, "the pasted image never appeared");
    await waitFor(async () => imageLoaded(IMAGE), 5000, "the pasted <img> never finished loading");
    assert.equal(await naturalWidthOf(IMAGE), 1);

    await browser.pause(700); // past the 500 ms autosave debounce (task 2.5)
    const doc = readFileSync(join(workspace, "a.md"), "utf8");
    const match = /!\[\]\((assets\/a\/[^)]+)\)/.exec(doc);
    assert.ok(match, `Markdown does not hold a relative assets/a/… path: ${doc}`);
    const bytes = readFileSync(join(workspace, match[1]));
    assert.ok(bytes.length > 0, "the saved file on disk is empty");
  });

  it("two pastes within the same second produce two distinct files", async () => {
    await openThroughRestore(workspace, "two-pastes.md");
    await pasteImage(PNG_1X1_BASE64, "image/png");
    await pasteImage(PNG_1X1_BASE64, "image/png");
    await waitFor(async () => (await count(IMAGE)) === 2, 5000, "both pasted images never appeared");

    await browser.pause(700);
    const doc = readFileSync(join(workspace, "two-pastes.md"), "utf8");
    const matches = [...doc.matchAll(/!\[\]\((assets\/two-pastes\/[^)]+)\)/g)].map((m) => m[1]);
    assert.equal(matches.length, 2);
    assert.notEqual(matches[0], matches[1]);
  });

  it("opening a doc referencing a missing image shows a labelled placeholder", async () => {
    await openThroughRestore(workspace, "missing-ref.md");
    await waitFor(async () => exists(PLACEHOLDER), 5000, "the placeholder never appeared");
    assert.equal(await textContentOf(PLACEHOLDER), "Image not found: missing.png");
    assert.equal(await count(IMAGE), 0);
  });

  it("a doc in a sub-folder renders an image referenced with ../shared/img.png", async () => {
    await openThroughRestore(workspace, "sub/doc.md");
    await waitFor(async () => imageLoaded(IMAGE), 5000, "the sub-folder image never rendered");
    assert.equal(await exists(PLACEHOLDER), false);
  });
});
