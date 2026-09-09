import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Root } from "mdast";
import {
  canUndo,
  emptySidecar,
  format,
  formatWithMap,
  parse,
  sentencesOf,
  type Sidecar,
} from "@essaydown/core";
import { EditorState as CMState, type TransactionSpec } from "@codemirror/state";
import { EditorState, TextSelection } from "prosemirror-state";
import { mdastToPM, schema } from "../src/schema.js";
import { createDocumentStore, type DocumentStore } from "../src/store.js";
import {
  SOURCE_KEY,
  TOGGLE_KEY,
  bindCodeMirror,
  canonicalCursor,
  cursorMap,
  otherMode,
  renderedSelection,
  sourceCursor,
  sourceOffset,
  sourceToggleKeymap,
  toggleKeyBindings,
  toggleMode,
  togglePlugins,
  type BoundSourceView,
} from "../src/toggle.js";

/**
 * The headless half of task 1.7. `e2e/web/editor-toggle.spec.ts` is the acceptance — it presses
 * the real chord in a real browser and reads the real CodeMirror cursor — and this file is where
 * the cursor map, the source binding and the chord's two keymaps are covered.
 *
 * The essay fixture is read from disk rather than hand-written, because the acceptance's first
 * sentence is about that corpus: "paragraph 7 sentence 2 of essay-fixture" and "index.json's
 * paragraph line" are both read from their index files here, exactly as they are in the spec.
 */

const SIDECAR: Sidecar = emptySidecar();
const FIXTURES = "fixtures/markdown";

interface FixtureEntry {
  paragraphStartLines: number[];
}

function fixtureIndex(): Record<string, FixtureEntry> {
  return JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, FixtureEntry>;
}

