import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../../../packages/core/src/parse.js";
import { candidatesOf } from "../../../packages/core/src/sidecar.js";
import { caretToEndOf, clickCentreOf, pressModChord, reloadPage } from "./routes.js";

// The mode bar and the store's mode mutations (task 3.1). Acceptance: switching modes 100× never
// changes format(root); an injected store mutation (`window.__essaydown.dispatch(moveBlock(...))`,
// apps/desktop/src/workspace/test-hook.ts) followed by Cmd/Ctrl+Z restores the exact prior Markdown
// and sidecar.
//
// The same constraints as autosave.spec.ts (docs/lessons.md [2.4], [2.5]): every read goes through
// `browser.execute`, never one of the six commands `@wdio/tauri-service` hooks with a ~5 s focus
// check, and every click is a pointer action at a computed point (routes.ts). The workspace is
// seeded through the persisted-restore key and a reload. The document carries a sidecar with one
// coach question per paragraph, so a block move changes the sidecar too and "the exact prior
// sidecar" is a claim the undo can fail.
const STORAGE_KEY = "essaydown:lastWorkspace";
const EDITOR = '[data-testid="editor"] .ProseMirror';
const SOURCE = "Alpha paragraph one.\n\nBeta paragraph two.\n\nGamma paragraph three.\n";
const MOVED = "Beta paragraph two.\n\nGamma paragraph three.\n\nAlpha paragraph one.\n";
const MODES = ["outline", "produce", "rewrite", "reorder"] as const;
const SWITCHES = 100;

interface StoreReadout {
  readonly mode: string | null;
  readonly markdown: string;
  readonly sidecar: string;
  readonly snapshots: number;
  readonly editorText: string;
}

/** The app's mode, the store's snapshot and the rendered editor's text, in one execute. */
async function readout(): Promise<StoreReadout> {
  return browser.execute((editorSel) => {
    const hook = (window as unknown as { __essaydown?: Record<string, () => unknown> }).__essaydown;
    if (hook === undefined) throw new Error("window.__essaydown is not installed");
    return {
      mode: document.querySelector('[data-testid="app-shell"]')?.getAttribute("data-mode") ?? null,
      markdown: hook.markdown() as string,
      sidecar: hook.sidecar() as string,
      snapshots: hook.snapshots() as number,
      editorText: document.querySelector(editorSel)?.textContent ?? "",
    };
  }, EDITOR);
}

async function textContentOf(selector: string): Promise<string> {
  return browser.execute((sel) => document.querySelector(sel)?.textContent ?? "", selector);
}

async function exists(selector: string): Promise<boolean> {
  return browser.execute((sel) => document.querySelector(sel) !== null, selector);
}

async function openThroughRestore(folder: string, file: string): Promise<void> {
  await browser.execute((key, value) => localStorage.setItem(key, value), STORAGE_KEY, JSON.stringify({ folder, file }));
  await reloadPage();
  await browser.waitUntil(
    async () =>
      (await textContentOf('[data-testid="current-file"]')) === file &&
      (await exists(EDITOR)) &&
      (await browser.execute(() => "__essaydown" in window)),
    { timeout: 15000, interval: 25, timeoutMsg: `${file} never opened in the editor` },
  );
}

/** A valid sidecar with one paragraph-scoped coach question per paragraph of `source`. */
function seededSidecar(source: string): string {
  const coach = candidatesOf(parse(source))
    .filter((one) => one.kind === "paragraph")
    .map((one) => ({
      anchor: { ...one, pos: [...one.pos] },
      scope: "paragraph",
      question: `Why "${one.text}"?`,
      askedAt: "2026-10-05T00:00:00Z",
    }));
  return `${JSON.stringify({ version: 1, headings: [], rewrites: [], coach, orphans: [] }, null, 2)}\n`;
}

describe("mode bar and mode mutations (task 3.1)", () => {
  let workspace: string;
  let doc: string;

  before(async () => {
    workspace = mkdtempSync(join(tmpdir(), "essaydown-modes-"));
    doc = join(workspace, "a.md");
    writeFileSync(doc, SOURCE);
    writeFileSync(join(workspace, "a.essaydown.json"), seededSidecar(SOURCE));
    await openThroughRestore(workspace, "a.md");
  });

  it(`switching modes ${SWITCHES}× by chord and by button never changes format(root)`, async function () {
    this.timeout(240000);
    const before = await readout();
    assert.equal(before.markdown, SOURCE);
    assert.equal(before.mode, "outline");
    // The chords are pressed with the caret in the editor, which binds none of them.
    await caretToEndOf(EDITOR, `${EDITOR} p:first-child`);
    for (let i = 0; i < SWITCHES; i += 1) {
      // Each step lands on a mode other than the current one, so every step is a real switch.
      const target = MODES[(i + 1) % MODES.length];
      if (i % 2 === 0) await pressModChord(String(MODES.indexOf(target) + 1));
      else await clickCentreOf(`[data-testid="mode-${target}"]`);
      const now = await readout();
      assert.equal(now.mode, target, `switch ${i + 1} did not reach ${target}`);
      assert.equal(now.markdown, before.markdown, `switch ${i + 1} (${target}) changed format(root)`);
      assert.equal(now.sidecar, before.sidecar, `switch ${i + 1} (${target}) changed the sidecar`);
      assert.equal(now.snapshots, before.snapshots, `switch ${i + 1} (${target}) pushed an undo snapshot`);
      assert.equal(now.editorText, before.editorText, `switch ${i + 1} (${target}) changed the editor`);
    }
    const pressed = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="mode-bar"] [aria-pressed="true"]')).map(
        (button) => button.getAttribute("data-testid"),
      ),
    );
    assert.deepEqual(pressed, [`mode-${MODES[SWITCHES % MODES.length]}`]);
    // Nothing was saved, because nothing was edited.
    await browser.pause(700);
    assert.equal(readFileSync(doc, "utf8"), SOURCE);
  });

  it("an injected moveBlock is one undo step; Cmd/Ctrl+Z restores the exact prior Markdown and sidecar", async () => {
    await caretToEndOf(EDITOR, `${EDITOR} p:first-child`);
    const before = await readout();
    assert.equal(before.markdown, SOURCE);
    assert.equal(JSON.parse(before.sidecar).coach.length, 3);

    await browser.execute(() => {
      const hook = (window as unknown as { __essaydown: { dispatch(m: unknown): void; moveBlock(a: number, b: number): unknown } })
        .__essaydown;
      hook.dispatch(hook.moveBlock(0, 2));
    });
    const moved = await readout();
    assert.equal(moved.markdown, MOVED);
    assert.notEqual(moved.sidecar, before.sidecar, "the move left the sidecar's anchors where they were");
    assert.equal(moved.snapshots, before.snapshots + 1);
    assert.equal(moved.editorText, "Beta paragraph two.Gamma paragraph three.Alpha paragraph one.");
    await browser.waitUntil(() => readFileSync(doc, "utf8") === MOVED, {
      timeout: 3000,
      interval: 50,
      timeoutMsg: "the moved document never reached the disk",
    });

    await pressModChord("z");
    const undone = await readout();
    assert.equal(undone.markdown, before.markdown);
    assert.equal(undone.sidecar, before.sidecar);
    assert.equal(undone.editorText, before.editorText);
    await browser.waitUntil(() => readFileSync(doc, "utf8") === SOURCE, {
      timeout: 3000,
      interval: 50,
      timeoutMsg: "the undone document never reached the disk",
    });
  });
});
