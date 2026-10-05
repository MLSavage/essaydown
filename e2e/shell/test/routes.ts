import assert from "node:assert/strict";
import { platform } from "node:os";
import { selectDriverProvider } from "../provider.js";

// Input routes for the shell e2e, keyed on the same provider wdio.conf.ts drives (task 2.12,
// repair 2 of the 2.verifyh GATE-FAILED at a1). A spec never reads the platform itself; it calls
// these.
//
// external (tauri-driver + WebKitWebDriver, linux): every input is native — `browser.keys` goes
// through the WebView's own key handling, and a pointer action is a real click that places a caret.
//
// embedded (tauri-plugin-wdio-webdriver, windows and macOS): every input is synthetic JS. A
// printable key appends to an input's value ignoring its selection and does nothing in a
// contenteditable; a pointer action dispatches untrusted MouseEvents that place no caret; and the
// provider's execute/sync polls a window result variable, which a page reload started from inside
// the script wipes before the poll reads it (the windows hang). So on this branch the caret is put
// at a block's end through the DOM Selection API, text goes in through WebDriver's element send-keys
// (the provider's `execCommand('insertText')` at the current selection), and a rename field is set
// through element set-value. The embedded leg therefore proves DOM → ProseMirror → store → disk;
// only the external leg proves native input. F2/Enter/Escape (keydown events the app handles
// itself) and `clickCentreOf` are the same route on both legs.
export const driverProvider = selectDriverProvider(platform(), process.env.ESSAYDOWN_E2E_DRIVER);
const embedded = driverProvider === "embedded";
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/** Reloads the page and returns once the navigation has completed: WebDriver's own Refresh on both
 * legs, never a reload started from inside an execute script (which returns before the old document
 * is gone, and on the embedded provider wipes the result the execute is polling for). */
export async function reloadPage(): Promise<void> {
  await browser.refresh();
}

/** A real mouse click at the centre of `selector`'s bounding rect (a click at a computed point,
 * CLAUDE.md, DECISIONS #022) — `performActions`, never one of the six commands
 * `@wdio/tauri-service` hooks with a ~5 s focus check (docs/lessons.md [2.4], [2.5]). On the
 * embedded leg the provider's pointer action is a dispatched mousedown/mouseup/click, which runs
 * the click handlers but not a native mousedown's default action, so nothing takes focus and a
 * following F2 goes nowhere; the route then focuses the nearest focusable ancestor of the point,
 * as the provider's own element click does after `el.click()`. */
export async function clickCentreOf(selector: string): Promise<void> {
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
  if (!embedded) return;
  await browser.execute(
    (x, y) => {
      const target = document.elementFromPoint(x, y)?.closest("a[href], button, input, [tabindex], [contenteditable='true']");
      if (target instanceof HTMLElement) target.focus();
    },
    Math.round(centre.x),
    Math.round(centre.y),
  );
}

/** The WebDriver element id of the focused element, which must match `selector` — the editor after
 * the caret route focused it, the rename field after its mount effect focused it. Looked up through
 * `getActiveElement`, never `$()`: `$()` and `findElement` are two of the six commands
 * `@wdio/tauri-service` hooks with a ~5 s focus check each (docs/lessons.md [2.4]), and those ~10 s
 * per lookup, twice a round, overran the robustness session's 60 s. `typeText`/`setRenameField` then
 * send the same WebDriver commands `$(selector).addValue`/`.setValue` would (`elementSendKeys`;
 * `elementClear` then `elementSendKeys`). */
async function focusedElementId(selector: string): Promise<string> {
  const matches = await browser.execute((sel) => document.activeElement?.matches(sel) ?? false, selector);
  assert.ok(matches, `${selector} is not the focused element`);
  const reference = (await browser.getActiveElement()) as unknown as Record<string, string>;
  const id = reference[ELEMENT_KEY];
  assert.ok(typeof id === "string", `getActiveElement returned no element reference for ${selector}`);
  return id;
}

/** Puts the caret at the end of the one-line block `blockSelector` inside the editor `editorSelector`.
 * external: a click into the block, then `ArrowDown`, which reaches a one-line block's end on every
 * OS (DECISIONS #022). embedded: the editor's `focus()`, then `Range.selectNodeContents(block)`
 * collapsed to its end made the document selection, which ProseMirror reads on `selectionchange`.
 * The two are separate scripts and the range is re-applied until a later poll finds it held:
 * focusing the editor makes ProseMirror write its own caret back to the DOM a tick after the focus
 * (after the script has returned), so a range added in the focusing script is overwritten. */