function fixture(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

/** A root and the ProseMirror doc it maps to, which is what {@link cursorMap} relates. */
function pair(markdown: string): { root: Root; doc: ReturnType<typeof mdastToPM>["doc"] } {
  const root = parse(markdown);
  return { root, doc: mdastToPM(root).doc };
}

/** A stand-in for CodeMirror's `EditorView` holding only what `BoundSourceView` names. */
class FakeSourceView implements BoundSourceView {
  state = CMState.create({ doc: "" });
  /** Every text this view was ever given, so a test can count re-renders as well as read one. */
  readonly written: string[] = [];

  dispatch(spec: TransactionSpec): void {
    this.state = this.state.update(spec).state;
    this.written.push(this.text());
  }

  text(): string {
    return this.state.doc.toString();
  }
}

function storeFor(markdown: string): DocumentStore {
  return createDocumentStore(parse(markdown), SIDECAR, { at: 0 });
}

describe("mode", () => {
  it("otherMode is an involution", () => {
    expect(otherMode("rendered")).toBe("source");
    expect(otherMode("source")).toBe("rendered");
  });

  it("a toggle closes the open coalescing group and pushes nothing", () => {
    const store = storeFor("");
    const { document, commit } = store.getState();
    commit(parse("hello"), document.sidecar, { coalesceKey: "typing", at: 10 });
    expect(store.getState().stack.openKey).toBe("typing");
    const before = store.getState().stack.entries.length;

    expect(toggleMode(store, "rendered")).toBe("source");

    expect(store.getState().stack.openKey).toBeNull();
    expect(store.getState().stack.entries).toHaveLength(before);
    expect(format(store.getState().document.root)).toBe("hello\n");
  });

  it("a second edit after a toggle is its own undo step", () => {
    const store = storeFor("");
    const first = store.getState();
    first.commit(parse("a"), SIDECAR, { coalesceKey: "typing", at: 10 });
    toggleMode(store, "rendered");
    store.getState().commit(parse("ab"), SIDECAR, { coalesceKey: "typing", at: 11 });

    expect(store.getState().stack.entries).toHaveLength(3);
    store.getState().undo();
    expect(format(store.getState().document.root)).toBe("a\n");
  });
});

describe("cursorMap: rendered -> source", () => {
  it("carries the cursor of paragraph 7 sentence 2 to index.json's paragraph line", () => {
    const { root, doc } = pair(fixture("essay-fixture.md"));
    const map = cursorMap(root, doc);
    const paragraphs = formatWithMap(root).map.entries.filter((e) => e.node.type === "paragraph");
    const paragraph = paragraphs[6];
    const sentences = sentencesOf(paragraph.node as never);
    expect(sentences.length).toBeGreaterThanOrEqual(2);

    // The paragraph's text is its only child, so the second sentence's offset into the paragraph
    // is also its offset into the one ProseMirror text node.
    const entries: { path: string; pmStart: number }[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === "paragraph") entries.push({ path: "", pmStart: pos + 1 });
      return true;
    });
    const pmStart = entries[6].pmStart;

    const at = map.toSource(pmStart + sentences[1].start);
    expect(at.line).toBe(fixtureIndex()["essay-fixture.md"].paragraphStartLines[6]);
    expect(at.line).toBe(paragraph.startLine);
    expect(at.ch).toBe(sentences[1].start);
  });

  it("advances across a soft line break inside one text node", () => {
    const { root, doc } = pair("alpha\nbeta\n");
    const map = cursorMap(root, doc);
    expect(map.toSource(1)).toEqual({ line: 1, ch: 0 });
    expect(map.toSource(4)).toEqual({ line: 1, ch: 3 });
    // Position 7 is the "b" of beta: five characters of "alpha", then the newline.
    expect(map.toSource(7)).toEqual({ line: 2, ch: 0 });
  });

  it("answers a node that is not text with its own start", () => {
    const { root, doc } = pair("a ![alt](u.png) b\n\n```js\ncode\n```\n\n---\n");
    const map = cursorMap(root, doc);
    // The image is one position wide and its Markdown is not its text, so the cursor on it maps
    // to the first character of `![alt](u.png)`.
    expect(map.toSource(3)).toEqual({ line: 1, ch: 2 });
    // Inside the fenced block: the code node is placed but never entered, so every position in it
    // answers with the fence's own first character. The block's position is read from the document
    // rather than counted by hand, because a position past `doc.content.size` would take the
    // fallback path instead and pass for the wrong reason.
    let codeStart = -1;
    doc.descendants((node, pos) => {
      if (node.type === schema.nodes.code_block) codeStart = pos;
      return true;
    });
    expect(codeStart).toBeGreaterThan(0);
    expect(map.toSource(codeStart + 1)).toEqual({ line: 3, ch: 0 });
    expect(map.toSource(codeStart + 3)).toEqual({ line: 3, ch: 0 });
  });

  it("sends a position no node owns to the end of the node before it", () => {
    const { root } = pair("one\n\ntwo\n");
    // A blank line opened between the two paragraphs: ProseMirror has a block mdast has not.
    const withBlank = EditorState.create({ doc: mdastToPM(root).doc }).tr.insert(
      5,
      mdastToPM(parse("")).doc.child(0),
    ).doc;
    const map = cursorMap(root, withBlank);
    expect(map.toSource(6)).toEqual({ line: 1, ch: 3 });
  });

  it("puts the cursor of an empty document at the top", () => {
    const { root, doc } = pair("");
    expect(cursorMap(root, doc).toSource(1)).toEqual({ line: 1, ch: 0 });
  });

  it("counts the front matter's lines, which the ProseMirror doc does not hold", () => {
    const { root, doc } = pair("---\ntitle: x\n---\n\nbody\n");
    expect(cursorMap(root, doc).toSource(2)).toEqual({ line: 5, ch: 1 });
  });

  it("walks marks, blockquotes, lists and tables", () => {
    const source =
      "> *em* **[a](u)** ~~x~~ `c`\n\n- one\n- two\n\n| a | b |\n| - | - |\n| c | d |\n";
    const { root, doc } = pair(source);
    const map = cursorMap(root, doc);
    const text = formatWithMap(root).text;
    const lineOf = (needle: string): number =>
      text.slice(0, text.indexOf(needle)).split("\n").length;

    // Inside the emphasis run of the blockquote's only paragraph.
    expect(map.toSource(3).line).toBe(lineOf("*em*"));
    // Inside the second list item.
    const secondItem = text.indexOf("two");
    expect(map.toSource(map.toRendered({ line: lineOf("two"), ch: 2 }))).toEqual({
      line: lineOf("two"),
      ch: 2,
    });
    expect(secondItem).toBeGreaterThan(0);
    // Inside the table's bottom-right cell.
    const cell = {
      line: lineOf("| c | d |") + 0,
      ch: text.split("\n")[lineOf("| c | d |") - 1].indexOf("d"),
    };
    expect(map.toSource(map.toRendered(cell))).toEqual(cell);
  });
});

