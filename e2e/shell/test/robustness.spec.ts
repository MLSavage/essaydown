import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scripted robustness session (task 2.8): a folder holding `.icloud` placeholders and a Syncthing
// `.stfolder`, exercised through open/edit/rename/external-change/image-paste in a loop, webview
// console errors and unhandled rejections captured and asserted zero, alongside the app's own
// stderr — already captured into e2e-shell.log by `wdio.conf.ts`'s `captureBackendLogs: true`
// (docs/lessons.md [2.1.g1]), so a Rust panic here either kills the app process (every following
// driver command then fails, red) or shows up in that log for review-set 2.10's "robustness log
// clean" check; nothing further to instrument on the Rust side for this task's own scope.
//
// The task's own words size this a "10-minute" session; CLAUDE.md's mocha timeout is fixed at
// 60 s and docs/lessons.md [2.4]/[2.4 08:17:24Z] (#039) says never raise it, so the session is one
// bounded loop (ROUNDS below) run inside one `it()`, not a literal ten-minute clock — the loop
// exercises every named action every round rather than running fewer, longer rounds. Every click
// goes through `clickCentreOf` (a real pointer action, never a hooked WebdriverIO command:
// `$`/`findElement`/`findElements`/`elementClick`/`getTitle` each cost ~5-6 s here per
// `@wdio/tauri-service`'s `ensureActiveWindowFocus` check, docs/lessons.md [2.4]); every poll reads
// through `browser.execute`. Byte-exact assertions on file contents, never a normalising matcher
// (DECISIONS #022).
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const IMAGE = `${EDITOR} .image-node img`;
const ROUNDS = 6;

// A minimal valid 1x1 transparent PNG (67 bytes) — real bytes, so the webview's own image decoder
// (not a stub) is what proves "renders" (e2e/shell/test/images.spec.ts's constant).
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function exists(selector: string): Promise<boolean> {
  return browser.execute((sel) => document.querySelector(sel) !== null, selector);
}

async function count(selector: string): Promise<number> {
  return browser.execute((sel) => document.querySelectorAll(sel).length, selector);
}

async function textContentOf(selector: string): Promise<string> {
  return browser.execute((sel) => document.querySelector(sel)?.textContent ?? "", selector);
}

async function reloadsCount(): Promise<number> {
  const value = await browser.execute(
    () => document.querySelector('[data-testid="document"]')?.getAttribute("data-reloads") ?? "-1",
  );
  return Number(value);
}

async function waitFor(predicate: () => Promise<boolean>, timeout: number, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(predicate, { timeout, interval: 25, timeoutMsg });
}

function entrySelector(path: string): string {
  return `[data-testid="tree-entry:${path}"]`;
}

async function openThroughRestore(folder: string, file: string): Promise<void> {
  await browser.execute(
    (key, value) => localStorage.setItem(key, value),
    STORAGE_KEY,
    JSON.stringify({ folder, file }),
  );
  await browser.execute(() => location.reload());
  await waitFor(
    async () => (await textContentOf('[data-testid="current-file"]')) === file && (await exists(EDITOR)),
    15000,
    `${file} never opened in the editor`,
  );
}

/** A real mouse click at the centre of `selector`'s bounding rect (e2e/shell/test/autosave.spec.ts's
 * "click at a computed point" route — never a hooked `$().click()`, CLAUDE.md, DECISIONS #022). */
async function clickCentreOf(selector: string): Promise<void> {
  const centre = await browser.execute((sel) => {
    const rect = document.querySelector(sel)?.getBoundingClientRect();
    return rect === undefined ? null : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, selector);
  assert.ok(centre !== null, `${selector} is not on the page`);
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ x: Math.round(centre.x), y: Math.round(centre.y), origin: "viewport" })
    .down({ button: 0 })
    .up({ button: 0 })
    .perform();
}

/** Click into `selector` and move the caret to the end of that one-line block (arrow keys reach a
 * one-line block's edges on every OS, DECISIONS #022 — never Home/End in a contenteditable). */
async function caretToEndOf(selector: string): Promise<void> {
  await clickCentreOf(selector);
  await browser.keys(["ArrowDown"]);
}

