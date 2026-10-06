import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caretAtText,
  caretToEndOf,
  clickCentreOf,
  deleteBackward,
  driverProvider,
  editableTextOf,
  MOD_KEY,
  placeCaret,
  pressModChord,
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

// Task 3.21's guard (b): a heading the reveal plugin draws a `# ` marker widget into once the caret
// enters it, beside a paragraph with no marks.
const HEADED = "# Hello\n\nPlain words here.\n";
const HEADING = `${EDITOR} h1`;

async function markdown(): Promise<string> {
  return browser.execute(() => {
    const hook = (window as unknown as { __essaydown?: { markdown: () => string } }).__essaydown;
    return hook === undefined ? "" : hook.markdown();
  });
}

async function opened(file: string, block: string): Promise<boolean> {
  return (await textContentOf('[data-testid="current-file"]')) === file && (await exists(block));
}

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
    writeFileSync(join(workspace, "h.md"), HEADED);
    await browser.execute(
      (key, value) => localStorage.setItem(key, value),
      STORAGE_KEY,
      JSON.stringify({ folder: workspace, file: "a.md" }),
    );
  });

  it("reload: the first execute after reloadPage runs on the new document, though readiness was already true on the old one", async () => {
    // Task 3.21 (c): the same file restored twice, so the readiness predicate below is already true
    // on the old document. The embedded provider's Refresh returns before the old document is gone,
    // so without the route's own wait the next execute runs on the old document (or dies with it).
    // WebKitGTK here wins that race (docs/lessons.md [2.12]); the macOS e2e-shell leg loses it.
    await reloadPage();
    await waitFor(async () => opened("a.md", BLOCK), "a.md never opened from the restore key");
    await browser.execute(() => {
      (window as unknown as { __routesMarker?: boolean }).__routesMarker = true;
    });
    assert.equal(await opened("a.md", BLOCK), true, "readiness is not already true before the reload");
    await reloadPage();
    assert.equal(
      await browser.execute(() => (window as unknown as { __routesMarker?: boolean }).__routesMarker ?? null),
      null,
      "the first execute after reloadPage ran on the old document",
    );
    await waitFor(async () => opened("a.md", BLOCK), "a.md never opened after the reload");
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

  it("mod chord: Cmd/Ctrl+Enter reaches the focused element as Enter with the platform's modifier only", async () => {
    // Task 3.21 (a): the embedded provider builds a named key's KeyboardEvent with no modifier flags.
    await browser.execute(() => {
      const w = window as unknown as { __routesKeys?: { key: string; metaKey: boolean; ctrlKey: boolean }[] };
      w.__routesKeys = [];
      (document.activeElement as HTMLElement | null)?.blur();
      window.addEventListener(
        "keydown",
        (event) => w.__routesKeys?.push({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey }),
        { capture: true },
      );
    });
    await pressModChord("Enter");
    const keys = await browser.execute(
      () => (window as unknown as { __routesKeys?: { key: string; metaKey: boolean; ctrlKey: boolean }[] }).__routesKeys ?? [],
    );
    assert.deepEqual(
      keys.filter((one) => one.key === "Enter"),
      [{ key: "Enter", metaKey: MOD_KEY === "Meta", ctrlKey: MOD_KEY === "Control" }],
    );
  });

  it("plain-text coordinate: a heading's end, read and placed with the caret in another block, takes the typed text", async () => {
    // Task 3.21 (b): the heading's `# ` marker widget appears once the caret enters it, so a route
    // that counts widget text re-applies its offset two characters early on the next poll.
    const PARAGRAPH = `${EDITOR} p`;
    await browser.execute((key, value) => localStorage.setItem(key, value), STORAGE_KEY, JSON.stringify({ folder: workspace, file: "h.md" }));
    await reloadPage();
    await waitFor(async () => (await opened("h.md", HEADING)) && (await markdown()) === HEADED, "h.md never opened");
    await caretAtText(EDITOR, PARAGRAPH, 0); // the caret first in another block
    const heading = await editableTextOf(HEADING);
    await caretAtText(EDITOR, HEADING, heading.length);
    await typeText(EDITOR, "X");
    await waitFor(async () => (await markdown()) !== HEADED, "nothing was typed");
    assert.equal(await markdown(), "# HelloX\n\nPlain words here.\n");
    // presence: with the caret in the heading, its textContent holds the revealed marker and the
    // plain-text coordinate does not.
    const revealed = await textContentOf(HEADING);
    assert.equal(await editableTextOf(HEADING), "HelloX");
    assert.notEqual(revealed, "HelloX");
    assert.ok(revealed.includes("#"), `the heading's marker is not revealed: ${JSON.stringify(revealed)}`);
    // absence: a paragraph with no marks reads the same both ways.
    assert.equal(await editableTextOf(PARAGRAPH), await textContentOf(PARAGRAPH));
    assert.equal(await editableTextOf(PARAGRAPH), "Plain words here.");
  });

  it("click focus: a click whose handler re-renders the point leaves focus where the press landed, not on what the re-render drew there", async () => {
    // Task 3.21: 'Use this' re-renders its Rewrite card, and a route that resolved focus after the
    // click focused the variant radio drawn under the stale point, so Cmd/Ctrl+Z went to the radio.
    // Here the button replaces itself with a text field at the same place.
    await browser.execute(() => {
      const host = document.createElement("div");
      host.id = "route-guard";
      host.style.cssText = "position:fixed;left:20px;top:20px;z-index:2147483647;background:#fff";
      const button = document.createElement("button");
      button.id = "route-guard-button";
      button.textContent = "Press";
      button.style.cssText = "width:120px;height:40px";
      button.addEventListener("click", () => {
        const field = document.createElement("input");
        field.id = "route-guard-field";
        field.style.cssText = "width:120px;height:40px;box-sizing:border-box";
        button.replaceWith(field);
      });
      host.append(button);
      document.body.append(host);
    });
    try {
      await clickCentreOf("#route-guard-button");
      await waitFor(() => exists("#route-guard-field"), "the button's click handler never ran");
      assert.notEqual(await browser.execute(() => document.activeElement?.id ?? ""), "route-guard-field");
    } finally {
      await browser.execute(() => document.getElementById("route-guard")?.remove());
    }
  });

  it("click focus: a click on nothing focusable takes focus off the field that had it", async () => {
    // Task 3.21: a native press on non-focusable content moves focus off the focused element; the
    // embedded route, which does the press's focus default itself, blurs it.
    await browser.execute(() => {
      const host = document.createElement("div");
      host.id = "route-guard";
      host.style.cssText = "position:fixed;left:20px;top:20px;z-index:2147483647;background:#fff";
      const field = document.createElement("input");
      field.id = "route-guard-field";
      const plain = document.createElement("div");
      plain.id = "route-guard-plain";
      plain.textContent = "Plain";
      plain.style.cssText = "width:120px;height:40px";
      host.append(field, plain);
      document.body.append(host);
      field.focus();
    });
    try {
      assert.equal(await browser.execute(() => document.activeElement?.id ?? ""), "route-guard-field");
      await clickCentreOf("#route-guard-plain");
      assert.notEqual(await browser.execute(() => document.activeElement?.id ?? ""), "route-guard-field");
    } finally {
      await browser.execute(() => document.getElementById("route-guard")?.remove());
    }
  });
});