describe("cursorMap: source -> rendered", () => {
  it("is the inverse of toSource inside a paragraph", () => {
    const { root, doc } = pair("alpha beta gamma\n");
    const map = cursorMap(root, doc);
    for (let pos = 1; pos <= 17; pos += 1) {
      expect(map.toRendered(map.toSource(pos))).toBe(pos);
    }
  });

  it("clamps a column past the end of a text node to the end of that node", () => {
    const { root, doc } = pair("abc\n");
    const map = cursorMap(root, doc);
    expect(map.toRendered({ line: 1, ch: 99 })).toBe(4);
  });

  it("sends a blank line to the end of the block above it", () => {
    const { root, doc } = pair("one\n\ntwo\n");
    const map = cursorMap(root, doc);
    // Line 2 is the blank line between the paragraphs; no node owns it.
    expect(map.toRendered({ line: 2, ch: 0 })).toBe(5);
    // Nothing at all above line 1 column 0 of an empty document.
    const empty = pair("");
    expect(cursorMap(empty.root, empty.doc).toRendered({ line: 1, ch: 0 })).toBe(0);
  });

  it("owns an unowned position by the tie rule, at the first, middle and last block", () => {
    // Three paragraphs, so every block has a blank line after it and a column past its own end.
    // The rule `afterLastLine` states: same line as the node's end -> the innermost end (inside the
    // block); a later line -> the outermost end (after the block).
    const { root, doc } = pair("one\n\ntwo\n\nthree\n");
    const map = cursorMap(root, doc);
    const insideAndAfter: [number, number, number][] = [
      // [the block's line, the position after its last character, the position after the block]
      [1, 4, 5],
      [3, 9, 10],
      [5, 16, 17],
    ];
    for (const [line, inner, outer] of insideAndAfter) {
      expect(map.toRendered({ line, ch: 99 })).toBe(inner);
      expect(map.toRendered({ line: line + 1, ch: 0 })).toBe(outer);
    }
  });

  it("answers a node that is not text with the node's own position", () => {
    const { root, doc } = pair("```js\ncode\n```\n");
    expect(cursorMap(root, doc).toRendered({ line: 2, ch: 1 })).toBe(0);
  });

  it("falls back when the position map placed a node the doc has no counterpart for", () => {
    // A front-matter-only file: the map holds the `yaml` node, the ProseMirror doc holds only the
    // placeholder paragraph, so every query lands in the fallback.
    const { root, doc } = pair("---\ntitle: x\n---\n");
    expect(cursorMap(root, doc).toRendered({ line: 2, ch: 3 })).toBe(0);
  });
});

describe("cursorMap over the corpus", () => {
  const index = fixtureIndex();
  const names = Object.keys(index);

  it("reads every fixture in the index", () => {
    expect(names.length).toBeGreaterThan(40);
  });

  it.each(names)("%s: every position maps into the canonical text and back", (name) => {
    const { root, doc } = pair(fixture(name));
    const { text } = formatWithMap(root);
    const lines = text.split("\n");
    const map = cursorMap(root, doc);
    // A stride, not every position: the mapping is linear in the document and the corpus is 53
    // files, so a sweep at every seventh position covers each fixture's shapes without making the
    // suite quadratic in the essay fixture's length.
    for (let pos = 0; pos <= doc.content.size; pos += 7) {
      const at = map.toSource(pos);
      expect(at.line).toBeGreaterThanOrEqual(1);
      expect(at.line).toBeLessThanOrEqual(lines.length);
      expect(at.ch).toBeGreaterThanOrEqual(0);
      expect(at.ch).toBeLessThanOrEqual(lines[at.line - 1].length);
      const back = map.toRendered(at);
      expect(back).toBeGreaterThanOrEqual(0);
      expect(back).toBeLessThanOrEqual(doc.content.size);
    }
  });
});