/** Dispatches a `paste` event carrying one image `File` directly on the editor's own DOM element
 * (e2e/shell/test/images.spec.ts's route: `clipboardData` defined on a plain `Event`, since a real
 * `ClipboardEvent`'s init field is Chromium-only and this is a WebKitGTK build). */
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

/** Types `name` into the already-open rename input (`e2e/shell/test/file-tree.spec.ts`'s proven
 * route: `RenameInput`'s own mount effect already selected its text, so typing replaces it),
 * retrying a fresh select-all + retype up to 5 times if a dropped keystroke — this container's
 * WebKitGTK occasionally drops one character of a run this long, confirmed by instrumenting the
 * input's own `value` mid-round — left the value short of `name`. Never a value set on the DOM
 * directly: every character still goes through a real `browser.keys` call. */
async function typeRenameTo(name: string): Promise<void> {
  const RENAME_INPUT = '[data-testid="rename-input"]';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await browser.execute((sel) => (document.querySelector(sel) as HTMLInputElement | null)?.select(), RENAME_INPUT);
    await browser.keys(name);
    const value = await browser.execute(
      (sel) => (document.querySelector(sel) as HTMLInputElement | null)?.value ?? null,
      RENAME_INPUT,
    );
    if (value === name) return;
  }
  assert.fail(`the rename input never held exactly "${name}" after 5 attempts`);
}

/** Every `unhandledrejection` and window `error` seen since the listener was installed in
 * `before()`, read back through `browser.execute` (never WebdriverIO's own `getLogs`, which
 * WebKitWebDriver does not implement). */
async function capturedErrors(): Promise<string[]> {
  return browser.execute(() => (window as unknown as { __robustnessErrors: string[] }).__robustnessErrors ?? []);
}

