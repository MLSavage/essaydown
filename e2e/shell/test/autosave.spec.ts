import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caretToEndOf, clickCentreOf, deleteBackward, reloadPage, typeText } from "./routes.js";

// Autosave and external-change handling (task 2.5): an edit reaches the disk as canonical Markdown
// 500 ms later; the watcher (`watch_folder` → `fs:changed`) reloads a clean document silently and
// raises 'Changed on disk' over a dirty one; a sync tool's truncate-then-rewrite is one reload; a
// non-canonical file shows §6.1's banner once and saves as its canonical form.
//
// The same constraints as file-tree.spec.ts (docs/lessons.md [2.4]): every poll goes through
// `browser.execute`, never one of the six commands `@wdio/tauri-service` hooks with a ~5 s focus
// check. Here even the one `$()` + click per test that file allows costs ~18 s in the container
// (three focus checks), and a case with two clicks overran mocha's 60 s, so every click is a real
// pointer action (`performActions`, not hooked) at the centre of the element's rect read through
// `browser.execute` — "a click at a computed point" (CLAUDE.md). The workspace is seeded through
// the persisted-restore key and a reload, since the native folder dialog cannot be automated. The
// caret, typing and deletion go through e2e/shell/test/routes.ts (a click and `ArrowDown` on the
// external leg, DECISIONS #022; the DOM Selection API on the embedded one); every file comparison
// is byte-exact.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const CONFLICT = '[data-testid="conflict-banner"]';
const NON_CANONICAL = '[data-testid="non-canonical-banner"]';
const CRLF_FIXTURE = new URL("../../../fixtures/markdown/crlf-line-endings.md", import.meta.url);
const INVALID_SIDECAR = '{"sentences":[]}\n';
const CRLF_CANONICAL = new URL("../../../fixtures/markdown/crlf-line-endings.canonical.md", import.meta.url);

async function exists(selector: string): Promise<boolean> {
  return browser.execute((sel) => document.querySelector(sel) !== null, selector);
}

async function count(selector: string): Promise<number> {
  return browser.execute((sel) => document.querySelectorAll(sel).length, selector);
}

async function textContentOf(selector: string): Promise<string> {
  return browser.execute((sel) => document.querySelector(sel)?.textContent ?? "", selector);
}

async function reloads(): Promise<number> {
  const value = await browser.execute(
    () => document.querySelector('[data-testid="document"]')?.getAttribute("data-reloads") ?? "-1",
  );
  return Number(value);
}