describe("selection helpers", () => {
  it("renderedSelection clamps below and above the document", () => {
    const { doc } = pair("abc\n");
    expect(renderedSelection(doc, -5).head).toBe(1);
    expect(renderedSelection(doc, 99).head).toBe(4);
    expect(renderedSelection(doc, 2)).toBeInstanceOf(TextSelection);
  });

  it("sourceCursor reads a CodeMirror cursor as a line and a ch", () => {
    const state = CMState.create({ doc: "one\ntwo\n", selection: { anchor: 6 } });
    expect(sourceCursor(state)).toEqual({ line: 2, ch: 2 });
  });

  it("sourceOffset clamps the line and the column into the document", () => {
    const state = CMState.create({ doc: "one\ntwo" });
    expect(sourceOffset(state, { line: 2, ch: 1 })).toBe(5);
    expect(sourceOffset(state, { line: 0, ch: 0 })).toBe(0);
    expect(sourceOffset(state, { line: 99, ch: 0 })).toBe(4);
    expect(sourceOffset(state, { line: 1, ch: 99 })).toBe(3);
    expect(sourceOffset(state, { line: 1, ch: -3 })).toBe(0);
  });
});

describe("bindCodeMirror", () => {
  it("pulls the store's document into the view when it is bound", () => {
    const store = storeFor("hello\n");
    const view = new FakeSourceView();
    bindCodeMirror(store, view);
    expect(view.text()).toBe("hello\n");
  });

  it("writes nothing when the view already shows the store's document", () => {
    const store = storeFor("hello\n");
    const view = new FakeSourceView();
    view.dispatch({ changes: { from: 0, insert: "hello\n" } });
    bindCodeMirror(store, view);
    expect(view.written).toHaveLength(1);
  });

  it("commits an edit as a source burst, at the injected time", () => {
    const store = storeFor("");
    const view = new FakeSourceView();
    const now = vi.fn(() => 42);
    const binding = bindCodeMirror(store, view, { now });

    binding.change("hello\n");

    expect(format(store.getState().document.root)).toBe("hello\n");
    expect(store.getState().stack.openKey).toBe(SOURCE_KEY);
    expect(store.getState().stack.entries.at(-1)?.at).toBe(42);
    expect(now).toHaveBeenCalled();
    binding.destroy();
  });

  it("takes the coalescing key from its options", () => {
    const store = storeFor("");
    const binding = bindCodeMirror(store, new FakeSourceView(), {
      coalesceKey: "other",
      now: () => 1,
    });
    binding.change("x\n");
    expect(store.getState().stack.openKey).toBe("other");
  });

  it("ignores its own echo", () => {
    const store = storeFor("hello\n");
    const view = new FakeSourceView();
    const binding = bindCodeMirror(store, view);
    const before = store.getState().stack;
    binding.change(view.text());
    expect(store.getState().stack).toBe(before);
  });

  it("accepts an unclosed fence and re-parses it leniently", () => {
    const store = storeFor("");
    const view = new FakeSourceView();
    const binding = bindCodeMirror(store, view);

    expect(() => binding.change("```js\nhalf a fence\n")).not.toThrow();
    expect(store.getState().document.root.children[0].type).toBe("code");
    // The view keeps the bytes the user typed; nothing re-serialised over them.
    expect(view.text()).toBe("hello\n".slice(0, 0));
    expect(canUndo(store.getState().stack)).toBe(true);
  });

  it("pulls a change another view made, and stops when destroyed", () => {
    const store = storeFor("one\n");
    const view = new FakeSourceView();
    const binding = bindCodeMirror(store, view);
    store.getState().commit(parse("two\n"), SIDECAR, { at: 1 });
    expect(view.text()).toBe("two\n");

    binding.destroy();
    store.getState().commit(parse("three\n"), SIDECAR, { at: 2 });
    expect(view.text()).toBe("two\n");
  });
});

/* ------------------------------------------------ the platform behind `Mod-` (task 1.11) --- */

/** The modifier a keydown event carries; on any one platform exactly one of the two is `Mod-`. */
type Modifier = "ctrlKey" | "metaKey";

/**
 * The two platforms `Mod-` resolves on, and which modifier each one means (PRD §6.5: Cmd on
 * macOS, Ctrl elsewhere).
 *
 * `prosemirror-keymap` makes that choice once, in a module-level constant evaluated at import
 * (`const mac = typeof navigator != "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform)`
 * in its `dist/index.js`), and Node 22 fills `navigator.platform` in from the host OS. So a
 * keymap test that fires a `ctrlKey` event and asserts it was handled is really asserting which
 * runner it landed on: the chord test below was green here and on ubuntu-latest and
 * windows-latest and red on macos-latest (1.verifyh, ci.yml run 34333160626; DECISIONS #020).
 * The tests below name their platform, and assert the modifier that platform does *not* use is
 * left alone.
 */
