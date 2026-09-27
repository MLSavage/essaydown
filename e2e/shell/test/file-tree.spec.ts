import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadPage, setRenameField } from "./routes.js";

// The file tree sidebar (task 2.4): open folder, new file, rename (F2 / context menu), delete to
// trash, click to open, cloudOnly entries greyed with a tooltip, last folder and file restored on
// launch. The "Open Folder" button drives a native OS dialog WebdriverIO cannot automate, so every
// spec here seeds the workspace directly through `localStorage`'s own persisted-restore key
// (`essaydown:lastWorkspace`, `apps/desktop/src/workspace/storage.ts`) and a page reload — the same
// code path a real relaunch takes (the app's mount effect calls `open_folder` + `list_tree` itself
// from that key, never a shortcut around it), which is also exactly the acceptance's own "relaunch
// restores the same file" case. Byte-exact assertions on file contents (DECISIONS #022's rule),
// never a normalising matcher.
//
// `@wdio/tauri-service`'s `beforeCommand` hook runs `ensureActiveWindowFocus` on exactly six
// command names — `getTitle`/`findElement`/`findElements`/`$`/`$$`/`elementClick` (installed
// dist/esm/index.js ~3033) — and that check's `getWindowStates()` call goes through the direct-eval
// wrapper's `wrapScriptForDirectEval`, which busy-waits up to 5000ms (100 * 50ms) for
// `window.__wdio_original_core__` before giving up, because this app registers
// `tauri-plugin-wdio-webdriver` only, not the window-state plugin (docs/lessons.md [2.4], attempt
// 3's STUCK diagnosis). Every one of those six commands therefore costs ~5-6s in this container, so
// every helper here reads state through `browser.execute` (never one of the six) and `$()` is
// called at most once per test, immediately before the one real click that test needs — never
// inside a `waitUntil` predicate, never for a lookup whose result isn't clicked.
const STORAGE_KEY = "essaydown:lastWorkspace";

async function setLastWorkspace(folder: string, file: string | null): Promise<void> {
  await browser.execute(
    (key, value) => localStorage.setItem(key, value),
    STORAGE_KEY,
    JSON.stringify({ folder, file }),
  );
}

async function exists(selector: string): Promise<boolean> {
  return browser.execute((sel) => document.querySelector(sel) !== null, selector);
}

async function waitForSelector(selector: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => exists(selector), { timeout: 15000, timeoutMsg });
}

async function readAttribute(selector: string, attr: string): Promise<string | null> {
  return browser.execute((sel, a) => document.querySelector(sel)?.getAttribute(a) ?? null, selector, attr);
}

// `WebdriverIO.Element#getText()` reads the rendered ("innerText"-like) string, which drops a
// trailing newline the `<pre>` still holds — byte-exact file content needs the DOM's own
// `textContent` instead (DECISIONS #022's rule, never a normalising matcher).
async function textContentOf(selector: string): Promise<string> {
  return browser.execute((sel) => document.querySelector(sel)?.textContent ?? "", selector);
}

async function waitForTextContent(selector: string, expected: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(async () => (await textContentOf(selector)) === expected, {
    timeout: 15000,
    timeoutMsg,
  });
}

function entrySelector(path: string): string {
  return `[data-testid="tree-entry:${path}"]`;
}

async function reload(): Promise<void> {
  await reloadPage();
  // The reload is a same-origin navigation of the embedded asset-protocol page, not a new Tauri
  // process; the window's own React root remounts, so waiting for the toolbar (present before any
  // IPC call resolves) proves the page actually came back before the next step polls for the tree.
  await waitForSelector('[data-testid="open-folder"]', '[data-testid="open-folder"] never reappeared after reload');
}

// The acceptance's "relaunch" is a new Tauri process, not a same-process navigation:
// `reloadSession()` ends the app process on `DELETE /session` and starts a fresh one on
// `POST /session`, while a page reload only proves the frontend path (docs/lessons.md
// [2.4]'s attempt-3 lesson). The webview's on-disk storage (the persisted-restore key included)
// survives the process restart the same way a real relaunch's would.
async function relaunch(): Promise<void> {
  try {
    await browser.reloadSession();
  } catch (error) {
    console.warn(
      `reloadSession() failed (${(error as Error).message}); falling back to a page reload — ` +
        "this only re-proves the frontend path, not a real process restart",
    );
    await reload();
    return;
  }
  await waitForSelector(
    '[data-testid="open-folder"]',
    '[data-testid="open-folder"] never reappeared after reloadSession()',
  );
}

