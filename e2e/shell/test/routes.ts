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
    const element = document.querySelector(sel);
    if (element === null) return null;
    // Task 3.6's workflow spec is the first to click a page-level control (a mode button) after
    // Produce's own typing has scrolled `.workspace-main` down to follow the caret — without this,
    // a control that scrolled above the viewport reads a negative `rect.top` and the click's
    // computed point goes out of bounds. "nearest" is a no-op for anything already on screen, so
    // every prior call (editor text, dialog fields) keeps its own scroll position.
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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

/** The viewport point at plain-text offset `offset` of `blockSelector` (the left edge of the
 * character there, or the right edge of the one before it at the block's end), vertically centred
 * on its line, after the block is scrolled to the viewport's centre. Computed from a DOM Range over
 * the block's text nodes, so a click there is "a click at a computed point" (DECISIONS #022). */
async function textPoint(blockSelector: string, offset: number): Promise<{ x: number; y: number }> {
  const point = await browser.execute(
    (sel, at) => {
      const block = document.querySelector(sel);
      if (block === null) return null;
      block.scrollIntoView({ block: "center" });
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const nodes: Node[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node);
      let seen = 0;
      for (const [index, node] of nodes.entries()) {
        const length = node.textContent?.length ?? 0;
        if (at < seen + length || (at === seen + length && index === nodes.length - 1)) {
          const local = at - seen;
          const range = document.createRange();
          const atEnd = local === length;
          range.setStart(node, atEnd ? local - 1 : local);
          range.setEnd(node, atEnd ? local : local + 1);
          const rect = range.getClientRects()[0];
          if (rect === undefined) return null;
          return { x: atEnd ? rect.right : rect.left, y: rect.top + rect.height / 2 };
        }
        seen += length;
      }
      return null;
    },
    blockSelector,
    offset,
  );
  assert.ok(point !== null, `offset ${offset} is not in ${blockSelector}`);
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

/** Sets the DOM selection to plain-text offsets `[from, to)` of `blockSelector` and polls until it
 * holds (the embedded leg's caret route; see `placeCaret` for why it is re-applied). */
async function selectDomText(editorSelector: string, blockSelector: string, from: number, to: number): Promise<void> {
  await browser.execute((editorSel) => (document.querySelector(editorSel) as HTMLElement | null)?.focus(), editorSelector);
  await browser.waitUntil(
    () =>
      browser.execute(
        (sel, start, end) => {
          const block = document.querySelector(sel);
          const selection = window.getSelection();
          if (block === null || selection === null) return false;
          const locate = (at: number): [Node, number] | null => {
            const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
            let seen = 0;
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              const length = node.textContent?.length ?? 0;
              if (at <= seen + length) return [node, at - seen];
              seen += length;
            }
            return null;
          };
          const a = locate(start);
          const b = locate(end);
          if (a === null || b === null) return false;
          const range = document.createRange();
          range.setStart(a[0], a[1]);
          range.setEnd(b[0], b[1]);
          if (selection.rangeCount === 1 && selection.toString() === range.toString()) {
            const held = selection.getRangeAt(0);
            if (held.compareBoundaryPoints(Range.START_TO_START, range) === 0 && held.compareBoundaryPoints(Range.END_TO_END, range) === 0) {
              return true;
            }
          }
          selection.removeAllRanges();
          selection.addRange(range);
          return false;
        },
        blockSelector,
        from,
        to,
      ),
    { timeout: 5000, interval: 50, timeoutMsg: `the selection never held at ${from}..${to} of ${blockSelector}` },
  );
}

/** Puts the caret at plain-text offset `offset` of `blockSelector` (task 3.4). external: a native
 * click at the computed point of that offset. embedded: the DOM selection collapsed there. */
export async function caretAtText(editorSelector: string, blockSelector: string, offset: number): Promise<void> {
  if (!embedded) {
    const point = await textPoint(blockSelector, offset);
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x: point.x, y: point.y, origin: "viewport" })
      .down({ button: 0 })
      .up({ button: 0 })
      .perform();
    return;
  }
  await selectDomText(editorSelector, blockSelector, offset, offset);
}

/** Selects plain-text offsets `[from, to)` of `blockSelector` (task 3.4's "retype the sentence").
 * external: a native press at the computed point of `from`, a move to the point of `to` and a
 * release — Blink extends the selection itself. embedded: the DOM selection set over the range. */
export async function selectText(editorSelector: string, blockSelector: string, from: number, to: number): Promise<void> {
  if (!embedded) {
    const start = await textPoint(blockSelector, from);
    const end = await textPoint(blockSelector, to);
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x: start.x, y: start.y, origin: "viewport" })
      .down({ button: 0 })
      .pause(80)
      .move({ x: Math.round((start.x + end.x) / 2), y: Math.round((start.y + end.y) / 2), origin: "viewport" })
      .pause(80)
      .move({ x: end.x, y: end.y, origin: "viewport" })
      .pause(80)
      .up({ button: 0 })
      .perform();
    return;
  }
  await selectDomText(editorSelector, blockSelector, from, to);
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

/** A pointer drag from `from` to `to` (viewport points), task 3.2's Outline tree drag. `@dnd-kit/core`'s
 * PointerSensor starts a drag after 4 px of movement and reads `over` from the render that follows
 * each move, so the drag goes in steps with a pause after each. external: native WebDriver pointer
 * actions (a real press, moves and release). embedded: the provider's pointer actions are
 * synthetic mouse events, which raise no pointer events at all, so the route dispatches the
 * PointerEvents the sensor listens for — `pointerdown` on the element under `from`, then
 * `pointermove`s and a `pointerup` on that same element (bubbling to the document listeners the
 * sensor adds) — one execute per step, so React renders between them. */
export async function dragBetween(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const steps = [
    { x: from.x + 6, y: from.y + 6 },
    { x: Math.round((from.x + to.x) / 2), y: Math.round((from.y + to.y) / 2) },
    { x: to.x, y: to.y - 2 },
    to,
  ];
  if (!embedded) {
    let chain = browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x: from.x, y: from.y, origin: "viewport" })
      .down({ button: 0 })
      .pause(80);
    for (const step of steps) chain = chain.move({ x: step.x, y: step.y, origin: "viewport" }).pause(80);
    await chain.up({ button: 0 }).perform();
    return;
  }
  const fire = (type: string, x: number, y: number): Promise<boolean> =>
    browser.execute(
      (kind, px, py, sx, sy) => {
        const w = window as unknown as { __essaydownDragTarget?: Element };
        if (kind === "pointerdown") w.__essaydownDragTarget = document.elementFromPoint(sx, sy) ?? undefined;
        const target = w.__essaydownDragTarget;
        if (target === undefined) return false;
        target.dispatchEvent(
          new PointerEvent(kind, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: px,
            clientY: py,
            button: 0,
            buttons: kind === "pointerup" ? 0 : 1,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          }),
        );
        return true;
      },
      type,
      x,
      y,
      from.x,
      from.y,
    );
  assert.ok(await fire("pointerdown", from.x, from.y), `nothing under the drag start ${from.x},${from.y}`);
  for (const step of steps) {
    await browser.pause(80);
    await fire("pointermove", step.x, step.y);
  }
  await browser.pause(80);
  await fire("pointerup", to.x, to.y);
}