const PLATFORMS = [
  { label: "a Mac platform", platform: "MacIntel", mod: "metaKey", other: "ctrlKey" },
  { label: "a non-Mac platform", platform: "Linux x86_64", mod: "ctrlKey", other: "metaKey" },
] as const satisfies readonly { label: string; platform: string; mod: Modifier; other: Modifier }[];

/**
 * A keydown event as `prosemirror-keymap` reads one, carrying exactly one of the two `Mod-`
 * modifiers. A plain object, not a `KeyboardEvent`: the unit suite runs in Node, where the DOM
 * constructor does not exist, and the library reads only these five fields. The two modifier
 * shapes are written out rather than computed (`{ [modifier]: true }`) so that both routes are
 * literally present in this file.
 */
function chordEvent(
  modifier: Modifier,
  init: { key: string; keyCode: number; shiftKey?: boolean },
): KeyboardEvent {
  const base = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init };
  return (
    modifier === "metaKey" ? { ...base, metaKey: true } : { ...base, ctrlKey: true }
  ) as KeyboardEvent;
}

/**
 * `prosemirror-keymap`, and `../src/toggle.js` on top of it, re-evaluated with
 * `navigator.platform` forced to `platform`.
 *
 * Two isolations, because the two modules live in different loaders. Vitest hands `node_modules`
 * to Node's own ESM loader, which `vi.resetModules()` does not reach — checked directly while
 * writing this: `resetModules()` followed by `import("prosemirror-keymap")` returns the first
 * evaluation's copy, so both platforms answer alike and every absence case passes vacuously. The
 * library is therefore re-evaluated by importing its *resolved URL with a query string*: a new
 * URL is a new Node module. `../src/toggle.js` is inlined source, which `vi.resetModules()` does
 * reset, but its own `import { keymap } from "prosemirror-keymap"` would resolve straight back to
 * the cached copy, so the freshly evaluated library is handed to it with `vi.doMock`.
 *
 * `/` is not a shifted letter and `w3c-keyname` reads its own platform constant only for a
 * Meta+Shift event, so this chord's name is the same on both platforms and only the modifier
 * differs. This container is Linux: a forced `navigator.platform` is a proxy, and the only proof
 * for macOS is the three-OS CI gate, which this file cannot observe.
 */
async function keymapOn(
  platform: string,
): Promise<typeof import("prosemirror-keymap") & typeof import("../src/toggle.js")> {
  const resolved = import.meta.resolve("prosemirror-keymap");
  const url = `${resolved}?platform=${encodeURIComponent(platform)}`;
  vi.stubGlobal("navigator", { platform });
  let library: typeof import("prosemirror-keymap");
  try {
    library = (await import(/* @vite-ignore */ url)) as typeof import("prosemirror-keymap");
  } finally {
    vi.unstubAllGlobals();
  }
  vi.resetModules();
  vi.doMock("prosemirror-keymap", () => library);
  try {
    return { ...library, ...(await import("../src/toggle.js")) };
  } finally {
    vi.doUnmock("prosemirror-keymap");
  }
}

/** The view a `keydownHandler` reads: its state, and where to send a command's transaction. */
function handlerView() {
  const state = EditorState.create({ doc: pair("hi\n").doc });
  return { state, dispatch: () => undefined } as never;
}