describe("the file tree sidebar", () => {
  let workspace: string;

  before(() => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-file-tree-"));
    writeFileSync(join(workspace, "a.md"), "# A\n\nOriginal content.\n");
    writeFileSync(join(workspace, "a.essaydown.json"), JSON.stringify({ sentences: [] }));
    mkdirSync(join(workspace, "assets", "a"), { recursive: true });
    writeFileSync(join(workspace, "assets", "a", "image.png"), "not-a-real-png");
    // `c.md.icloud`: `list_tree` reports this as `c.md`, `cloudOnly: true` (task 2.2).
    writeFileSync(join(workspace, "c.md.icloud"), "");
  });

  it("restores the workspace from the persisted-restore key and lists its entries", async () => {
    await setLastWorkspace(workspace, null);
    await reload();
    await waitForSelector(entrySelector("a.md"), "tree-entry:a.md never appeared");
    await waitForSelector(entrySelector("c.md"), "tree-entry:c.md never appeared");
    assert.equal(await readAttribute(entrySelector("c.md"), "data-cloud-only"), "true");
  });

  it("clicking a plain entry opens it", async () => {
    await waitForSelector(entrySelector("a.md"), "tree-entry:a.md never appeared");
    await (await browser.$(entrySelector("a.md"))).click();
    await waitForTextContent('[data-testid="current-file"]', "a.md", 'current-file never became "a.md"');
    assert.equal(await textContentOf('[data-testid="current-content"]'), "# A\n\nOriginal content.\n");
  });

  it("renames a.md to b.md via F2, moving the sidecar and assets together", async () => {
    // F2 (PRD's other named trigger, beside the context menu) needs only the one click the
    // "clicking a plain entry" test already exercises to focus the row (`tabIndex={0}`,
    // apps/desktop/src/workspace/FileTree.tsx onKeyDown) — no context-menu click, no rename-input
    // lookup: the input auto-focuses and auto-selects its text on mount (FileTree.tsx's
    // `RenameInput` effect), so typing directly replaces it.
    await waitForSelector(entrySelector("a.md"), "tree-entry:a.md never appeared");
    await (await browser.$(entrySelector("a.md"))).click();
    await browser.keys(["F2"]);

    await waitForSelector('[data-testid="rename-input"]', "rename-input never appeared");
    await setRenameField("b.md");
    await browser.keys(["Enter"]);

    await waitForSelector(entrySelector("b.md"), "tree-entry:b.md never appeared");
    assert.equal(await exists(entrySelector("a.md")), false);

    assert.equal(existsSync(join(workspace, "a.md")), false);
    assert.equal(existsSync(join(workspace, "b.md")), true);
    assert.equal(readFileSync(join(workspace, "b.md"), "utf8"), "# A\n\nOriginal content.\n");
    assert.equal(existsSync(join(workspace, "a.essaydown.json")), false);
    assert.equal(existsSync(join(workspace, "b.essaydown.json")), true);
    assert.equal(existsSync(join(workspace, "assets", "a")), false);
    assert.equal(existsSync(join(workspace, "assets", "b", "image.png")), true);

    // The renamed file was the open one: the main pane and the persisted-restore key follow it.
    await waitForTextContent('[data-testid="current-file"]', "b.md", 'current-file never became "b.md"');
  });

  it("relaunch (reloadSession, a real process restart) restores the same file", async () => {
    await relaunch();
    await waitForSelector(entrySelector("b.md"), "tree-entry:b.md never appeared after relaunch");
    await waitForTextContent(
      '[data-testid="current-file"]',
      "b.md",
      'current-file never restored to "b.md" after relaunch',
    );
    assert.equal(
      await textContentOf('[data-testid="current-content"]'),
      readFileSync(join(workspace, "b.md"), "utf8"),
    );
  });

  it("clicking a cloudOnly entry shows the tooltip and does not error", async () => {
    await waitForSelector(entrySelector("c.md"), "tree-entry:c.md never appeared");
    await (await browser.$(entrySelector("c.md"))).click();

    await waitForSelector('[data-testid="cloud-tooltip"]', "cloud-tooltip never appeared");
    assert.equal(await textContentOf('[data-testid="cloud-tooltip"]'), "Not downloaded on this device");

    assert.equal(await exists('[data-testid="error"]'), false);
    // The click never attempted to open the placeholder: the main pane still shows the file that
    // was already open before this test, unchanged.
    assert.equal(await textContentOf('[data-testid="current-file"]'), "b.md");
  });
});