export async function caretToEndOf(editorSelector: string, blockSelector: string): Promise<void> {
  if (!embedded) {
    await clickCentreOf(blockSelector);
    await browser.keys(["ArrowDown"]);
    return;
  }
  await placeCaret(editorSelector, blockSelector, "end");
}

/** Focuses the editor, then puts the DOM caret at `edge` of `blockSelector` and polls until it
 * stays there (see `caretToEndOf`). Exported for the caret guard, which needs a start caret the
 * route under test has to move. */
export async function placeCaret(editorSelector: string, blockSelector: string, edge: "start" | "end"): Promise<void> {
  const focused = await browser.execute((editorSel) => {
    const editor = document.querySelector(editorSel);
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return true;
  }, editorSelector);
  assert.ok(focused, `${editorSelector} is not on the page`);
  await browser.waitUntil(
    () =>
      browser.execute(
        (blockSel, atEnd) => {
          const block = document.querySelector(blockSel);
          const selection = window.getSelection();
          if (block === null || selection === null) return false;
          if (selection.rangeCount === 1 && selection.isCollapsed && block.contains(selection.anchorNode)) {
            const rest = document.createRange();
            rest.selectNodeContents(block);
            if (atEnd) rest.setStart(selection.anchorNode as Node, selection.anchorOffset);
            else rest.setEnd(selection.anchorNode as Node, selection.anchorOffset);
            if (rest.toString() === "") return true;
          }
          const range = document.createRange();
          range.selectNodeContents(block);
          range.collapse(!atEnd);
          selection.removeAllRanges();
          selection.addRange(range);
          return false;
        },
        blockSelector,
        edge === "end",
      ),
    { timeout: 5000, interval: 50, timeoutMsg: `the caret never stayed at the ${edge} of ${blockSelector}` },
  );
}

/** Types `text` at the editor's caret. external: native key presses. embedded: WebDriver element
 * send-keys on the editor, which the provider turns into `execCommand('insertText')` at the
 * current selection. The caret route leaves the editor focused. */
export async function typeText(editorSelector: string, text: string): Promise<void> {
  if (!embedded) {
    await browser.keys(text);
    return;
  }
  await browser.elementSendKeys(await focusedElementId(editorSelector), text);
}

/** Sets the open rename field (whose mount effect already focused it and selected its text) to
 * `name`. external: native key presses replace the selection. embedded: WebDriver element
 * set-value (clear, then send-keys), because a synthetic key would append to the value. */
export async function setRenameField(name: string): Promise<void> {
  if (!embedded) {
    await browser.keys(name);
    return;
  }
  const id = await focusedElementId('[data-testid="rename-input"]');
  await browser.elementClear(id);
  await browser.elementSendKeys(id, name);
}

/** Deletes the character before the editor's caret. external: a native `Backspace`. embedded: the
 * provider's synthetic `Backspace` reaches ProseMirror's keymap, whose Backspace commands only
 * join or select nodes and leave a character deletion to the browser's native handling, which an
 * untrusted event never gets — so the route is the editor's focus then `execCommand('delete')`, the
 * same DOM editing command the provider's send-keys uses for insertion. */
export async function deleteBackward(editorSelector: string): Promise<void> {
  if (!embedded) {
    await browser.keys(["Backspace"]);
    return;
  }
  const deleted = await browser.execute((editorSel) => {
    const editor = document.querySelector(editorSel);
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return document.execCommand("delete", false);
  }, editorSelector);
  assert.ok(deleted, `execCommand('delete') did nothing in ${editorSelector}`);
}

/** The platform's Cmd/Ctrl as WebDriver names it: Cmd on macOS, Ctrl elsewhere — the same choice
 * `prosemirror-keymap`'s `Mod-` and the app's mode chords make (apps/desktop/src/modes/modes.ts),
 * so a chord pressed here is the one the app binds and never the other platform's. */
const MOD_KEY = platform() === "darwin" ? "Meta" : "Control";

/** Presses Cmd/Ctrl + `key` (task 3.1: the mode bar's Cmd/Ctrl+1–4 and the store's Cmd/Ctrl+Z) at
 * the focused element. Both legs send it as WebDriver key actions: a keydown the app's own
 * handlers read (like F2/Enter/Escape above), never a caret motion (CLAUDE.md, DECISIONS #022). */
export async function pressModChord(key: string): Promise<void> {
  await browser.keys([MOD_KEY, key]);
}