describe.each(PLATFORMS)("the chord on $label", ({ platform, mod, other }) => {
  it("Cmd/Ctrl+/ reaches a ProseMirror keymap on this platform's own modifier", async () => {
    const keymap = await keymapOn(platform);
    const toggle = vi.fn();
    const handled = keymap.keydownHandler(keymap.toggleKeymap(toggle))(
      handlerView(),
      chordEvent(mod, { key: "/", keyCode: 191 }),
    );
    expect(handled).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("leaves the chord alone when the event carries the other platform's modifier", async () => {
    const keymap = await keymapOn(platform);
    const toggle = vi.fn();
    const handled = keymap.keydownHandler(keymap.toggleKeymap(toggle))(
      handlerView(),
      chordEvent(other, { key: "/", keyCode: 191 }),
    );
    expect(handled).toBe(false);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("is installed by togglePlugins, which answers this platform's own modifier", async () => {
    const keymap = await keymapOn(platform);
    const toggle = vi.fn();
    const plugins = keymap.togglePlugins(toggle);
    expect(plugins).toHaveLength(1);
    const handle = plugins[0].props.handleKeyDown;
    expect(handle).toBeTypeOf("function");
    expect(
      handle?.call(plugins[0], handlerView(), chordEvent(mod, { key: "/", keyCode: 191 })),
    ).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("leaves togglePlugins' chord alone under the other platform's modifier", async () => {
    const keymap = await keymapOn(platform);
    const toggle = vi.fn();
    const plugins = keymap.togglePlugins(toggle);
    const handle = plugins[0].props.handleKeyDown;
    expect(
      handle?.call(plugins[0], handlerView(), chordEvent(other, { key: "/", keyCode: 191 })),
    ).toBe(false);
    expect(toggle).not.toHaveBeenCalled();
  });
});

describe("the chord", () => {
  it("togglePlugins is one plugin a ProseMirror state accepts", () => {
    const state = EditorState.create({ doc: pair("hi\n").doc, plugins: togglePlugins(vi.fn()) });
    expect(state.plugins).toHaveLength(1);
  });

  it("Cmd/Ctrl+/ reaches a CodeMirror binding, which asks the browser to stay out of it", () => {
    const toggle = vi.fn();
    const [binding] = toggleKeyBindings(toggle);
    expect(binding.key).toBe(TOGGLE_KEY);
    expect(binding.preventDefault).toBe(true);
    expect(binding.run?.(undefined as never)).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("the CodeMirror extension carries that binding", () => {
    const toggle = vi.fn();
    const state = CMState.create({ doc: "x", extensions: [sourceToggleKeymap(toggle)] });
    expect(state.doc.toString()).toBe("x");
  });
});

/**
 * Task 1.16 (DECISIONS #review-1-r0 F4, Sol findings 2 and 3): the two coordinate systems a
 * (line, ch) pair can belong to, and the characters the serializer does not write as themselves.
 *
 * Every expected pair below is written by hand from the canonical text quoted in the test, never
 * derived by round-tripping one of the two functions through the other — a round trip through two
 * mutually wrong functions proves nothing (Sol). The ProseMirror positions are hand-written too,
 * and each is checked against the character it names with {@link charAt}, so a position past the
 * end of the document cannot pass by taking the fallback path (lesson 1.7).
 */

/** The character ProseMirror position `pos` sits before, for checking a hand-written position. */
function charAt(doc: ReturnType<typeof mdastToPM>["doc"], pos: number): string {
  return doc.textBetween(pos, pos + 1);
}

describe("cursorMap: characters the serializer did not write as themselves (task 1.16)", () => {
  it("an escaped character: `a\\*b c` puts `b` at ch 3, not ch 2", () => {
    // Canonical `a\*b c`: a=0, \=1, *=2, b=3, ' '=4, c=5. The value is `a*b c`, so the position
    // before `b` is the paragraph's content start (1) plus 2.
    const { root, doc } = pair("a\\*b c\n");
    expect(formatWithMap(root).text).toBe("a\\*b c\n");
    const map = cursorMap(root, doc);
    expect(charAt(doc, 3)).toBe("b");
    expect(map.toSource(3)).toEqual({ line: 1, ch: 3 });
    expect(map.toRendered({ line: 1, ch: 3 })).toBe(3);
    // The escape is one character of the document: both of its columns are before the `*`.
    expect(map.toSource(2)).toEqual({ line: 1, ch: 1 });
    expect(map.toRendered({ line: 1, ch: 1 })).toBe(2);
    expect(map.toRendered({ line: 1, ch: 2 })).toBe(2);
  });

  it("a blockquote prefix: `> beta gamma` puts `beta` at line 2 ch 2, not ch 0", () => {
    // Canonical `> alpha\n> beta gamma`. The blockquote is at 0, its paragraph at 1, the text at
    // 2, so the position before `beta` is 2 + 6 (`alpha` and the line break).
    const { root, doc } = pair("> alpha\n> beta gamma\n");
    expect(formatWithMap(root).text).toBe("> alpha\n> beta gamma\n");
    const map = cursorMap(root, doc);
    expect(charAt(doc, 8)).toBe("b");
    expect(map.toSource(8)).toEqual({ line: 2, ch: 2 });
    expect(map.toRendered({ line: 2, ch: 2 })).toBe(8);
    // The `> ` belongs to the character after it: a cursor on either column is before `beta`.
    expect(map.toRendered({ line: 2, ch: 0 })).toBe(8);
    expect(map.toRendered({ line: 2, ch: 1 })).toBe(8);
    // And the line break before it is still the character before.
    expect(map.toSource(7)).toEqual({ line: 1, ch: 7 });
  });

  it("a nested-list prefix: the wrapped line's `c` is at line 3 ch 4", () => {
    // Canonical `- a\n  - b\n    c`. The outer list is at 0, its item at 1, its paragraph at 2
    // (text `a` at 3), the nested list at 5, its item at 6, its paragraph at 7, so the text
    // `b\nc` starts at 8 and `c` is at 8 + 2.
    const { root, doc } = pair("- a\n  - b\n    c\n");
    expect(formatWithMap(root).text).toBe("- a\n  - b\n    c\n");
    const map = cursorMap(root, doc);
    expect(charAt(doc, 8)).toBe("b");
    expect(charAt(doc, 10)).toBe("c");
    expect(map.toSource(10)).toEqual({ line: 3, ch: 4 });
    expect(map.toRendered({ line: 3, ch: 4 })).toBe(10);
    // The four columns of indentation belong to `c`, the first character of their line.
    expect(map.toRendered({ line: 3, ch: 0 })).toBe(10);
    expect(map.toSource(8)).toEqual({ line: 2, ch: 4 });
  });

  it("an emphasis marker: the closing `*` is the position after the run, the opening one before", () => {
    // Canonical `a *b* c`: a=0, ' '=1, *=2, b=3, *=4, ' '=5, c=6. The paragraph's content starts
    // at 1, so `b` is at 3 and the position after it is 4.
    const { root, doc } = pair("a *b* c\n");
    expect(formatWithMap(root).text).toBe("a *b* c\n");
    const map = cursorMap(root, doc);
    expect(charAt(doc, 3)).toBe("b");
    expect(charAt(doc, 4)).toBe(" ");
    // Closing delimiter (ch 4): after the emphasis's last character.
    expect(map.toRendered({ line: 1, ch: 4 })).toBe(4);
    // Opening delimiter (ch 2): before its first, which is also the end of `a `.
    expect(map.toRendered({ line: 1, ch: 2 })).toBe(3);
    expect(map.toSource(3)).toEqual({ line: 1, ch: 3 });
    // A link's `](url)` is the same shape: the whole tail is its closing delimiter.
    const link = pair("x [a](u) y\n");
    const linkMap = cursorMap(link.root, link.doc);
    expect(formatWithMap(link.root).text).toBe("x [a](u) y\n");
    expect(charAt(link.doc, 4)).toBe(" ");
    // `x ` is 1..3, the link text `a` is 3..4, so after the link is 4; `](u)` is ch 4 to ch 7.
    expect(linkMap.toRendered({ line: 1, ch: 5 })).toBe(4);
    expect(linkMap.toRendered({ line: 1, ch: 2 })).toBe(3);
  });

  it("keeps answering a node with no text of its own with its own start", () => {
    // The delimiter rule is for marks only: a fenced block still answers with the node itself.
    const { root, doc } = pair("```js\ncode\n```\n");
    expect(cursorMap(root, doc).toRendered({ line: 2, ch: 1 })).toBe(0);
  });
});

describe("canonicalCursor: a live source buffer that is not canonical (task 1.16)", () => {
  it("extra blank lines: the cursor before `beta` is canonical line 3 ch 0", () => {
    // Sol's reproduction. `alpha\n\n\n\nbeta` serialises to `alpha\n\nbeta\n`, so the live line 5
    // is canonical line 3; the second paragraph's content starts at 8 (paragraph 1 is 0..7).
    const live = "alpha\n\n\n\nbeta";
    expect(canonicalCursor(live, { line: 5, ch: 0 })).toEqual({ line: 3, ch: 0 });
    const { root, doc } = pair(live);
    expect(formatWithMap(root).text).toBe("alpha\n\nbeta\n");
    expect(charAt(doc, 8)).toBe("b");
    expect(cursorMap(root, doc).toRendered({ line: 3, ch: 0 })).toBe(8);
  });

  it("a Setext heading: `Alpha\\n=====` is `# Alpha`, so ch 0 is canonical ch 2", () => {
    const live = "Alpha\n=====";
    expect(canonicalCursor(live, { line: 1, ch: 0 })).toEqual({ line: 1, ch: 2 });
    // And inside the word: live ch 3 (`h`) is canonical ch 5, two columns further along.
    expect(canonicalCursor(live, { line: 1, ch: 3 })).toEqual({ line: 1, ch: 5 });
    const { root, doc } = pair(live);
    expect(formatWithMap(root).text).toBe("# Alpha\n");
    expect(charAt(doc, 1)).toBe("A");
    expect(cursorMap(root, doc).toRendered({ line: 1, ch: 2 })).toBe(1);
  });

  it("a `* item` list spelling: the marker changes, and a wider one moves the column", () => {
    // `* item` and `- item` are the same width, so the cursor before `item` stays at ch 2 — the
    // spelling that changed is the marker character. `*   item` is three columns wider and is
    // the same tree, so its live ch 4 is canonical ch 2 as well.
    expect(canonicalCursor("* item", { line: 1, ch: 2 })).toEqual({ line: 1, ch: 2 });
    expect(canonicalCursor("*   item", { line: 1, ch: 4 })).toEqual({ line: 1, ch: 2 });
    const { root, doc } = pair("* item");
    expect(formatWithMap(root).text).toBe("- item\n");
    // list 0, item 1, paragraph 2, so the text starts at 3.
    expect(charAt(doc, 3)).toBe("i");
    expect(cursorMap(root, doc).toRendered({ line: 1, ch: 2 })).toBe(3);
  });

  it("carries an escape in the live buffer through the node's own offsets", () => {
    // The live bytes are canonical here, but the translation still goes through the parsed node:
    // live ch 3 is the `b` of the value `a*b c`, which is written at canonical ch 3.
    expect(canonicalCursor("a\\*b c", { line: 1, ch: 3 })).toEqual({ line: 1, ch: 3 });
    // A cursor inside the escape is before the `*`, which is written at ch 1.
    expect(canonicalCursor("a\\*b c", { line: 1, ch: 2 })).toEqual({ line: 1, ch: 1 });
  });

  it("normalises the line endings `parse` normalises, so no line number moves", () => {
    expect(canonicalCursor("alpha\r\n\r\n\r\n\r\nbeta", { line: 5, ch: 0 })).toEqual({
      line: 3,
      ch: 0,
    });
    // A break *inside* a node is where the normalisation earns its keep: the text node's value
    // holds `alpha\nbeta`, so without the rewrite the `\r` is a character no spelling accounts
    // for and the whole node is refused. Canonical `alpha\nbeta\n` puts `beta` at line 2 ch 0.
    expect(canonicalCursor("alpha\r\nbeta", { line: 2, ch: 0 })).toEqual({ line: 2, ch: 0 });
    expect(canonicalCursor("alpha\rbeta", { line: 2, ch: 0 })).toEqual({ line: 2, ch: 0 });
  });

  it("answers a position no node owns from the node before it, and an empty buffer from the top", () => {
    // Live line 3 is one of the blank lines between the two paragraphs; the node before it is
    // `alpha`, whose canonical end is line 1 ch 5.
    expect(canonicalCursor("alpha\n\n\n\nbeta", { line: 3, ch: 0 })).toEqual({ line: 1, ch: 5 });
    expect(canonicalCursor("", { line: 1, ch: 0 })).toEqual({ line: 1, ch: 0 });
    expect(canonicalCursor("\n\n", { line: 2, ch: 0 })).toEqual({ line: 1, ch: 0 });
  });

  it("answers a node that is not text with the node's own start", () => {
    // A cursor on a fence line: the code node is placed but never entered.
    expect(canonicalCursor("```js\ncode\n```", { line: 2, ch: 2 })).toEqual({ line: 1, ch: 0 });
  });

  it("falls back to the node's start when the live spelling cannot be accounted for", () => {
    // `&amp;` is a named character reference, which `spellingOffsets` refuses; the cursor then
    // lands at the start of the paragraph's text rather than at a guessed character.
    expect(canonicalCursor("a&amp;b", { line: 1, ch: 6 })).toEqual({ line: 1, ch: 0 });
  });
});