async function waitFor(predicate: () => Promise<boolean>, timeout: number, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(predicate, { timeout, interval: 25, timeoutMsg });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("autosave and external changes", () => {
  let workspace: string;
  let doc: string;

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-autosave-"));
    doc = join(workspace, "a.md");
    writeFileSync(doc, "Hello\n");
    writeFileSync(join(workspace, "crlf.md"), readFileSync(CRLF_FIXTURE));
    // A sidecar that does not validate (no `version`): saving must leave it as it is.
    writeFileSync(join(workspace, "crlf.essaydown.json"), INVALID_SIDECAR);
    await openThroughRestore(workspace, "a.md");
  });

  it("an edit is on disk as canonical Markdown 600 ms later, with its sidecar", async () => {
    assert.equal(await exists(NON_CANONICAL), false);
    await caretToEndOf(EDITOR, `${EDITOR} p`);
    await typeText(EDITOR, "X");
    await browser.pause(600);
    assert.equal(readFileSync(doc, "utf8"), "HelloX\n");
    const sidecar = JSON.parse(readFileSync(join(workspace, "a.essaydown.json"), "utf8")) as { version: number };
    assert.equal(sidecar.version, 1);
  });

  it("an external append to the clean document is visible within 1 s and is not saved back", async () => {
    const before = await reloads();
    appendFileSync(doc, "\nAppended by another app.\n");
    const t0 = Date.now();
    await waitFor(
      async () => (await textContentOf(EDITOR)).includes("Appended by another app."),
      1000,
      "the external append was not visible within 1 s",
    );
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(await reloads(), before + 1);
    assert.equal(await exists(CONFLICT), false);
    await browser.pause(700);
    assert.equal(readFileSync(doc, "utf8"), "HelloX\n\nAppended by another app.\n");
  });

  it("an external change under an edit raises 'Changed on disk'; Keep mine overwrites it", async () => {
    await caretToEndOf(EDITOR, `${EDITOR} p:last-child`);
    await typeText(EDITOR, "Y");
    appendFileSync(doc, "\nThird paragraph.\n");
    await waitFor(async () => exists(CONFLICT), 3000, "the 'Changed on disk' banner never appeared");
    assert.equal(await textContentOf(`${CONFLICT} span`), "Changed on disk");
    // Saving is suspended while the banner is up: the external text is still the file.
    await browser.pause(700);
    assert.equal(readFileSync(doc, "utf8"), "HelloX\n\nAppended by another app.\n\nThird paragraph.\n");

    await clickCentreOf('[data-testid="conflict-keep-mine"]');
    const mine = "HelloX\n\nAppended by another app.Y\n";
    await waitFor(async () => readFileSync(doc, "utf8") === mine, 3000, "Keep mine did not overwrite the file");
    await waitFor(async () => !(await exists(CONFLICT)), 3000, "the banner stayed after Keep mine");
    assert.equal((await textContentOf(EDITOR)).includes("Third paragraph."), false);
    await browser.pause(700);
    assert.equal(readFileSync(doc, "utf8"), mine);
  });

  it("an external change under an edit, then Reload, discards the edit", async () => {
    await caretToEndOf(EDITOR, `${EDITOR} p:last-child`);
    await typeText(EDITOR, "Z");
    appendFileSync(doc, "\nFourth paragraph.\n");
    await waitFor(async () => exists(CONFLICT), 3000, "the 'Changed on disk' banner never appeared");

    await clickCentreOf('[data-testid="conflict-reload"]');
    await waitFor(
      async () => (await textContentOf(EDITOR)).includes("Fourth paragraph."),
      3000,
      "Reload did not show the file's text",
    );
    assert.equal(await exists(CONFLICT), false);
    assert.equal((await textContentOf(EDITOR)).includes("Z"), false);
    await browser.pause(700);
    assert.equal(readFileSync(doc, "utf8"), "HelloX\n\nAppended by another app.Y\n\nFourth paragraph.\n");
  });

  it("a truncate then a rewrite 300 ms later is one reload, not two", async () => {
    const before = await reloads();
    writeFileSync(doc, "");
    await sleep(300);
    writeFileSync(doc, "# Rewritten\n\nBy a sync tool.\n");
    await waitFor(
      async () => (await textContentOf(EDITOR)) === "RewrittenBy a sync tool.",
      3000,
      "the rewritten file never showed",
    );
    // Past the 2 s shrink hold, so a second reload (of the empty file, or again of the rewrite)
    // would have happened by now.
    await browser.pause(2500);
    assert.equal(await reloads(), before + 1);
    assert.equal(await textContentOf(EDITOR), "RewrittenBy a sync tool.");
  });

  it("the CRLF fixture shows the non-canonical banner once and saves as its .canonical.md", async () => {
    const crlf = join(workspace, "crlf.md");
    await openThroughRestore(workspace, "crlf.md");
    await waitFor(async () => exists(NON_CANONICAL), 3000, "the non-canonical banner never appeared");
    assert.equal(await count(NON_CANONICAL), 1);
    assert.equal(
      await textContentOf(`${NON_CANONICAL} span`),
      "This file will be saved in Essay Down's Markdown style",
    );
    // Opening writes nothing (§6.1: never on open).
    await browser.pause(700);
    assert.deepEqual(readFileSync(crlf), readFileSync(CRLF_FIXTURE));

    // An edit that nets to nothing: the save writes the document's canonical form.
    await caretToEndOf(EDITOR, `${EDITOR} p`);
    await typeText(EDITOR, "X");
    await deleteBackward(EDITOR);
    await browser.pause(600);
    assert.deepEqual(readFileSync(crlf), readFileSync(CRLF_CANONICAL));
    assert.equal(await count(NON_CANONICAL), 0);

    // Once: the saved file is canonical, so opening it again shows no banner.
    await openThroughRestore(workspace, "crlf.md");
    await browser.pause(300);
    assert.equal(await count(NON_CANONICAL), 0);
    assert.equal(readFileSync(join(workspace, "crlf.essaydown.json"), "utf8"), INVALID_SIDECAR);
  });

  it("opening another file saves a pending edit first instead of dropping it", async () => {
    await openThroughRestore(workspace, "a.md");
    await caretToEndOf(EDITOR, `${EDITOR} p:last-child`);
    await typeText(EDITOR, "Q");
    // At once, inside the 500 ms window: the pane for a.md unmounts, and its timer with it.
    await clickCentreOf('[data-testid="tree-entry:crlf.md"]');
    await waitFor(
      async () => (await textContentOf('[data-testid="current-file"]')) === "crlf.md",
      3000,
      "crlf.md never opened",
    );
    await browser.pause(700);
    assert.equal(readFileSync(doc, "utf8"), "# Rewritten\n\nBy a sync tool.Q\n");
    assert.equal(existsSync(join(workspace, "a.essaydown.json")), true);
  });
});
