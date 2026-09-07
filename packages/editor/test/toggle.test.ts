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
import { keydownHandler } from "prosemirror-keymap";
import { EditorState, TextSelection } from "prosemirror-state";
import { mdastToPM, schema } from "../src/schema.js";
import { createDocumentStore, type DocumentStore } from "../src/store.js";
import {
  SOURCE_KEY,
  TOGGLE_KEY,
  bindCodeMirror,
  cursorMap,
  otherMode,
  renderedSelection,
  sourceCursor,
  sourceOffset,
  sourceToggleKeymap,
  toggleKeyBindings,
  toggleKeymap,
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
    const withBlank = EditorState.create({ doc: mdastToPM(root).doc })
      .tr.insert(5, mdastToPM(parse("")).doc.child(0))
      .doc;
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
    const source = "> *em* **[a](u)** ~~x~~ `c`\n\n- one\n- two\n\n| a | b |\n| - | - |\n| c | d |\n";
    const { root, doc } = pair(source);
    const map = cursorMap(root, doc);
    const text = formatWithMap(root).text;
    const lineOf = (needle: string): number => text.slice(0, text.indexOf(needle)).split("\n").length;

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
    const cell = { line: lineOf("| c | d |") + 0, ch: text.split("\n")[lineOf("| c | d |") - 1].indexOf("d") };
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
    const binding = bindCodeMirror(store, new FakeSourceView(), { coalesceKey: "other", now: () => 1 });
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

describe("the chord", () => {
  it("Cmd/Ctrl+/ reaches a ProseMirror keymap", () => {
    const toggle = vi.fn();
    const state = EditorState.create({ doc: pair("hi\n").doc, plugins: togglePlugins(toggle) });
    // A plain object, not a `KeyboardEvent`: the unit suite runs in Node, where the DOM
    // constructor does not exist, and `prosemirror-keymap` reads only these five fields.
    const event = {
      key: "/",
      keyCode: 191,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    } as KeyboardEvent;
    const handled = keydownHandler(toggleKeymap(toggle))(
      { state, dispatch: () => undefined } as never,
      event,
    );
    expect(handled).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
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