describe("shell robustness: .icloud/.stfolder noise, looped open/edit/rename/external-change/image-paste", () => {
  let workspace: string;
  let sessionADoc: string;

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-robustness-"));
    sessionADoc = join(workspace, "session-a.md");
    writeFileSync(sessionADoc, "# Session A\n\nAlpha.\n");
    writeFileSync(join(workspace, "b.md"), "# B\n\nBravo.\n");
    // `.icloud` placeholders: `list_tree` reports these as `cloud-1.md`/`cloud-2.md`,
    // `cloudOnly: true` (task 2.2, apps/desktop/src-tauri/src/workspace.rs).
    writeFileSync(join(workspace, "cloud-1.md.icloud"), "");
    writeFileSync(join(workspace, "cloud-2.md.icloud"), "");
    // A Syncthing `.stfolder`: any dot-component is skipped by both `list_tree` and the watcher
    // (apps/desktop/src-tauri/src/workspace.rs's `walk_markdown`, src/watch.rs's
    // `changed_documents`), so this and its contents must never reach the tree or the sync layer.
    mkdirSync(join(workspace, ".stfolder"), { recursive: true });
    writeFileSync(join(workspace, ".stfolder", "index"), "syncthing-index-placeholder");

    await openThroughRestore(workspace, "session-a.md");
    await browser.execute(() => {
      (window as unknown as { __robustnessErrors: string[] }).__robustnessErrors = [];
      window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
        (window as unknown as { __robustnessErrors: string[] }).__robustnessErrors.push(
          `unhandledrejection: ${String(event.reason)}`,
        );
      });
      window.addEventListener("error", (event: ErrorEvent) => {
        (window as unknown as { __robustnessErrors: string[] }).__robustnessErrors.push(`error: ${event.message}`);
      });
    });
  });

  it("the Syncthing .stfolder and its contents never appear in the tree", async () => {
    const treeEntries = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid^="tree-entry:"]')).map((element) =>
        element.getAttribute("data-testid"),
      ),
    );
    assert.equal(
      treeEntries.some((testId) => testId?.includes(".stfolder")),
      false,
      `a .stfolder entry leaked into the tree: ${JSON.stringify(treeEntries)}`,
    );
    assert.equal(await exists('[data-testid="error"]'), false);
  });

  it(`runs ${ROUNDS} rounds of open/edit/rename/external-change/image-paste against the .icloud-noisy workspace`, async () => {
    let renameName = "b.md";
    for (let round = 1; round <= ROUNDS; round += 1) {
      const label = `round ${round}`;

      // open (re-opens session-a.md every round, including while it is already the open file —
      // App.tsx's openFile always flushes and remounts the pane, so this repeats "open" for real)
      await clickCentreOf(entrySelector("session-a.md"));
      await waitFor(
        async () => (await textContentOf('[data-testid="current-file"]')) === "session-a.md" && (await exists(EDITOR)),
        5000,
        `${label}: session-a.md never (re)opened`,
      );

      // edit
      await caretToEndOf(`${EDITOR} p:last-child`);
      const marker = `R${round}`;
      await browser.keys(marker);
      await browser.pause(700); // past the 500 ms autosave debounce (task 2.5)
      assert.ok(readFileSync(sessionADoc, "utf8").includes(marker), `${label}: edit "${marker}" never reached disk`);

      // external change onto the now-clean document: a silent reload, not a conflict (task 2.5)
      const reloadsBefore = await reloadsCount();
      const t0 = Date.now();
      const externalLine = `External change, ${label}.`;
      writeFileSync(sessionADoc, `${readFileSync(sessionADoc, "utf8")}\n${externalLine}\n`);
      await waitFor(
        async () => (await textContentOf(EDITOR)).includes(externalLine),
        1200,
        `${label}: the external change never became visible`,
      );
      assert.ok(Date.now() - t0 < 1200);
      assert.equal(await reloadsCount(), reloadsBefore + 1);
      assert.equal(await exists('[data-testid="conflict-banner"]'), false);

      // image paste
      const imagesBefore = await count(IMAGE);
      await pasteImage(PNG_1X1_BASE64, "image/png");
      await waitFor(
        async () => (await count(IMAGE)) === imagesBefore + 1,
        5000,
        `${label}: the pasted image never appeared`,
      );
      await browser.pause(700); // past the autosave debounce again
      assert.match(
        readFileSync(sessionADoc, "utf8"),
        /!\[\]\(assets\/session-a\/[^)]+\)/,
        `${label}: no relative assets/session-a/… path on disk`,
      );

      // exercise an .icloud placeholder: a tooltip only, never an open attempt (task 2.4)
      const cloudEntry = round % 2 === 1 ? "cloud-1.md" : "cloud-2.md";
      await clickCentreOf(entrySelector(cloudEntry));
      await waitFor(async () => exists('[data-testid="cloud-tooltip"]'), 3000, `${label}: cloud-tooltip never appeared`);
      assert.equal(await textContentOf('[data-testid="cloud-tooltip"]'), "Not downloaded on this device");
      assert.equal(await textContentOf('[data-testid="current-file"]'), "session-a.md");

      // rename the noise file via F2, ping-ponging its name (task 2.3/2.4)
      const oldName = renameName;
      const nextName = oldName === "b.md" ? "c.md" : "b.md";
      await clickCentreOf(entrySelector(oldName));
      await waitFor(
        async () => (await textContentOf('[data-testid="current-file"]')) === oldName,
        5000,
        `${label}: ${oldName} never opened`,
      );
      await browser.keys(["F2"]);
      await waitFor(async () => exists('[data-testid="rename-input"]'), 3000, `${label}: rename-input never appeared`);
      await typeRenameTo(nextName);
      await browser.keys(["Enter"]);
      await waitFor(async () => exists(entrySelector(nextName)), 5000, `${label}: ${nextName} never appeared`);
      assert.equal(await exists(entrySelector(oldName)), false);
      renameName = nextName;

      assert.equal(await exists('[data-testid="error"]'), false, `${label}: an error banner appeared`);
      assert.deepEqual(await capturedErrors(), [], `${label}: a webview error or unhandled rejection was captured`);
    }
  });

  it("zero unhandled promise rejections or window errors were captured across the whole session", async () => {
    assert.deepEqual(await capturedErrors(), []);
    assert.equal(await exists('[data-testid="error"]'), false);
  });
});
