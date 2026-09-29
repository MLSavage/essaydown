import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caretToEndOf, reloadPage, typeText } from "./routes.js";

// The close barrier (task 2.17, DECISIONS #review-2-r0 U2): a keystroke inside the 500 ms autosave
// debounce is on disk after the window closes, and the relaunch (`reloadSession()`, the real
// process restart file-tree.spec.ts uses) reads it back; the file is read byte-exact.
//
// The route to the close: WebDriver's Close Window never reaches the window's close-requested event
// on this leg — WebKitWebDriver closes the page through `webkit_web_view_try_close`, whose `close`
// signal wry 0.55.1 answers with `webview.destroy()` (src/webkitgtk/mod.rs:460), so tao never raises
// CloseRequested (the probe is in the task 2.17 journal; the gap is in docs/V1.1-BACKLOG.md). So
// the spec emits the event the runtime itself emits on CloseRequested, `tauri://close-requested`
// to the `main` window (tauri 2.11.5 src/manager/window.rs:174), through the app's own IPC: that
// proves the wiring — the listener, the flush, the destroy and its permission — and not the native
// title bar. The window going away is asserted before the file is read, so a missing listener (the
// window stays and the debounce saves anyway) cannot pass.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';

async function textContentOf(selector: string): Promise<string> {
  return browser.execute((sel) => document.querySelector(sel)?.textContent ?? "", selector);
}

async function exists(selector: string): Promise<boolean> {
  return browser.execute((sel) => document.querySelector(sel) !== null, selector);
}

describe("the close barrier", () => {
  let workspace: string;
  let doc: string;

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-close-"));
    doc = join(workspace, "a.md");
    writeFileSync(doc, "Hello\n");
    await browser.execute(
      (key, value) => localStorage.setItem(key, value),
      STORAGE_KEY,
      JSON.stringify({ folder: workspace, file: "a.md" }),
    );
    await reloadPage();
    await browser.waitUntil(
      async () => (await textContentOf('[data-testid="current-file"]')) === "a.md" && (await exists(EDITOR)),
      { timeout: 15000, interval: 25, timeoutMsg: "a.md never opened in the editor" },
    );
  });

  it("a keystroke inside the debounce is on disk once close-requested destroys the window, and after a relaunch", async () => {
    await caretToEndOf(EDITOR, `${EDITOR} p`);
    await typeText(EDITOR, "X");
    // Inside the debounce: nothing has been saved yet.
    assert.equal(readFileSync(doc, "utf8"), "Hello\n");
    await browser.execute(() => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } })
        .__TAURI_INTERNALS__;
      void internals.invoke("plugin:event|emit_to", {
        target: { kind: "Window", label: "main" },
        event: "tauri://close-requested",
        payload: null,
      });
    });
    // The app exits with its last window, and WebKitWebDriver then drops the session ("session
    // deleted because of page crash or hang"): an error here is the window gone, too.
    await browser.waitUntil(async () => (await browser.getWindowHandles().catch(() => [])).length === 0, {
      timeout: 10000,
      interval: 25,
      timeoutMsg: "the window was not destroyed after close-requested",
    });
    assert.equal(readFileSync(doc, "utf8"), "HelloX\n");

    await browser.reloadSession();
    await browser.waitUntil(async () => (await textContentOf('[data-testid="current-file"]')) === "a.md", {
      timeout: 15000,
      interval: 25,
      timeoutMsg: "a.md was not restored after the relaunch",
    });
    assert.equal(readFileSync(doc, "utf8"), "HelloX\n");
  });
});
