import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caretToEndOf,
  clickCentreOf,
  deleteBackward,
  driverProvider,
  placeCaret,
  reloadPage,
  setRenameField,
  typeText,
} from "./routes.js";

// One guard per input route in e2e/shell/test/routes.ts (task 2.12), run on whichever leg the
// harness drives (wdio.conf.ts's provider). Each case can fail on its route alone: on the embedded
// leg, reverting a route to the external one turns exactly its case red (the mutations are recorded
// in the journal). Every read goes through `browser.execute` (docs/lessons.md [2.4]); every file
// comparison is byte-exact.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const BLOCK = `${EDITOR} p`;
// One line whose text runs past its block's horizontal centre (asserted below), so a caret route
// that is really a click at the block's centre lands inside the text, not at its end.
const LINE = "Hello there, this one line runs past the middle.";

async function textContentOf(selector: string): Promise<string> {
  return browser.execute((sel) => document.querySelector(sel)?.textContent ?? "", selector);
}

async function exists(selector: string): Promise<boolean> {
  return browser.execute((sel) => document.querySelector(sel) !== null, selector);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(predicate, { timeout: 5000, interval: 25, timeoutMsg });
}

describe(`input routes (${driverProvider} provider)`, () => {
  let workspace: string;
  let doc: string;

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-routes-"));
    doc = join(workspace, "a.md");
    writeFileSync(doc, `${LINE}\n`);
    writeFileSync(join(workspace, "r.md"), "# R\n");
    await browser.execute(
      (key, value) => localStorage.setItem(key, value),
      STORAGE_KEY,
      JSON.stringify({ folder: workspace, file: "a.md" }),
    );
  });

  it("reload: one WebDriver Refresh and no execute script, the old document gone, the app back from the restore key", async () => {
    await browser.execute(() => {
      (window as unknown as { __routesMarker?: boolean }).__routesMarker = true;
    });
    // The embedded provider's execute/sync stores a script's result in a window variable and polls
    // it; a reload started inside the script wipes that variable, and on WebView2 the poll then
    // hangs to the script timeout. WebKitGTK here wins that race, so the hang cannot be shown in
    // the container; what the route owes is that it never runs a script at all.
    const commands: string[] = [];
    const record = ({ command }: { command: string }): void => {
      commands.push(command);
    };
    browser.on("command", record);
    try {
      await reloadPage();
    } finally {
      browser.off("command", record);
    }
    assert.deepEqual(
      commands.filter((command) => command === "refresh" || command.startsWith("execute")),
      ["refresh"],
    );
    await waitFor(
      async () => (await browser.execute(() => (window as unknown as { __routesMarker?: boolean }).__routesMarker ?? null)) === null,
      "the old document (and its marker) survived the reload",
    );
    await waitFor(
      async () => (await textContentOf('[data-testid="current-file"]')) === "a.md" && (await exists(BLOCK)),
      "a.md never opened after the reload",
    );
  });

  it("caret-to-end: typing after the route lands at the block's end, not where the caret was", async () => {
    const shape = await browser.execute((sel) => {
      const block = document.querySelector(sel) as HTMLElement;
      const range = document.createRange();
      range.selectNodeContents(block);
      const text = range.getBoundingClientRect();
      const box = block.getBoundingClientRect();
      return { pastCentre: text.right > box.left + box.width / 2, lines: range.getClientRects().length };
    }, BLOCK);
    assert.deepEqual(shape, { pastCentre: true, lines: 1 });
    await placeCaret(EDITOR, BLOCK, "start"); // a caret the route under test has to move
    await caretToEndOf(EDITOR, BLOCK);
    await typeText(EDITOR, "X");
    await waitFor(async () => (await textContentOf(BLOCK)) !== LINE, "nothing was typed");
    assert.equal(await textContentOf(BLOCK), `${LINE}X`);
  });

  it("typing: text typed at the caret reaches the document and the disk", async () => {
    await caretToEndOf(EDITOR, BLOCK);
    await typeText(EDITOR, "Y");
    await browser.pause(700); // past the 500 ms autosave debounce (task 2.5)
    assert.equal(await textContentOf(BLOCK), `${LINE}XY`);
    assert.equal(readFileSync(doc, "utf8"), `${LINE}XY\n`);
  });

  it("delete: the character before the caret leaves the document and the disk", async () => {
    await caretToEndOf(EDITOR, BLOCK);
    await deleteBackward(EDITOR);
    await browser.pause(700);
    assert.equal(await textContentOf(BLOCK), `${LINE}X`);
    assert.equal(readFileSync(doc, "utf8"), `${LINE}X\n`);
  });

  it("click: a click at a tree row's centre opens it and leaves the row focused", async () => {
    const row = '[data-testid="tree-entry:r.md"]';
    await clickCentreOf(row);
    await waitFor(async () => (await textContentOf('[data-testid="current-file"]')) === "r.md", "r.md never opened");
    assert.equal(
      await browser.execute((sel) => document.activeElement === document.querySelector(sel), row),
      true,
    );
  });

  it("rename: F2 on the focused row, the field set to the new name, Enter renames exactly to it", async () => {
    await browser.keys(["F2"]);
    await waitFor(async () => exists('[data-testid="rename-input"]'), "rename-input never appeared");
    await setRenameField("s.md");
    assert.equal(
      await browser.execute(
        () => (document.querySelector('[data-testid="rename-input"]') as HTMLInputElement | null)?.value ?? null,
      ),
      "s.md",
    );
    await browser.keys(["Enter"]);
    await waitFor(async () => exists('[data-testid="tree-entry:s.md"]'), "tree-entry:s.md never appeared");
    assert.equal(existsSync(join(workspace, "r.md")), false);
    assert.equal(readFileSync(join(workspace, "s.md"), "utf8"), "# R\n");
  });
});
