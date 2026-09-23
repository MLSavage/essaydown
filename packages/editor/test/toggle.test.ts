import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Root, Yaml } from "mdast";
import {
  COALESCE_WINDOW_MS,
  canRedo,
  canUndo,
  emptySidecar,
  format,
  formatWithMap,
  parse,
  sentencesOf,
  type Sidecar,
} from "@essaydown/core";
import { EditorState as CMState, type TransactionSpec } from "@codemirror/state";
import type { Mark, Node as PMNode } from "prosemirror-model";
import { EditorState, Selection, TextSelection } from "prosemirror-state";
import {
  CELL_LINE_ENDING,
  LINE_ENDING,
  keptCharacters,
  mdastToPM,
  pmToMdast,
  schema,
} from "../src/schema.js";
import { blockAlone, type BlockAlone } from "./block-alone";
import {
  bindProseMirror,
  createDocumentStore,
  undoKeyBindings,
  type BoundView,
  type DocumentStore,
} from "../src/store.js";
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

/**
 * A clock and a timer queue driven by hand, so a burst boundary is an exact place in a test rather
 * than a wall-clock wait. `now` and `schedule` share the same time, which is what makes the `at`
 * the store records and the moment the deferred commit runs agree (task 1.17).
 */
class FakeClock {
  time = 0;
  private tasks: { at: number; run: () => void }[] = [];

  readonly now = (): number => this.time;

  readonly schedule = (run: () => void, ms: number): (() => void) => {
    const task = { at: this.time + ms, run };
    this.tasks.push(task);
    return () => {
      this.tasks = this.tasks.filter((other) => other !== task);
    };
  };

  /** Move `ms` forward and run everything that comes due, in the order it was scheduled. */
  advance(ms: number): void {
    this.time += ms;
    const due = this.tasks.filter((task) => task.at <= this.time);
    this.tasks = this.tasks.filter((task) => task.at > this.time);
    for (const task of due) task.run();
  }

  /** How many timers are still waiting. */
  get waiting(): number {
    return this.tasks.length;
  }
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

/**
 * A stand-in for ProseMirror's `EditorView` holding only what `BoundView` names, so case 5 below
 * can run the same script through the rendered binding. `store.test.ts` has its own, richer copy;
 * this one exists because the comparison belongs beside the source-view case it is about.
 */
class FakeRenderedView implements BoundView {
  state = EditorState.create({ schema });

  updateState(state: EditorState): void {
    this.state = state;
  }
}

/** The transaction that types `text` at the end of `state`'s document. */
function typeAtEnd(state: EditorState, text: string) {
  return state.tr.insertText(text, Selection.atEnd(state.doc).from);
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
    const clock = new FakeClock();
    const binding = bindCodeMirror(store, view, { now: clock.now, schedule: clock.schedule });

    binding.change("hello\n");
    clock.advance(COALESCE_WINDOW_MS);

    expect(format(store.getState().document.root)).toBe("hello\n");
    expect(store.getState().stack.openKey).toBe(SOURCE_KEY);
    // The keystroke's time, not the commit's: `change` ran at 0 and the timer fired a window
    // later, and the entry records the former (DECISIONS #review-1-r1 G2; the grouping rule in
    // `bindCodeMirror`'s doc comment, pinned by cases 3 and 4 below). Before G2 this read
    // `COALESCE_WINDOW_MS`, the moment the deferred commit ran.
    expect(store.getState().stack.entries.at(-1)?.at).toBe(0);
    binding.destroy();
  });

  it("takes the coalescing key from its options", () => {
    const clock = new FakeClock();
    const store = storeFor("");
    const binding = bindCodeMirror(store, new FakeSourceView(), {
      coalesceKey: "other",
      now: clock.now,
      schedule: clock.schedule,
    });
    binding.change("x\n");
    clock.advance(COALESCE_WINDOW_MS);
    expect(store.getState().stack.openKey).toBe("other");
  });

  it("ignores its own echo", () => {
    const clock = new FakeClock();
    const store = storeFor("hello\n");
    const view = new FakeSourceView();
    const binding = bindCodeMirror(store, view, { now: clock.now, schedule: clock.schedule });
    const before = store.getState().stack;
    binding.change(view.text());
    expect(clock.waiting).toBe(0);
    clock.advance(COALESCE_WINDOW_MS);
    expect(store.getState().stack).toBe(before);
  });

  it("accepts an unclosed fence and re-parses it leniently", () => {
    const clock = new FakeClock();
    const store = storeFor("");
    const view = new FakeSourceView();
    const binding = bindCodeMirror(store, view, { now: clock.now, schedule: clock.schedule });

    expect(() => binding.change("```js\nhalf a fence\n")).not.toThrow();
    clock.advance(COALESCE_WINDOW_MS);
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

/**
 * The deferred source commit of task 1.17 (DECISIONS #review-1-r0 F5): `parse` over the whole
 * buffer moves off the keystroke path and onto the burst boundary. One test per guard in the diff,
 * named in the journal — the guards are the schedule itself, the reschedule, the window's source,
 * the echo comparison against the pending text, the two flushes (toggle and unmount), the flush of
 * nothing, and the drop on a pull.
 *
 * Every case drives {@link FakeClock} rather than a real timer: the acceptance is about *which*
 * side of the coalescing window an update falls on, which a wall-clock wait can only approximate.
 */
describe("bindCodeMirror commits on the burst boundary", () => {
  /** A binding on a fresh empty store, with the clock that drives both its timer and its `at`. */
  function bound(markdown = "", options: { coalesceWindowMs?: number } = {}) {
    const clock = new FakeClock();
    const store = createDocumentStore(parse(markdown), SIDECAR, { at: 0, ...options });
    const view = new FakeSourceView();
    const roots: Root[] = [];
    store.subscribe((state) => roots.push(state.document.root));
    const binding = bindCodeMirror(store, view, { now: clock.now, schedule: clock.schedule });
    return { clock, store, view, binding, roots };
  }

  /** The Markdown the store currently holds. */
  function committed(store: DocumentStore): string {
    return format(store.getState().document.root);
  }

  it("nothing is committed while the burst is still inside the window", () => {
    const { clock, store, binding, roots } = bound();

    for (const text of ["w\n", "wo\n", "wor\n", "word\n"]) {
      binding.change(text);
      clock.advance(100);
    }

    expect(roots).toEqual([]);
    expect(committed(store)).toBe("");
    expect(store.getState().stack.entries).toHaveLength(1);
  });

  it("four updates inside the window are one commit and one undo entry", () => {
    const { clock, store, binding, roots } = bound();

    for (const text of ["w\n", "wo\n", "wor\n", "word\n"]) {
      binding.change(text);
      clock.advance(100);
    }
    clock.advance(COALESCE_WINDOW_MS);

    expect(roots).toHaveLength(1);
    expect(committed(store)).toBe("word\n");
    expect(store.getState().stack.entries).toHaveLength(2);
    expect(store.getState().stack.openKey).toBe(SOURCE_KEY);
  });

  it("each update reschedules the one commit rather than adding a timer", () => {
    const { clock, binding } = bound();

    binding.change("a\n");
    expect(clock.waiting).toBe(1);
    binding.change("ab\n");
    binding.change("abc\n");
    expect(clock.waiting).toBe(1);
  });

  it("an update after the window is a second commit and a second undo entry", () => {
    const { clock, store, binding, roots } = bound();

    binding.change("first\n");
    clock.advance(COALESCE_WINDOW_MS);
    expect(roots).toHaveLength(1);
    expect(store.getState().stack.entries).toHaveLength(2);

    clock.advance(1);
    binding.change("first second\n");
    clock.advance(COALESCE_WINDOW_MS);

    expect(roots).toHaveLength(2);
    expect(committed(store)).toBe("first second\n");
    // Two entries beside the seed: the two commits are more than one window apart, so the store
    // opens a new coalescing group for the second exactly as it did per keystroke before.
    expect(store.getState().stack.entries).toHaveLength(3);
    expect(store.getState().stack.entries.at(-2)?.state.root).toBe(roots[0]);
  });

  it("the wait is the stack's own coalescing window, not a constant of its own", () => {
    const { clock, store, binding } = bound("", { coalesceWindowMs: 250 });

    binding.change("x\n");
    clock.advance(249);
    expect(committed(store)).toBe("");
    clock.advance(1);
    expect(committed(store)).toBe("x\n");
  });

  it("a character typed and deleted again inside the window is not taken for an echo", () => {
    const { clock, store, binding } = bound("hello\n");

    binding.change("hellox\n");
    clock.advance(10);
    binding.change("hello\n");
    clock.advance(COALESCE_WINDOW_MS);

    // The pending "hellox" was replaced, not left to be written back over the deletion.
    expect(committed(store)).toBe("hello\n");
  });

  it("flush commits the pending text now, and leaves nothing scheduled", () => {
    const { clock, store, binding, roots } = bound();

    binding.change("typed\n");
    binding.flush();

    expect(committed(store)).toBe("typed\n");
    expect(roots).toHaveLength(1);
    expect(clock.waiting).toBe(0);
    clock.advance(COALESCE_WINDOW_MS);
    expect(roots).toHaveLength(1);
  });

  it("flush with nothing pending pushes nothing", () => {
    const { store, binding } = bound("hello\n");
    const before = store.getState().stack;

    binding.flush();
    binding.flush();

    expect(store.getState().stack).toBe(before);
  });

  it("destroy flushes before it unsubscribes, so an unmount loses nothing", () => {
    const { clock, store, view, binding } = bound();

    binding.change("typed\n");
    binding.destroy();

    expect(committed(store)).toBe("typed\n");
    // And the subscription is gone: a later commit is not pulled into the view.
    store.getState().commit(parse("other\n"), SIDECAR, { at: clock.now() + 5_000 });
    expect(view.text()).not.toBe("other\n");
  });

  /**
   * The call-site guard: `DevEditor`'s toggle flushes *before* `toggleMode` closes the coalescing
   * group. Deleting that line loses nothing typed — the source view unmounts on the same swap and
   * `destroy` flushes — so the only behaviour it changes is the group boundary, and the input that
   * separates the two orders needs a burst already committed with the group still open. That is a
   * pair of bursts inside one 1 s window, which is a clock a browser spec cannot hold steady on
   * three shared runners; it is pinned here instead, where the clock is injected. The pair below
   * is the whole separation: same events, the two orders, one entry against two.
   */
  it("flushing before the mode swap keeps the burst in one undo entry (DevEditor's order)", () => {
    const { clock, store, binding } = bound();

    binding.change("word\n");
    clock.advance(COALESCE_WINDOW_MS);
    const entries = store.getState().stack.entries.length;

    binding.change("word two\n");
    binding.flush();
    toggleMode(store, "source");

    expect(store.getState().stack.entries).toHaveLength(entries);
    expect(store.getState().stack.openKey).toBeNull();
    expect(committed(store)).toBe("word two\n");
  });

  it("flushing after it would open a second entry, which is why the order is the other one", () => {
    const { clock, store, binding } = bound();

    binding.change("word\n");
    clock.advance(COALESCE_WINDOW_MS);
    const entries = store.getState().stack.entries.length;

    binding.change("word two\n");
    toggleMode(store, "source");
    binding.flush();

    expect(store.getState().stack.entries).toHaveLength(entries + 1);
  });

  it("a snapshot arriving from elsewhere drops the pending commit", () => {
    const { clock, store, view, binding, roots } = bound("one\n");

    binding.change("one typed\n");
    store.getState().commit(parse("loaded\n"), SIDECAR, { at: 5_000 });
    expect(view.text()).toBe("loaded\n");

    clock.advance(COALESCE_WINDOW_MS);

    // Two notifications would mean the abandoned text was written over the snapshot that
    // superseded it; the load is the only one.
    expect(roots).toHaveLength(1);
    expect(committed(store)).toBe("loaded\n");
    expect(clock.waiting).toBe(0);
  });
});

/**
 * Undo and Redo from the source view, with a burst still pending (DECISIONS #review-1-r1 G2; Sol
 * finding 2). Two causes, one case per test, each named in the journal:
 *
 * 1. a history command ran against committed history while the burst was still in the CodeMirror
 *    buffer, and the pull the command caused then *dropped* that burst — `undoKeyBindings`'
 *    `beforeHistory` seam settles it first;
 * 2. the deferred commit stamped `at: now()` when it fired rather than the burst's own keystroke
 *    time, so a flushed burst grouped by when the store was read instead of by what was typed.
 *
 * Both are timing, so every case drives {@link FakeClock}: the acceptance is about which side of
 * the coalescing window a keystroke, a flush and a commit fall on, which a wall clock cannot pin.
 * `e2e/web/editor-toggle.spec.ts` presses the two reproductions as real chords in a real browser.
 */
describe("a source-view history command settles the pending burst first", () => {
  /**
   * A source view bound to a fresh store, plus the two chords wired the way `DevEditor` wires
   * them: {@link undoKeyBindings} with the binding's `flush` as its `beforeHistory` hook.
   */
  function boundWithHistory(markdown = "") {
    const clock = new FakeClock();
    const store = createDocumentStore(parse(markdown), SIDECAR, { at: 0 });
    const view = new FakeSourceView();
    const binding = bindCodeMirror(store, view, { now: clock.now, schedule: clock.schedule });
    const [undoBinding, redoBinding] = undoKeyBindings(store, () => binding.flush());
    const press = (key: (typeof undoBinding)["run"]): void => {
      // CodeMirror hands the command its view; these two read only the store and the hook.
      key?.(null as never);
    };
    /**
     * A keystroke as the view really delivers one: the buffer changes, and `DevEditor`'s update
     * listener hands the new text to the binding. Both halves matter here — the surface is what
     * these cases assert, and it is the buffer, not the store, that holds it mid-burst.
     */
    const type = (text: string): void => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      binding.change(view.text());
    };
    return {
      clock,
      store,
      view,
      binding,
      type,
      undo: () => press(undoBinding.run),
      redo: () => press(redoBinding.run),
      markdown: () => format(store.getState().document.root),
      entries: () => store.getState().stack.entries.length,
    };
  }

  it("case 1: a fresh history and an Undo inside the window empties the surface", () => {
    const { clock, view, type, undo, markdown, store } = boundWithHistory();

    type("first\n");
    // The keystrokes are inside the window: nothing is committed yet, and the buffer holds them.
    expect(markdown()).toBe("");
    expect(view.text()).toBe("first\n");
    undo();

    // The burst was committed by the hook and then undone, so the store is back at the seed and
    // the pull rewrote the surface. Without the hook the Undo would have found an empty history,
    // changed nothing, and left "first" on screen for the timer to commit afterwards.
    expect(markdown()).toBe("");
    expect(view.text()).toBe("");
    expect(clock.waiting).toBe(0);
    clock.advance(COALESCE_WINDOW_MS);
    expect(markdown()).toBe("");
    expect(view.text()).toBe("");
    // The Undo was real, so the burst it settled is on the redo side.
    expect(canRedo(store.getState().stack)).toBe(true);
  });

  it("case 2: Undo inside a second burst removes only that burst, and Redo restores it", () => {
    const { clock, view, type, undo, redo, markdown, entries } = boundWithHistory();

    type("first\n");
    clock.advance(COALESCE_WINDOW_MS);
    expect(markdown()).toBe("first\n");

    // More than a window after the first burst's keystrokes, which is what makes the second burst
    // its own undo entry — Sol's reproduction (b) types it 1.2 s later.
    clock.advance(200);
    type("first second\n");
    expect(view.text()).toBe("first second\n");
    undo();

    expect(entries()).toBe(3);
    expect(markdown()).toBe("first\n");
    expect(view.text()).toBe("first\n");

    redo();
    expect(markdown()).toBe("first second\n");
    expect(view.text()).toBe("first second\n");
  });

  it("case 3: a flush inside a burst and more typing inside the window is one undo entry", () => {
    const { clock, binding, type, markdown, entries } = boundWithHistory();

    type("wo\n");
    clock.advance(100);
    // A Copy Markdown, a toggle or a history command partway through the burst.
    binding.flush();
    expect(entries()).toBe(2);

    clock.advance(100);
    type("word\n");
    clock.advance(COALESCE_WINDOW_MS);

    // One burst, one entry: the flushed commit carries the keystroke at 0 and the timed one the
    // keystroke at 200, so they are 200 ms apart and merge. Stamped with `now()` they would have
    // been 100 ms and 1200 ms — 1.1 s apart — and one burst would have become two undo steps.
    expect(entries()).toBe(2);
    expect(markdown()).toBe("word\n");
  });

  it("case 4: two bursts more than a window apart are two entries, flushed or timed", () => {
    for (const ending of ["timed", "flushed"] as const) {
      const { clock, binding, type, markdown, entries, store } = boundWithHistory();

      type("first\n");
      clock.advance(COALESCE_WINDOW_MS);
      expect(entries()).toBe(2);

      clock.advance(200);
      type("first second\n");
      if (ending === "timed") clock.advance(COALESCE_WINDOW_MS);
      else binding.flush();

      // The user typed the second burst 1.2 s after the first, so it is a second step whichever
      // way its commit fired; with `at: now()` the flushed ending landed 0.25 s after the timed
      // commit of the first burst and merged into it, which is how one Undo removed both.
      expect(entries(), ending).toBe(3);
      expect(markdown(), ending).toBe("first second\n");
      expect(store.getState().stack.entries.at(-2)?.state.root).toBe(
        store.getState().stack.entries[1].state.root,
      );
    }
  });

  it("case 5: a pending edit after an Undo is its own entry and Redo is gone, as when rendered", () => {
    const { clock, type, undo, markdown, store } = boundWithHistory();

    type("first\n");
    clock.advance(COALESCE_WINDOW_MS);
    undo();
    expect(canRedo(store.getState().stack)).toBe(true);

    type("other\n");
    clock.advance(COALESCE_WINDOW_MS);

    expect(markdown()).toBe("other\n");
    expect(canRedo(store.getState().stack)).toBe(false);
    expect(store.getState().stack.entries).toHaveLength(2);

    // "As in the rendered view" is asserted, not asserted-by-comment: the same script through
    // `bindProseMirror`, whose commit is synchronous and whose chord needs no flush, ends with the
    // same stack shape. `undo()` here is what the rendered keymap's command calls.
    const renderedStore = createDocumentStore(parse(""), SIDECAR, { at: 0 });
    const renderedView = new FakeRenderedView();
    const renderedClock = new FakeClock();
    const rendered = bindProseMirror(renderedStore, renderedView, { now: renderedClock.now });
    rendered.dispatch(typeAtEnd(renderedView.state, "first"));
    renderedStore.getState().undo();
    expect(canRedo(renderedStore.getState().stack)).toBe(true);
    renderedClock.advance(COALESCE_WINDOW_MS);
    rendered.dispatch(typeAtEnd(renderedView.state, "other"));

    expect(format(renderedStore.getState().document.root)).toBe("other\n");
    expect(canRedo(renderedStore.getState().stack)).toBe(false);
    expect(renderedStore.getState().stack.entries).toHaveLength(2);
    rendered.destroy();
  });
});

/* ------------------------------ a flush inside a longer continuation (task 1.31) ---------- */

describe("a flush inside a continuation that outlasts the window (task 1.31, DECISIONS #review-1-r2 H2)", () => {
  /**
   * The 1.24 harness again — a source view bound to a fresh store, the chords wired with the
   * binding's `flush` as `beforeHistory`, one clock for the timer and the keystroke times — kept
   * beside these cases so the five above stay exactly as task 1.24 wrote them.
   */
  function boundWithHistory(markdown = "") {
    const clock = new FakeClock();
    const store = createDocumentStore(parse(markdown), SIDECAR, { at: 0 });
    const view = new FakeSourceView();
    const binding = bindCodeMirror(store, view, { now: clock.now, schedule: clock.schedule });
    const [undoBinding, redoBinding] = undoKeyBindings(store, () => binding.flush());
    const press = (key: (typeof undoBinding)["run"]): void => {
      key?.(null as never);
    };
    const type = (text: string): void => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      binding.change(view.text());
    };
    return {
      clock,
      store,
      view,
      binding,
      type,
      undo: () => press(undoBinding.run),
      redo: () => press(redoBinding.run),
      markdown: () => format(store.getState().document.root),
      entries: () => store.getState().stack.entries.length,
    };
  }

  /**
   * Sol's continuation: `bcdef` at `gap` ms per character after `a`, every adjacent gap under the
   * window and the whole run longer than one. Sol's own keystroke times were 242, 308, 612, 924,
   * 1237, 1543 ms — a first gap of 66 ms and then 300-odd — so the two commits' keystrokes were
   * 1.3 s apart while no adjacent pair was over 314 ms.
   */
  const CONTINUATION = ["ab", "abc", "abcd", "abcde", "abcdef"];
  const GAP = 300;
  const LONGER_THAN_A_WINDOW = GAP * (CONTINUATION.length - 1);

  it("case (a): a commit, then a continuation longer than the window with every adjacent gap under it, ending by the timer — one undo entry", () => {
    const { clock, binding, type, markdown, entries, store } = boundWithHistory();
    expect(LONGER_THAN_A_WINDOW).toBeGreaterThan(COALESCE_WINDOW_MS);

    type("a");
    clock.advance(66);
    // A Copy Markdown partway through the burst: the first segment is committed here.
    binding.flush();
    expect(entries()).toBe(2);
    expect(store.getState().stack.entries[1].at).toBe(0);

    for (const text of CONTINUATION) {
      type(text);
      clock.advance(GAP);
    }
    // The continuation's own timer fires one window after its last keystroke.
    clock.advance(COALESCE_WINDOW_MS - GAP);
    expect(clock.waiting).toBe(0);

    // One burst, one entry: the continuation's first keystroke (66 ms) is inside the window of
    // the flushed entry's last (0 ms), so it merges although its own last keystroke is 1.3 s on;
    // and the merged entry keeps that last keystroke for the next comparison.
    expect(entries()).toBe(2);
    expect(markdown()).toBe("abcdef\n");
    expect(store.getState().stack.entries[1].at).toBe(66 + LONGER_THAN_A_WINDOW);
  });

  it("case (b): the same continuation ending by a flush (Undo pressed at once) — one entry, so the Undo empties the surface", () => {
    const { clock, binding, type, undo, redo, view, markdown, entries } = boundWithHistory();

    type("a");
    clock.advance(66);
    binding.flush();
    expect(entries()).toBe(2);

    for (const text of CONTINUATION) {
      type(text);
      clock.advance(GAP);
    }
    expect(view.text()).toBe("abcdef");
    // Sol's chord: Undo at once. `beforeHistory` flushes, and the flushed commit carries the
    // continuation's first keystroke as `from`, so it merges into the entry `a` made...
    undo();

    // ...and one Undo takes the whole burst back: both halves are empty, not `a`.
    expect(entries()).toBe(2);
    expect(markdown()).toBe("");
    expect(view.text()).toBe("");
    expect(clock.waiting).toBe(0);

    redo();
    expect(markdown()).toBe("abcdef\n");
    // The pull after a Redo writes the canonical form, newline and all, as 1.24's case 2 shows.
    expect(view.text()).toBe("abcdef\n");
  });

  it("case (c): a continuation whose first keystroke lands more than a window after the previous commit — two entries, timed or flushed (the genuine-gap absence case)", () => {
    for (const ending of ["timed", "flushed"] as const) {
      const { clock, binding, type, markdown, entries, store } = boundWithHistory();

      type("a");
      binding.flush();
      expect(entries(), ending).toBe(2);

      // The user paused: the continuation's first keystroke is one millisecond past the window.
      clock.advance(COALESCE_WINDOW_MS + 1);
      for (const text of CONTINUATION) {
        type(text);
        clock.advance(GAP);
      }
      if (ending === "timed") clock.advance(COALESCE_WINDOW_MS);
      else binding.flush();

      expect(entries(), ending).toBe(3);
      expect(markdown(), ending).toBe("abcdef\n");
      expect(format(store.getState().stack.entries[1].state.root), ending).toBe("a\n");
    }
  });

  it("case (d): the rendered view is unchanged — it commits every keystroke on its own, so `from` is `at` and the grouping is the sliding window it always was", () => {
    // Presence: a burst longer than the window with every adjacent gap under it is one entry.
    const store = createDocumentStore(parse(""), SIDECAR, { at: 0 });
    const view = new FakeRenderedView();
    const clock = new FakeClock();
    const rendered = bindProseMirror(store, view, { now: clock.now });
    for (const letter of "abcdef") {
      rendered.dispatch(typeAtEnd(view.state, letter));
      clock.advance(GAP);
    }
    expect(clock.time).toBeGreaterThan(COALESCE_WINDOW_MS);
    expect(store.getState().stack.entries).toHaveLength(2);
    expect(format(store.getState().document.root)).toBe("abcdef\n");

    // Absence: a keystroke a window and a millisecond after the previous one is a second entry.
    clock.advance(COALESCE_WINDOW_MS + 1 - GAP);
    rendered.dispatch(typeAtEnd(view.state, "g"));
    expect(store.getState().stack.entries).toHaveLength(3);
    rendered.destroy();
  });

  it("the commit carries the segment's first keystroke as `from` and its latest as `at`, and a new segment after a flush opens at its own first keystroke", () => {
    const clock = new FakeClock();
    const store = createDocumentStore(parse(""), SIDECAR, { at: 0 });
    const view = new FakeSourceView();
    const commits: { at: number | undefined; from: number | undefined }[] = [];
    const commit = store.getState().commit;
    store.setState({
      commit: (root, sidecar, options) => {
        commits.push({ at: options?.at, from: options?.from });
        commit(root, sidecar, options);
      },
    });
    const binding = bindCodeMirror(store, view, { now: clock.now, schedule: clock.schedule });

    clock.advance(242);
    binding.change("a");
    clock.advance(66);
    binding.flush();
    binding.change("ab");
    clock.advance(GAP);
    binding.change("abc");
    clock.advance(GAP);
    binding.flush();

    expect(commits).toEqual([
      { at: 242, from: 242 },
      { at: 308 + GAP, from: 308 },
    ]);
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
    // Position 3 is the boundary between `a ` and the run: `$pos.marks()` there is the unmarked
    // side's, so the source caret stays before the opening `*` (ch 2; it was ch 3, inside the
    // delimiter, until task 1.53 — see "a boundary between marked and unmarked text" below).
    expect(map.toSource(3)).toEqual({ line: 1, ch: 2 });
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

/**
 * Every position of `doc` a caret can occupy: the ones whose parent is a textblock, computed from
 * the doc itself (never a literal), so a source's shape decides the set — the positions between
 * blocks are not caret positions and are not in it.
 */
function textPositions(doc: ReturnType<typeof mdastToPM>["doc"]): number[] {
  const positions: number[] = [];
  for (let pos = 0; pos <= doc.content.size; pos += 1) {
    if (doc.resolve(pos).parent.isTextblock) positions.push(pos);
  }
  return positions;
}

/** `(line, ch)` as one number, for the monotonicity check. */
function sourceKey(position: { line: number; ch: number }): number {
  return position.line * 1_000_000 + position.ch;
}

/**
 * The block-end positions after a trailing inline atom: every text position at the end of its
 * textblock whose `nodeBefore` is a non-text atom (an inline `html` node of ProseMirror size 1,
 * which has no spelling table). Computed from the doc, never a literal. Task 1.52 made this
 * position its own inverse (DECISIONS #030 Decision 2); the cases below count it so the two html
 * sources are seen to hold it.
 */
function trailingAtomBlockEnds(doc: ReturnType<typeof mdastToPM>["doc"]): number[] {
  return textPositions(doc).filter((pos) => {
    const $pos = doc.resolve(pos);
    const before = $pos.nodeBefore;
    return (
      $pos.parentOffset === $pos.parent.content.size &&
      before !== null &&
      before.isAtom &&
      !before.isText
    );
  });
}

describe("cursorMap: toRendered ∘ toSource is the identity over every text position (task 1.51, L3 and L4)", () => {
  // The html sources of L3 (a soft line break before an inline tag; inside a mark's
  // neighbourhood; the no-break control) and the inline-code sources of L4 (a span between text,
  // a heading ending in a span, an unpadded and a padded value, a backtick-holding value with a
  // two-backtick fence, an astral value). The position set is computed from each doc.
  //
  // Until task 1.52 the two html sources that end their block in an inline atom excluded that
  // one block-end position by name (DECISIONS #030 Decision 2: the block end after a trailing
  // inline atom is an L5 member, `toSource`'s atom clause in toggle.ts); 1.52 landed the member,
  // so the inverse is asserted over every text position of every source, and the two sources
  // are asserted to hold that position (the presence case), with `position-map-inverse.test.ts`
  // holding the corpus property and the member's own guard.
  const SOURCES: { source: string; trailingAtomEnds: number }[] = [
    { source: "alpha beta\n<span>x</span> gamma\n", trailingAtomEnds: 0 },
    { source: "alpha\n<i>beta</i>\n", trailingAtomEnds: 1 },
    { source: "*a*\n<b>x</b>\n", trailingAtomEnds: 1 },
    { source: "alpha <i>beta</i> gamma\n", trailingAtomEnds: 0 },
    { source: "a `cd` b\n", trailingAtomEnds: 0 },
    { source: "# h `c`\n", trailingAtomEnds: 0 },
    { source: "` a`\n", trailingAtomEnds: 0 },
    { source: "`  a  `\n", trailingAtomEnds: 0 },
    { source: "``a`b``\n", trailingAtomEnds: 0 },
    { source: "`😀`\n", trailingAtomEnds: 0 },
    // Task 1.59 (M4): inside a table cell `mdast-util-gfm-table`'s `inlineCodeWithTable` writes a
    // `|` of the value as `\|`, so the span's bytes are longer than its value — the inverse failed
    // at exactly the positions inside such a span before `inlineCodeSpelling` learned that
    // spelling, and holds on the same bytes outside a table, where the backslash is the value's.
    { source: "| h |\n| - |\n| `a\\|b` xy |\n", trailingAtomEnds: 0 },
    { source: "| h |\n| - |\n| `x\\|y\\|z` xy |\n", trailingAtomEnds: 0 },
    { source: "a `a\\|b` c\n", trailingAtomEnds: 0 },
  ];

  for (const { source, trailingAtomEnds } of SOURCES) {
    it(`${JSON.stringify(source.trimEnd())}: the inverse holds at every text position, the block end after a trailing inline atom included, and toSource is monotone over them`, () => {
      const { root, doc } = pair(source);
      const map = cursorMap(root, doc);
      expect(trailingAtomBlockEnds(doc)).toHaveLength(trailingAtomEnds);
      const positions = textPositions(doc);
      expect(positions.length).toBeGreaterThan(0);
      const failures = positions
        .map((pos) => ({ pos, back: map.toRendered(map.toSource(pos)) }))
        .filter(({ pos, back }) => back !== pos);
      expect(failures).toEqual([]);
      const keys = positions.map((pos) => sourceKey(map.toSource(pos)));
      for (let index = 1; index < keys.length; index += 1) {
        expect(keys[index], `position ${positions[index]}`).toBeGreaterThanOrEqual(keys[index - 1]);
      }
    });
  }

  it("`a `+\"`cd`\"+` b`: the position between `c` and `d` names the column between them (the L4 reproduction)", () => {
    const { root, doc } = pair("a `cd` b\n");
    const map = cursorMap(root, doc);
    expect(charAt(doc, 3)).toBe("c");
    expect(charAt(doc, 4)).toBe("d");
    // Canonical `a `cd` b`: a=0, ' '=1, `=2, c=3, d=4, `=5 — between `c` and `d` is ch 4.
    expect(map.toSource(4)).toEqual({ line: 1, ch: 4 });
    expect(map.toRendered({ line: 1, ch: 4 })).toBe(4);
  });

  it("`alpha\\n<i>beta</i>`: the caret before the soft line break names the column of the space (the L3 reproduction)", () => {
    const { root, doc } = pair("alpha\n<i>beta</i>\n");
    const map = cursorMap(root, doc);
    expect(formatWithMap(root).text).toBe("alpha <i>beta</i>\n");
    expect(charAt(doc, 6)).toBe("\n");
    expect(map.toSource(6)).toEqual({ line: 1, ch: 5 });
    expect(map.toRendered({ line: 1, ch: 5 })).toBe(6);
  });
});

describe("a boundary between marked and unmarked text is resolved by `$pos.marks()` (task 1.53, DECISIONS #review-1-r6 L6)", () => {
  // A boundary between two inline nodes is one ProseMirror position, and the rendered view types
  // there with `doc.resolve(pos).marks()` (prosemirror-model's `ResolvedPos.marks()`, the set
  // `Transaction.insertText` gives the text): the node before's marks, less every mark whose spec
  // says `inclusive: false` that the node after lacks. The source caret must land where a typed
  // character takes the same marks — inside the closing delimiter at an inclusive run's end,
  // before the opening delimiter at its start — or the two views disagree about one caret:
  // `~~beta.~~X` cannot close (CommonMark §6.2, `X` is not right-flanking after `.`), so the
  // toggle back showed `\~\~beta.\~\~X`.
  //
  // The matrix: the three flanking marks × a punctuation edge and a letter edge × the run's end
  // and the run's start. Each tuple asserts the column and the semantic instrument — `X` written
  // into the source at that column and formatted through a reparse equals `X` inserted at `pos` in
  // the ProseMirror doc with `$pos.marks()` and run through `pmToMdast` and `format`.
  const DELIMITERS: Record<"emphasis" | "strong" | "delete", string> = {
    emphasis: "*",
    strong: "**",
    delete: "~~",
  };
  const EDGES: Record<"punctuation" | "letter", string> = { punctuation: "(beta.)", letter: "beta" };
  const HEAD = "Alpha ";
  const TAIL = " gamma";

  /**
   * `X` at `pos` in `doc`, with the marks the rendered view gives a character typed there:
   * `storedMarks ?? $pos.marks()`, which is `Transaction.insertText`'s own expression
   * (prosemirror-state 1.4.4, dist/index.js 639–644). `storedMarks` is `null` for a caret the
   * user placed — a click, an arrow key — and an array for one the editor set marks on, which is
   * the empty array an input rule's `removeStoredMark` leaves behind.
   */
  function typedInRendered(
    doc: ReturnType<typeof mdastToPM>["doc"],
    pos: number,
    storedMarks: readonly Mark[] | null = null,
    frontMatter: Yaml | null = null,
  ): string {
    const marks = storedMarks ?? doc.resolve(pos).marks();
    const tr = EditorState.create({ doc }).tr.replaceWith(pos, pos, schema.text("X", marks));
    return format(pmToMdast({ doc: tr.doc, frontMatter }));
  }

  /** `X` at `position` in `text`, reparsed and formatted: what the source view's keystroke yields. */
  function typedInSource(text: string, position: { line: number; ch: number }): string {
    const lines = text.split("\n");
    const line = lines[position.line - 1];
    lines[position.line - 1] = `${line.slice(0, position.ch)}X${line.slice(position.ch)}`;
    return format(parse(lines.join("\n")));
  }

  /** The nodes of `type` in `root`, with their plain text. */
  function runsOf(root: Root, type: string): string[] {
    const out: string[] = [];
    const walk = (node: { type: string; children?: unknown[]; value?: string }): void => {
      if (node.type === type) out.push(plainText(node));
      for (const child of (node.children ?? []) as (typeof node)[]) walk(child);
    };
    walk(root);
    return out;
  }

  function plainText(node: { children?: unknown[]; value?: string }): string {
    if (node.value !== undefined) return node.value;
    return ((node.children ?? []) as (typeof node)[]).map(plainText).join("");
  }

  function assertInverseEverywhere(doc: ReturnType<typeof mdastToPM>["doc"], map: ReturnType<typeof cursorMap>): void {
    const positions = textPositions(doc);
    expect(positions.length).toBeGreaterThan(0);
    const failures = positions
      .map((pos) => ({ pos, back: map.toRendered(map.toSource(pos)) }))
      .filter(({ pos, back }) => back !== pos);
    expect(failures).toEqual([]);
  }

  for (const [mark, delimiter] of Object.entries(DELIMITERS)) {
    for (const [edge, run] of Object.entries(EDGES)) {
      const source = `${HEAD}${delimiter}${run}${delimiter}${TAIL}\n`;
      const runStart = 1 + HEAD.length;
      const runEnd = runStart + run.length;

      it(`${mark}, ${edge} edge, the run's end (${JSON.stringify(source.trimEnd())}): the caret goes inside the closing delimiter, and a letter typed there extends the run in both views`, () => {
        const { root, doc } = pair(source);
        expect(format(root)).toBe(source);
        const map = cursorMap(root, doc);
        expect(doc.resolve(runEnd).marks().map((m) => m.type.name)).toEqual([mark]);
        expect(doc.textBetween(runStart, runEnd)).toBe(run);
        const column = HEAD.length + delimiter.length + run.length;
        expect(map.toSource(runEnd)).toEqual({ line: 1, ch: column });
        const rendered = typedInRendered(doc, runEnd);
        expect(typedInSource(source, { line: 1, ch: column })).toBe(rendered);
        expect(rendered).toBe(`${HEAD}${delimiter}${run}X${delimiter}${TAIL}\n`);
        // The mark count survives: one run, holding the letter; no escaped delimiter.
        expect(runsOf(parse(rendered), mark)).toEqual([`${run}X`]);
        expect(rendered).not.toContain("\\");
        assertInverseEverywhere(doc, map);
      });

      it(`${mark}, ${edge} edge, the run's start (${JSON.stringify(source.trimEnd())}): the caret stays before the opening delimiter, and a letter typed there does not extend the run in either view`, () => {
        const { root, doc } = pair(source);
        const map = cursorMap(root, doc);
        expect(doc.resolve(runStart).marks()).toEqual([]);
        expect(map.toSource(runStart)).toEqual({ line: 1, ch: HEAD.length });
        const rendered = typedInRendered(doc, runStart);
        const typed = typedInSource(source, { line: 1, ch: HEAD.length });
        if (edge === "letter") {
          // `X*beta*`: the opening delimiter is still left-flanking (CommonMark §6.2: followed by a
          // letter), so the raw keystroke and the rendered view spell the same bytes.
          expect(typed).toBe(rendered);
          expect(rendered).toBe(`${HEAD}X${delimiter}${run}${delimiter}${TAIL}\n`);
          expect(runsOf(parse(typed), mark)).toEqual([run]);
        } else {
          // `X*(beta.)*`: an opening delimiter followed by punctuation is left-flanking only after
          // whitespace or punctuation (CommonMark §6.2), so no column agrees byte-for-byte — the
          // rendered view keeps the run by writing the letter as a character reference (the
          // encoded-neighbour rule, tasks 1.45/1.49), while the source view is the bytes and
          // CommonMark un-forms the run under the raw keystroke. The two views agree on what the
          // map decides — the letter is unmarked and the run is not extended in either — and each
          // view's bytes are pinned as they are (journal [1.53]).
          expect(rendered).toBe(`${HEAD}&#x58;${delimiter}${run}${delimiter}${TAIL}\n`);
          expect(runsOf(parse(rendered), mark)).toEqual([run]);
          expect(typed).toBe(`${HEAD}X${delimiter.replace(/./g, "\\$&")}${run}${delimiter.replace(/./g, "\\$&")}${TAIL}\n`);
          expect(runsOf(parse(typed), mark)).toEqual([]);
        }
        // In neither view does a run hold the letter.
        for (const out of [rendered, typed]) {
          expect(runsOf(parse(out), mark).some((text) => text.includes("X"))).toBe(false);
        }
        assertInverseEverywhere(doc, map);
      });
    }
  }

  it("a `link` end (`inclusive: false`): the caret leaves the link on both sides, after `](u)` at the end and before `[` at the start", () => {
    const source = "Alpha [beta](u) gamma\n";
    const { root, doc } = pair(source);
    expect(format(root)).toBe(source);
    const map = cursorMap(root, doc);
    const runStart = 1 + HEAD.length;
    const runEnd = runStart + "beta".length;
    expect(doc.textBetween(runStart, runEnd)).toBe("beta");
    // `marks()` drops the non-inclusive link on both sides: the boundary's marks are the plain
    // neighbour's, so the end belongs to the later node.
    expect(doc.resolve(runEnd).marks()).toEqual([]);
    expect(doc.resolve(runStart).marks()).toEqual([]);
    const afterLink = HEAD.length + "[beta](u)".length;
    expect(map.toSource(runEnd)).toEqual({ line: 1, ch: afterLink });
    const renderedEnd = typedInRendered(doc, runEnd);
    expect(typedInSource(source, { line: 1, ch: afterLink })).toBe(renderedEnd);
    expect(renderedEnd).toBe("Alpha [beta](u)X gamma\n");
    expect(map.toSource(runStart)).toEqual({ line: 1, ch: HEAD.length });
    const renderedStart = typedInRendered(doc, runStart);
    expect(typedInSource(source, { line: 1, ch: HEAD.length })).toBe(renderedStart);
    expect(renderedStart).toBe("Alpha X[beta](u) gamma\n");
    expect(runsOf(parse(renderedEnd), "link")).toEqual(["beta"]);
    assertInverseEverywhere(doc, map);
  });

  it("an `inline_code` end: the mark is inclusive (`code: true` says nothing about boundaries), so the caret goes before the closing fence and a letter typed there joins the span in both views", () => {
    const source = "a `cd` b\n";
    const { root, doc } = pair(source);
    expect(format(root)).toBe(source);
    const map = cursorMap(root, doc);
    // a=1, c=3, d=4 in the doc; the boundary after `d` is 5.
    expect(doc.textBetween(3, 5)).toBe("cd");
    expect(doc.resolve(5).marks().map((m) => m.type.name)).toEqual(["inline_code"]);
    // Canonical `a `cd` b`: a=0, ' '=1, `=2, c=3, d=4, `=5 — before the closing fence is ch 5.
    expect(map.toSource(5)).toEqual({ line: 1, ch: 5 });
    const rendered = typedInRendered(doc, 5);
    expect(typedInSource(source, { line: 1, ch: 5 })).toBe(rendered);
    expect(rendered).toBe("a `cdX` b\n");
    expect(runsOf(parse(rendered), "inlineCode")).toEqual(["cdX"]);
    // The span's start is the plain side's, before the opening fence (a `2` in the doc is the
    // boundary between `a ` and `cd`).
    expect(doc.resolve(3).marks()).toEqual([]);
    expect(map.toSource(3)).toEqual({ line: 1, ch: 2 });
    expect(typedInSource(source, { line: 1, ch: 2 })).toBe(typedInRendered(doc, 3));
    assertInverseEverywhere(doc, map);
  });

  it("an `inline_code` run at its block's end follows the marks a typed character takes: inside the span with no stored marks, after the closing fence with stored marks `[]` (DECISIONS #review-1-r7 M5, task 1.60; task 1.52's answer is now the second of the two)", () => {
    const source = "see `foo`\n";
    const { root, doc } = pair(source);
    expect(format(root)).toBe(source);
    const map = cursorMap(root, doc);
    const end = 1 + "see foo".length;
    // No stored marks: `inline_code` sets no `inclusive`, so the resolved marks at the block's
    // end are the run's and the caret is inside, before the closing fence.
    expect(doc.resolve(end).marks().map((m) => m.type.name)).toEqual(["inline_code"]);
    const inside = { line: 1, ch: "see `foo".length };
    expect(map.toSource(end)).toEqual(inside);
    const renderedInside = typedInRendered(doc, end);
    expect(typedInSource(source, inside)).toBe(renderedInside);
    expect(renderedInside).toBe("see `fooX`\n");
    // Stored marks `[]` — what an input rule's `removeStoredMark` leaves one keystroke after the
    // span closed: the character is plain text, and the caret is task 1.52's, after the fence.
    const after = { line: 1, ch: "see `foo`".length };
    expect(map.toSource(end, [])).toEqual(after);
    const renderedAfter = typedInRendered(doc, end, []);
    expect(typedInSource(source, after)).toBe(renderedAfter);
    expect(renderedAfter).toBe("see `foo`X\n");
    assertInverseEverywhere(doc, map);
  });

  /**
   * **The last tuple of L6** (DECISIONS #review-1-r7 M5, Claude finding 4). The matrix above ends
   * at a boundary — a run with something after it — and a block-final run has none: no node
   * follows, so `innermostAt` never asks about marks and {@link isLeafEnd} is the only rule left.
   * The five block kinds the editor has a textblock for × the two routes a caret arrives by:
   *
   * - **the click route**, no stored marks, where the marks are `doc.resolve(pos).marks()` and
   *   carry the inclusive `inline_code`, so a typed character joins the span and the source caret
   *   belongs before the closing fence;
   * - **the input-rule route**, stored marks `[]`, which `removeStoredMark` (`input.ts`) leaves
   *   the keystroke after a span closes, so a typed character is plain text and the source caret
   *   belongs after the fence — task 1.52's answer, and the one the 1.52 (b) Playwright case
   *   drives.
   *
   * Each guard asserts the column (read off the source's own bytes, never a literal offset), the
   * two-view byte agreement — `X` typed in the rendered view with those marks, through `pmToMdast`
   * and `format`, against `X` written into the source at the mapped column and reparsed — which
   * side of the fence the bytes put it on, and the inverse over every text position of the
   * document.
   */
  describe("a block-final inline code span follows the marks a typed character takes", () => {
    const SPAN = "`foo`";
    const BLOCKS: Record<string, string> = {
      paragraph: "see `foo`\n",
      heading: "# see `foo`\n",
      "list item": "- see `foo`\n",
      blockquote: "> see `foo`\n",
      "table cell": "| h | i         |\n| - | --------- |\n| a | see `foo` |\n",
    };
    const ROUTES: Record<string, readonly Mark[] | null> = {
      "the click route (no stored marks)": null,
      "the input-rule route (stored marks `[]`)": [],
    };

    /** The end of the document's last textblock: the block-final position this family is about. */
    function lastTextblockEnd(doc: ReturnType<typeof mdastToPM>["doc"]): number {
      let end = -1;
      doc.descendants((node, pos) => {
        if (node.isTextblock) end = pos + 1 + node.content.size;
        return true;
      });
      expect(end).toBeGreaterThan(0);
      return end;
    }

    for (const [kind, source] of Object.entries(BLOCKS)) {
      const line = source.split("\n").findIndex((text) => text.includes(SPAN)) + 1;
      const spanStart = (source.split("\n")[line - 1] as string).indexOf(SPAN);

      for (const [route, storedMarks] of Object.entries(ROUTES)) {
        const joins = storedMarks === null;
        const ch = spanStart + (joins ? SPAN.length - 1 : SPAN.length);

        it(`${kind}, ${route}: the caret is ${joins ? "inside the span, before" : "outside the span, after"} the closing fence, and the two views agree byte for byte`, () => {
          const { root, doc } = pair(source);
          expect(format(root)).toBe(source);
          const map = cursorMap(root, doc);
          const end = lastTextblockEnd(doc);
          expect(doc.resolve(end).marks().map((m) => m.type.name)).toEqual(["inline_code"]);

          const at = { line, ch };
          expect(map.toSource(end, storedMarks)).toEqual(at);

          const rendered = typedInRendered(doc, end, storedMarks);
          expect(typedInSource(source, at)).toBe(rendered);
          // Which side of the fence the bytes put the character on: the run's own text.
          expect(runsOf(parse(rendered), "inlineCode")).toEqual([joins ? "fooX" : "foo"]);
          expect(rendered).toContain(joins ? "`fooX`" : "`foo`X");
          expect(format(parse(rendered))).toBe(rendered);

          assertInverseEverywhere(doc, map);
        });
      }
    }
  });

  /**
   * **The block-edge rule** (DECISIONS #review-1-r8 N1, Sol finding 1). The family above and
   * 1.60's both stop at a *leaf*: a boundary between two inline nodes, and the one leaf whose
   * own inside a typed character can join. At a block's **start** and at its **end** there is no
   * boundary — one side has no node at all — `isLeafEnd` is `false` for a `text` leaf, and the
   * answer was the innermost text's own spelling-table end, inside every enclosing delimiter,
   * whatever the typed marks said. The invariant this family asserts is one sentence:
   *
   * > at a block's edge the source caret is outside every enclosing mark the typed marks do not
   * > carry and inside every one they do — from the innermost mark outward, stopping at the
   * > first mark the typed marks carry.
   *
   * The typed marks are `storedMarks ?? $pos.marks()` ({@link typedInRendered} types with the
   * same expression), so the two routes a caret arrives by are the two columns of the matrix:
   *
   * - **the click route** (`storedMarks` `null`): `$pos.marks()` at an edge keeps every mark the
   *   text carries whose spec does not say `inclusive: false`, so `emphasis`, `strong` and
   *   `delete` are carried and the caret stays inside them — and `link` is not, on this route
   *   too, so a block that begins or ends in a link leaves it (the reconciliation's own find at
   *   `link-in-emphasis.md`, which no reviewer had);
   * - **the input-rule route** (`storedMarks` `[]`): `removeStoredMark` (`input.ts`) leaves it
   *   there the keystroke after a run closes, so no mark is carried, the caret leaves every
   *   enclosing one, and `see *foo*` + `X` is `see *foo*X` in both views instead of the
   *   `see *fooX*` the source view wrote before this task.
   *
   * The axes: mark kind (`emphasis`, `strong`, `delete`, `link`) × route × edge (start, end) ×
   * block kind (paragraph, heading, list item, blockquote, table cell), then one astral content
   * per mark kind (a non-BMP symbol and a non-BMP letter, CLAUDE.md's rule — held away from the
   * run's own edges, where a punctuation neighbour is the `[1.53]` class and not this one), the
   * nested member (stored `[emphasis]` at the end of `*foo **bar***`, which is after `**` and
   * before `*`), and a block-final inline-code run as the control the rule does not touch.
   *
   * Each guard asserts the column (computed from the source's own bytes by `indexOf`, never a
   * literal offset), the two views' bytes by `toBe`, that the parse of the rendered bytes holds
   * the run with exactly the text the caret's side implies, that the rendered bytes are a fixed
   * point of `parse ∘ format`, and the inverse over every text position of the document.
   */
  describe("at a block's edge the caret is outside every enclosing mark the typed marks do not carry", () => {
    /** A mark kind: the bytes the serializer writes around its content, and its mdast type. */
    const MARKS: Record<string, { open: string; close: string }> = {
      emphasis: { open: "*", close: "*" },
      strong: { open: "**", close: "**" },
      delete: { open: "~~", close: "~~" },
      link: { open: "[", close: "](u)" },
    };

    /**
     * The five block kinds the editor has a textblock for, each holding `run` as its whole
     * content so that the run's own delimiters are the block's two edges. The table's header is
     * padded to the run's width because that is what the serializer writes (`format` pads a
     * column to its widest cell), so the source stays canonical without a literal.
     */
    const BLOCKS: Record<string, (run: string) => string> = {
      paragraph: (run) => `${run}\n`,
      heading: (run) => `# ${run}\n`,
      "list item": (run) => `- ${run}\n`,
      blockquote: (run) => `> ${run}\n`,
      "table cell": (run) =>
        `| ${"h".padEnd(run.length)} |\n| ${"-".repeat(run.length)} |\n| ${run} |\n`,
    };

    const ROUTES: Record<string, readonly Mark[] | null> = {
      "the click route (no stored marks)": null,
      "the input-rule route (stored marks `[]`)": [],
    };

    /**
     * The document's last textblock, as the two positions this family is about: its content start
     * and its content end. Both are read off the doc and never written as a literal.
     */
    function lastTextblockEdges(
      doc: ReturnType<typeof mdastToPM>["doc"],
    ): { start: number; end: number } {
      let edges: { start: number; end: number } | null = null;
      doc.descendants((node, pos) => {
        if (node.isTextblock && node.content.size > 0)
          edges = { start: pos + 1, end: pos + 1 + node.content.size };
        return true;
      });
      expect(edges).not.toBeNull();
      return edges as unknown as { start: number; end: number };
    }

    /**
     * One guard of the matrix. `content` is the run's text, `carried` says whether the typed
     * marks carry this mark at this edge — which is exactly "the route inherits the document's
     * marks and the mark is not `link`", `link` being the one mark of the schema whose spec says
     * `inclusive: false` (`schema.ts`), dropped by `$pos.marks()` at an edge on both routes.
     */
    function assertEdge(
      kind: string,
      blockKind: string,
      content: string,
      edge: "start" | "end",
      storedMarks: readonly Mark[] | null,
    ): void {
      const { open, close } = MARKS[kind];
      const run = `${open}${content}${close}`;
      const source = BLOCKS[blockKind](run);
      const { root, doc } = pair(source);
      expect(format(root)).toBe(source);
      const map = cursorMap(root, doc);
      const carried = storedMarks === null && kind !== "link";

      const lines = source.split("\n");
      const line = lines.findIndex((text) => text.includes(run)) + 1;
      expect(line).toBeGreaterThan(0);
      const runAt = lines[line - 1].indexOf(run);
      const ch =
        edge === "end"
          ? runAt + (carried ? open.length + content.length : run.length)
          : runAt + (carried ? open.length : 0);

      const edges = lastTextblockEdges(doc);
      const pos = edge === "end" ? edges.end : edges.start;
      const at = { line, ch };
      expect(map.toSource(pos, storedMarks)).toEqual(at);

      const rendered = typedInRendered(doc, pos, storedMarks);
      expect(typedInSource(source, at)).toBe(rendered);
      // Which side of the delimiter the bytes put the letter on, read as the run's own text.
      const inside = edge === "end" ? `${content}X` : `X${content}`;
      expect(runsOf(parse(rendered), kind)).toEqual([carried ? inside : content]);
      expect(format(parse(rendered))).toBe(rendered);
      assertInverseEverywhere(doc, map);
    }

    for (const kind of Object.keys(MARKS)) {
      for (const [route, storedMarks] of Object.entries(ROUTES)) {
        for (const edge of ["start", "end"] as const) {
          for (const blockKind of Object.keys(BLOCKS)) {
            const carried = storedMarks === null && kind !== "link";
            it(`${kind}, ${route}, the block's ${edge}, ${blockKind}: the caret is ${carried ? "inside" : "outside"} the delimiter, and the two views agree byte for byte`, () => {
              assertEdge(kind, blockKind, "foo", edge, storedMarks);
            });
          }
        }
      }
    }

    // One astral content per mark kind, a non-BMP symbol and a non-BMP letter (CLAUDE.md: a lone
    // surrogate decodes to U+FFFD silently, so an enumeration that is only ASCII cannot see it).
    // The astral scalar sits *between* the run's own edges: an astral neighbour of a delimiter is
    // CommonMark punctuation, which is the `[1.53]` encoded-neighbour class and not this one.
    const ASTRAL: Record<string, string> = {
      "a non-BMP symbol": "f\u{1F600}o",
      "a non-BMP letter": "f\u{10400}o",
    };
    for (const kind of Object.keys(MARKS)) {
      for (const [astral, content] of Object.entries(ASTRAL)) {
        for (const [route, storedMarks] of Object.entries(ROUTES)) {
          for (const edge of ["start", "end"] as const) {
            it(`${kind} with ${astral} content (${JSON.stringify(content)}), ${route}, the block's ${edge}: the caret lands on the same side of the delimiter as the ASCII member`, () => {
              assertEdge(kind, "paragraph", content, edge, storedMarks);
            });
          }
        }
      }
    }

    it("nested runs, stored marks `[emphasis]` at the end of `*foo **bar***`: the caret stops at the first carried mark — after `**`, before `*` — because a caret cannot be outside the strong and inside the emphasis at once", () => {
      const source = "*foo **bar***\n";
      const { root, doc } = pair(source);
      expect(format(root)).toBe(source);
      const map = cursorMap(root, doc);
      const end = 1 + "foo bar".length;
      // The document's own marks at that position are both; the stored set is the emphasis only.
      expect(doc.resolve(end).marks().map((m) => m.type.name).sort()).toEqual([
        "emphasis",
        "strong",
      ]);
      const stored = doc.resolve(end).marks().filter((m) => m.type === schema.marks.emphasis);
      expect(stored.map((m) => m.type.name)).toEqual(["emphasis"]);

      const at = { line: 1, ch: source.indexOf("***") + "**".length };
      expect(map.toSource(end, stored)).toEqual(at);
      const rendered = typedInRendered(doc, end, stored);
      expect(typedInSource(source, at)).toBe(rendered);
      expect(rendered).toBe("*foo **bar**X*\n");
      expect(runsOf(parse(rendered), "emphasis")).toEqual(["foo barX"]);
      expect(runsOf(parse(rendered), "strong")).toEqual(["bar"]);
      expect(format(parse(rendered))).toBe(rendered);
      assertInverseEverywhere(doc, map);
    });

    it("the control: a block-final `inline_code` run has no enclosing mark, so the block-edge rule does not fire and 1.60's answer stands on both routes", () => {
      const source = "see `foo`\n";
      const { root, doc } = pair(source);
      const map = cursorMap(root, doc);
      const end = 1 + "see foo".length;
      expect(map.toSource(end)).toEqual({ line: 1, ch: "see `foo".length });
      expect(map.toSource(end, [])).toEqual({ line: 1, ch: "see `foo`".length });
      expect(typedInSource(source, map.toSource(end))).toBe(typedInRendered(doc, end));
      expect(typedInSource(source, map.toSource(end, []))).toBe(typedInRendered(doc, end, []));
      assertInverseEverywhere(doc, map);
    });
  });

  /**
   * **The block-edge rule over the corpus** (DECISIONS #review-1-r8 N1). The matrix above is
   * hand-built; this is the invariant itself, asserted over every fixture in
   * `fixtures/markdown/index.json`: at every textblock's start and its end, on both routes, the
   * bytes the rendered view writes for a letter typed there and the bytes the source view writes
   * at the mapped column are the same string.
   *
   * **What is not in the leg.** A fenced code block is a textblock in the schema and its interior
   * is outside this leg, as it is outside 1.52's: the map places a `code` node and never enters
   * it, so a position inside one is not a caret among inline marks. A zero-width textblock (the
   * placeholder `block+` needs, which no correspondence covers) has no inline node on either
   * side, so it has no edge in this sense and no enclosing mark either.
   *
   * **The two named exclusions, each positively bounded and each asserted non-empty** (DECISIONS
   * #032: never a test marked as expected to fail, never a narrowing). A position the leg
   * excludes is asserted to *be* a member of its class and to actually disagree; every other
   * position is asserted to agree.
   *
   * 1. `[1.53, a raw source keystroke before a punctuation-edged run]`, the after side
   *    (DECISIONS #review-1-r8 N8). On the `[]` route at a block end whose last inline node
   *    carries one of the three flanking marks and whose last code point is CommonMark
   *    punctuation, the caret leaves the run and the two views part company for a reason that is
   *    not the cursor map's: the rendered view keeps the run by writing the letter as a character
   *    reference (`a ~~(b)~~&#x58;`, the encoded-neighbour rule of tasks 1.45/1.49 — `~~` before
   *    a letter and after punctuation is not right-flanking, CommonMark §6.2), while the raw
   *    keystroke in the source view dissolves the run (`a \~\~(b)\~\~X`). The caret is in the
   *    same place in both; only the bytes differ, and which bytes each view writes is each view's
   *    own rule. In scope for this leg only as a bounded member.
   * 2. **Found by this leg, outside this task's scope** and filed in `docs/V1.1-BACKLOG.md` with
   *    a revisit trigger: the block-*start* twin of 1.60's block-end inline-code rule. On the
   *    `[]` route at a block start whose first inline node is an `inline_code` run and carries no
   *    other mark, the rendered view types plain text *before* the span while `toSource` answers
   *    inside the run's value — `isLeafEnd` (`toggle.ts`) is a rule for a leaf's *end* and has no
   *    start twin, and this task's rule is about the marks *enclosing* a leaf, which a run at a
   *    block's start has none of. Three positions in two fixtures.
   */
  describe("the block-edge rule over the corpus", () => {
    const index = fixtureIndex();
    const names = Object.keys(index);

    /**
     * CommonMark's punctuation, `Intl`-free: the Unicode punctuation and symbol categories, which
     * is what `micromark-util-classify-character` reads (`classifyCharacter`'s
     * `unicodePunctuation`) and what decides whether a closing `~~` is right-flanking.
     */
    const PUNCTUATION = /[\p{P}\p{S}]/u;

    /** The three marks that flank with a delimiter run; `link` writes `[…](…)` and does not. */
    const FLANKING = ["emphasis", "strong", "delete"];

    interface Edge {
      readonly pos: number;
      readonly edge: "start" | "end";
      /** The textblock's own position (before the node), what {@link blockAlone} cuts around. */
      readonly blockPos: number;
    }

    /** Every non-empty textblock's content start and content end, except a fenced code block's. */
    function inlineEdges(doc: ReturnType<typeof mdastToPM>["doc"]): Edge[] {
      const out: Edge[] = [];
      doc.descendants((node, pos) => {
        if (node.type === schema.nodes.code_block) return false;
        if (node.isTextblock && node.content.size > 0) {
          out.push({ pos: pos + 1, edge: "start", blockPos: pos });
          out.push({ pos: pos + 1 + node.content.size, edge: "end", blockPos: pos });
        }
        return true;
      });
      return out;
    }

    function markNames(node: ReturnType<typeof mdastToPM>["doc"] | null): string[] {
      return node === null ? [] : node.marks.map((mark) => mark.type.name);
    }

    /** Exclusion 1: the `[1.53]` class's after side — a punctuation-edged flanking run at a block end. */
    function isPunctuationEdgedRunEnd(
      doc: ReturnType<typeof mdastToPM>["doc"],
      { pos, edge }: Edge,
      storedMarks: readonly Mark[] | null,
    ): boolean {
      if (edge !== "end" || storedMarks === null) return false;
      const before = doc.resolve(pos).nodeBefore;
      if (before === null || !before.isText) return false;
      if (!markNames(before).some((name) => FLANKING.includes(name))) return false;
      const last = [...(before.text as string)].pop();
      return last !== undefined && PUNCTUATION.test(last);
    }

    /** Exclusion 2: the block-start twin of 1.60's leaf rule — a bare `inline_code` run first. */
    function isInlineCodeRunStart(
      doc: ReturnType<typeof mdastToPM>["doc"],
      { pos, edge }: Edge,
      storedMarks: readonly Mark[] | null,
    ): boolean {
      if (edge !== "start" || storedMarks === null) return false;
      return markNames(doc.resolve(pos).nodeAfter).join(",") === "inline_code";
    }

    const punctuationEdged: string[] = [];
    const inlineCodeStarts: string[] = [];
    const fixturesWithEdges: string[] = [];
    const fixturesWithoutEdges: string[] = [];
    let agreements = 0;
    /** Every edge × route pair the block-alone oracle answered and bridged back to the document. */
    let edgesBridged = 0;

    /**
     * DECISIONS #review-1-r9 CI timing, task 1.66: the same defect and the same fix as task 1.64's
     * (`block-alone.ts`'s own doc comment) — the essay fixture's few hundred edges, each compared
     * on the whole document twice (the rendered view's `format ∘ pmToMdast` and the source view's
     * `format ∘ parse`), cost 7.8 s in this container and 60–96 s on GitHub's ubuntu and windows
     * runners, over the one-minute budget the leg gave itself. A correspondence at a textblock's
     * edge is block-local, so {@link blockAlone} answers the same bytes at a hundredth of the cost
     * and the family's usual 30_000 ms budget (DECISIONS #review-1-r7 M6) holds on every runner.
     */
    const BLOCK_EDGE_LEG_TIMEOUT_MS = 30_000;

    it.each(names)("%s: at every textblock edge, on both routes, the two views write the same bytes", (name) => {
      const source = fixture(name);
      const { root, doc } = pair(source);
      const map = cursorMap(root, doc);
      const edges = inlineEdges(doc);
      (edges.length > 0 ? fixturesWithEdges : fixturesWithoutEdges).push(name);

      // One block-alone oracle per swept textblock, shared by its two edges and both routes.
      const alones = new Map<number, BlockAlone>();
      function aloneFor(blockPos: number): BlockAlone {
        const cached = alones.get(blockPos);
        if (cached !== undefined) return cached;
        const node = doc.nodeAt(blockPos);
        expect(node, `${name}: the textblock at ${blockPos}`).not.toBeNull();
        const found = blockAlone(doc, blockPos, node as PMNode);
        alones.set(blockPos, found);
        return found;
      }

      // Where one line of a block alone sits in the whole document: its line, its column shift —
      // asserted the same across both routes of an edge and across both edges of a block that
      // share a block-local line (the bridge, DECISIONS #review-1-r8 N2's form). Keyed by the
      // block's own position beside the block-local line: two unrelated blocks (a document has
      // many single-line paragraphs, each block-local line 1) are not the same shift.
      const shifts = new Map<string, { line: number; ch: number }>();

      for (const edge of edges) {
        const alone = aloneFor(edge.blockPos);
        for (const storedMarks of [null, [] as readonly Mark[]]) {
          const at = map.toSource(edge.pos, storedMarks);
          const where = `${name} ${edge.edge} ${storedMarks === null ? "click" : "[]"} ${at.line}:${at.ch}`;
          const inBlock = alone.map.toSource(edge.pos + alone.offset, storedMarks);
          const shift = { line: at.line, ch: at.ch - inBlock.ch };
          const shiftKey = `${edge.blockPos}:${inBlock.line}`;
          const first = shifts.get(shiftKey);
          if (first === undefined) shifts.set(shiftKey, shift);
          else
            expect(
              shift,
              `${where}: the block's line ${inBlock.line} sits at one line and one column shift of the document`,
            ).toEqual(first);
          edgesBridged += 1;

          const rendered = typedInRendered(alone.doc, edge.pos + alone.offset, storedMarks);
          const typed = typedInSource(alone.text, inBlock);

          if (isPunctuationEdgedRunEnd(doc, edge, storedMarks)) {
            // Positively bounded: the views disagree, the rendered view wrote the letter as a
            // character reference on that line, and the source view wrote the raw keystroke.
            expect(typed, where).not.toBe(rendered);
            expect(rendered.split("\n")[inBlock.line - 1], where).toMatch(/&#x58;$/);
            expect(typed.split("\n")[inBlock.line - 1], where).toMatch(/X$/);
            punctuationEdged.push(where);
            continue;
          }
          if (isInlineCodeRunStart(doc, edge, storedMarks)) {
            // Positively bounded: the views disagree, and the mapped column is *inside* the code
            // span — past its opening fence, which is the whole of the defect.
            expect(typed, where).not.toBe(rendered);
            const line = alone.text.split("\n")[inBlock.line - 1];
            expect(line.slice(0, inBlock.ch), where).toMatch(/`+$/);
            inlineCodeStarts.push(where);
            continue;
          }
          expect(typed, where).toBe(rendered);
          agreements += 1;
        }
      }
    }, BLOCK_EDGE_LEG_TIMEOUT_MS);

    it("ran the leg over every fixture in the index, and both sides of every clause were reached", () => {
      expect(names.length).toBeGreaterThan(40);
      expect([...fixturesWithEdges, ...fixturesWithoutEdges].sort()).toEqual([...names].sort());
      // The presence/absence pair the per-fixture assertion cannot make: most fixtures have an
      // inline textblock, and the ones that are nothing but a fenced code block have none — the
      // leg's own statement that a fence's interior is outside it.
      expect(fixturesWithEdges.length).toBeGreaterThan(0);
      expect(fixturesWithoutEdges.length).toBeGreaterThan(0);
      // The positive side: the overwhelming majority of edges agree byte for byte.
      expect(agreements).toBeGreaterThan(0);
      // Exclusion 1 is non-empty and lives in more than one fixture (the reconciliation counted
      // eight positions in six fixtures); the count itself is read from the run, never asserted
      // as a literal, and is recorded in the journal.
      expect(punctuationEdged.length).toBeGreaterThan(0);
      expect(new Set(punctuationEdged.map((where) => where.split(" ")[0])).size).toBeGreaterThan(1);
      // Exclusion 2 is non-empty too — the class this leg found outside the task's scope.
      expect(inlineCodeStarts.length).toBeGreaterThan(0);
      // …and neither exclusion swallowed the leg: agreements outnumber them by far.
      expect(agreements).toBeGreaterThan(punctuationEdged.length + inlineCodeStarts.length);
      // Every edge × route pair compared was bridged from the block alone back to the document.
      expect(edgesBridged).toBe(agreements + punctuationEdged.length + inlineCodeStarts.length);
    });
  });

  it("a one-character marked first run (`*a* y`, DECISIONS #031 (a)): a letter typed after `a` in the rendered view lands inside the run, and the source caret after it satisfies the letter leg's `ch - 1` model", () => {
    const { root, doc } = pair("*a* y\n");
    const map = cursorMap(root, doc);
    // The boundary after `a` is doc position 2; `marks()` there is the emphasis.
    expect(doc.textBetween(1, 2)).toBe("a");
    expect(doc.resolve(2).marks().map((m) => m.type.name)).toEqual(["emphasis"]);
    expect(map.toSource(2)).toEqual({ line: 1, ch: 2 });
    const typed = EditorState.create({ doc }).tr.replaceWith(2, 2, schema.text("Q", doc.resolve(2).marks()));
    const typedRoot = pmToMdast({ doc: typed.doc, frontMatter: null });
    const text = format(typedRoot);
    expect(text).toBe("*aQ* y\n");
    const typedMap = cursorMap(typedRoot, typed.doc);
    const after = typedMap.toSource(3);
    expect(text.split("\n")[after.line - 1][after.ch - 1]).toBe("Q");
    assertInverseEverywhere(typed.doc, typedMap);
  });

  /* --------------------------------------------------------------------------------------- */

  /**
   * **Whitespace the conversion drops (task 1.64, DECISIONS #review-1-r8 N2).** The editor keeps
   * every character typed into a textblock; `stripUnparsableWhitespace` does not, and the tree
   * that leaves the editor is the stripped one. An inline correspondence is therefore built from
   * the **kept-character map** ({@link keptCharacters}), so its `pmStart`/`pmEnd` are live
   * positions and the leaf-interior arithmetic translates through the map in both directions —
   * before this task the widths of the *normalised* tree were used as live distances, and every
   * character after dropped whitespace was mapped one place off in both directions at once (the
   * inverse held while both were wrong).
   *
   * The guards below enumerate the strip's own branches — the six whitespace classes — over the
   * node classes and the containers, each seeded from a typing- or deleting-shaped transaction on
   * `mdastToPM(parse(·))`, never a hand-built document. Every case asserts three things:
   *
   * - **the two views' bytes** at every position the map returns to, `X` typed in the rendered
   *   view against `X` written into the source at the column `toSource` answers (`toBe`);
   * - **the inverse** there, and over every text position of the document;
   * - **the ownership rule** at every position it does not return to: a live position inside
   *   dropped whitespace answers the *next kept character*'s column and comes back to that
   *   character, and one past the last kept character answers the block's end. It is the one rule
   *   for the whole class, stated once in {@link keptCharacters}' doc comment and reached here at
   *   the first, middle and last character of a three-character run by the guard that names it.
   *
   * The positions a case does not assert bytes at are exactly the positions of that rule: typing
   * *into* whitespace the source does not hold writes bytes the source cannot write, because the
   * keystroke keeps the whitespace alive (`X `+backtick+`cd`+backtick+` b` against
   * `X`+backtick+`cd`+backtick+` b`). Each case counts them and asserts every one is of that
   * class, so the set is bounded positively and never narrowed (DECISIONS #032).
   */
  describe("whitespace the conversion drops: the correspondence is the live document's, and a position inside dropped whitespace is the next kept character's (task 1.64, DECISIONS #review-1-r8 N2)", () => {
    type Doc = ReturnType<typeof mdastToPM>["doc"];
    interface Block {
      readonly node: Doc;
      readonly start: number;
    }

    /** The last textblock that holds inline content: every case below puts its line there. */
    function targetBlock(doc: Doc): Block {
      let found: Block | null = null;
      doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        if (node.type !== schema.nodes.code_block) found = { node, start: pos + 1 };
        return false;
      });
      expect(found, "the source holds a textblock with inline content").not.toBeNull();
      return found as unknown as Block;
    }

    function childrenOf(node: Doc): Doc[] {
      const out: Doc[] = [];
      node.forEach((child) => out.push(child));
      return out;
    }

    /** The conversion's own normalisation of `block`, with the line ending its kind is given. */
    function charsOf(block: Block): ReturnType<typeof keptCharacters> {
      return keptCharacters(
        childrenOf(block.node),
        block.node.type === schema.nodes.table_cell ? CELL_LINE_ENDING : LINE_ENDING,
      );
    }

    /** `text` inserted at `pos` with `marks` — `insertText`, the call a keystroke makes. */
    function typeAt(doc: Doc, pos: number, text: string, marks: readonly Mark[] | null = null): Doc {
      return EditorState.create({ doc }).tr.setStoredMarks(marks).insertText(text, pos).doc;
    }

    /** `tr.delete`, the call a Backspace makes. */
    function deleteRange(doc: Doc, from: number, to: number): Doc {
      return EditorState.create({ doc }).tr.delete(from, to).doc;
    }

    /** The position just after `block`'s first `hard_break`. */
    function afterHardBreak(block: Block): number {
      let at: number | null = null;
      block.node.forEach((child, offset) => {
        if (at === null && child.type === schema.nodes.hard_break)
          at = block.start + offset + child.nodeSize;
      });
      expect(at, "the seeded source holds a hard break").not.toBeNull();
      return at as unknown as number;
    }

    /** The position of `block`'s first soft line ending — the `\n` a text node holds. */
    function softLineEnding(block: Block): number {
      let at: number | null = null;
      block.node.forEach((child, offset) => {
        if (at !== null || !child.isText) return;
        const index = (child.text as string).indexOf("\n");
        if (index !== -1) at = block.start + offset + index;
      });
      expect(at, "the seeded source holds a soft line break").not.toBeNull();
      return at as unknown as number;
    }

    /** The first character of `block`'s first text child — one code point, as a Delete takes it. */
    function firstCharacter(block: Block): [number, number] {
      const first = block.node.firstChild;
      expect(first?.isText, "the seeded block begins with text").toBe(true);
      const character = [...((first as Doc).text as string)][0] as string;
      return [block.start, block.start + character.length];
    }

    /** Whether `pos` sits between the two UTF-16 units of one code point: no caret can be there. */
    function insideSurrogatePair(doc: Doc, pos: number): boolean {
      const $pos = doc.resolve(pos);
      const before = $pos.nodeBefore;
      const after = $pos.nodeAfter;
      return (
        before !== null &&
        after !== null &&
        before.isText &&
        after.isText &&
        /[\uD800-\uDBFF]$/.test(before.text as string) &&
        /^[\uDC00-\uDFFF]/.test(after.text as string)
      );
    }

    interface Seeded {
      doc: Doc;
      root: Root;
      text: string;
      map: ReturnType<typeof cursorMap>;
      block: Block;
      chars: ReturnType<typeof keptCharacters>;
    }

    /** One case: parse `source`, apply `transaction` to its target block, read the two views. */
    function seed(source: string, transaction: (doc: Doc, block: Block) => Doc): Seeded {
      const editor = mdastToPM(parse(source));
      const doc = transaction(editor.doc, targetBlock(editor.doc));
      const root = pmToMdast({ doc, frontMatter: editor.frontMatter });
      const block = targetBlock(doc);
      return { doc, root, text: format(root), map: cursorMap(root, doc), block, chars: charsOf(block) };
    }

    /**
     * **A class this task's assertions found outside its scope, filed in `docs/V1.1-BACKLOG.md`
     * with a revisit trigger and bounded positively here (DECISIONS #032, #review-1-r1).** The
     * caret straight after a `hard_break` inside a container that writes a continuation prefix — a
     * list item's indentation, a blockquote's `> ` — is answered with the break's own range end,
     * which is column 1 of the next line, *before* that prefix; the rendered view types after the
     * prefix. It is not this task's: the same position disagrees in the parsed document with
     * nothing dropped at all (`- a\` + newline + `  *bc* d`, no transaction), so it is the
     * position map's rule for a break's end in an indented container, not the correspondence's
     * for dropped whitespace. Asserted, never skipped: the position is one whose `nodeBefore` is
     * a break, whose block sits in a `list_item` or `blockquote`, and whose answer is column 0 of
     * a line whose own bytes begin with that container's prefix.
     */
    function afterBreakInIndentedContainer(seeded: Seeded, pos: number): boolean {
      // Back over whitespace the conversion dropped: every position of a dropped run answers the
      // same column (the ownership rule), so the class is the break's wherever in the run the
      // caret is — the run is what the break's own line start took.
      let kept = pos;
      while (kept > seeded.block.start && !seeded.chars.keeps(kept - 1 - seeded.block.start))
        kept -= 1;
      const before = seeded.doc.resolve(kept).nodeBefore;
      if (before === null || before.type !== schema.nodes.hard_break) return false;
      const $pos = seeded.doc.resolve(pos);
      let indented = false;
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        const type = $pos.node(depth).type;
        if (type === schema.nodes.list_item || type === schema.nodes.blockquote) indented = true;
      }
      if (!indented) return false;
      const at = seeded.map.toSource(pos);
      const line = seeded.text.split("\n")[at.line - 1];
      expect(at.ch, `the excluded position ${pos} is column 0 of its line`).toBe(0);
      expect(line, `the excluded position ${pos} is on a prefixed continuation line`).toMatch(
        /^(?:\s{2,}|> )/,
      );
      return true;
    }

    /** Whether `pos` is a member of the backlog class *and* the two views actually part there. */
    function excluded(seeded: Seeded, pos: number, parted: boolean): boolean {
      return parted && afterBreakInIndentedContainer(seeded, pos);
    }

    /** What one case reached: the dropped characters, and the positions of each kind. */
    interface Reach {
      dropped: number[];
      settled: number[];
      insideDropped: number[];
      /** The positions the backlog class above took out of both assertions. */
      excluded: number[];
      /** Whether the dropped whitespace is a whole node between two kept ones (a gap). */
      gap: boolean;
    }

    /**
     * The whole of what a case asserts (see the describe's comment): the two views' bytes and the
     * inverse at every position the map returns to, the ownership rule at every position it does
     * not, and the inverse over every text position of the document outside this block.
     */
    function assertBothViews(seeded: Seeded): Reach {
      const { doc, text, map, block, chars } = seeded;
      const reach: Reach = { dropped: [], settled: [], insideDropped: [], excluded: [], gap: false };
      for (let live = 0; live < chars.liveWidth; live += 1) {
        if (!chars.keeps(live)) reach.dropped.push(live);
      }
      expect(reach.dropped.length, "this seeding drops whitespace the editor holds").toBeGreaterThan(0);
      reach.gap = reach.dropped.some(
        (live) => !chars.ranges.some((range) => range.start <= live && live < range.end),
      );
      for (let live = 0; live <= chars.liveWidth; live += 1) {
        const pos = block.start + live;
        if (insideSurrogatePair(doc, pos)) continue;
        if (chars.liveOf(chars.offsetOf(live)) === live) reach.settled.push(pos);
        else reach.insideDropped.push(pos);
      }
      for (const pos of reach.settled) {
        const at = map.toSource(pos);
        const rendered = typedInRendered(doc, pos);
        const typed = typedInSource(text, at);
        const back = map.toRendered(at);
        if (excluded(seeded, pos, typed !== rendered || back !== pos)) {
          reach.excluded.push(pos);
          continue;
        }
        expect(typed, `the two views at ${pos} (${at.line}:${at.ch}) of ${JSON.stringify(text)}`).toBe(
          rendered,
        );
        expect(back, `the inverse at ${pos} of ${JSON.stringify(text)}`).toBe(pos);
      }
      for (const pos of reach.insideDropped) {
        const next = block.start + chars.liveOf(chars.offsetOf(pos - block.start));
        if (excluded(seeded, pos, map.toRendered(map.toSource(pos)) !== next)) {
          reach.excluded.push(pos);
          continue;
        }
        expect(
          map.toSource(pos),
          `the ownership rule at ${pos}: the next kept character's column`,
        ).toEqual(map.toSource(next));
        expect(map.toRendered(map.toSource(pos)), `the ownership rule at ${pos}`).toBe(next);
      }
      // Every other text position of the document is its own inverse: the transaction touched one
      // block, and the map is the identity wherever nothing was dropped.
      const outside = textPositions(doc).filter(
        (pos) => pos < block.start || pos > block.start + chars.liveWidth,
      );
      const failures: number[] = [];
      for (const pos of outside) {
        if (map.toRendered(map.toSource(pos)) === pos) continue;
        if (excluded(seeded, pos, true)) reach.excluded.push(pos);
        else failures.push(pos);
      }
      expect(failures, "the inverse outside the seeded block").toEqual([]);
      return reach;
    }

    /** The five inline node classes the whitespace can meet, and the Markdown that spells them. */
    const NODES = [
      { node: "plain text", markdown: "bc" },
      { node: "marked text", markdown: "*bc*" },
      { node: "inline code", markdown: "`bc`" },
      { node: "a link's text", markdown: "[bc](u)" },
      { node: "a run beside an atom", markdown: "![bc](u)" },
    ];

    /** The astral members: a non-BMP symbol and a non-BMP letter beside the dropped whitespace. */
    const ASTRAL_NODES = [
      { node: "a non-BMP symbol", markdown: "\u{1F600}bc" },
      { node: "a non-BMP letter", markdown: "\u{10400}bc" },
    ];

    /**
     * The containers, and how each spells a block of one or two lines. A heading and a table cell
     * are one line of Markdown each — the parser can put neither a soft nor a hard break in one —
     * so a class that needs a second line names only the other three (the cell's own line-ending
     * run is reached by a paste below, which is the only way a cell gets one).
     */
    const CONTAINERS = [
      { container: "paragraph", lines: 2, wrap: (ls: string[]) => `${ls.join("\n")}\n` },
      { container: "heading", lines: 1, wrap: (ls: string[]) => `# ${ls[0]}\n` },
      { container: "list item", lines: 2, wrap: (ls: string[]) => `- ${ls.join("\n  ")}\n` },
      { container: "blockquote", lines: 2, wrap: (ls: string[]) => `> ${ls.join("\n> ")}\n` },
      {
        container: "table cell",
        lines: 1,
        wrap: (ls: string[]) => `| h1 | h2 |\n| -- | -- |\n| z | ${ls[0]} |\n`,
      },
    ];

    /**
     * The whitespace classes: one per branch of the strip's ownership rule, each with the
     * keystroke that reaches it and the node classes it can meet.
     *
     * `a lead after a hard break` and `a whitespace-only run between two nodes` are the same
     * keystroke — one space typed at a line start — split by what the space becomes: it merges
     * into the following text when that node is plain text (a lead inside one node) and stands as
     * its own node, dropped whole, when it is not (a gap between two kept nodes). Each case
     * asserts which of the two it reached, and the summary asserts both were.
     */
    const CLASSES = [
      {
        whitespace: "a lead at the block's start",
        needs: 1,
        nodes: [...NODES, ...ASTRAL_NODES],
        lines: (markdown: string) => [`a ${markdown} d`],
        // One Delete at the block's start, which leaves the space that followed it leading.
        seed: (doc: Doc, block: Block) => deleteRange(doc, ...firstCharacter(block)),
      },
      {
        whitespace: "a lead after a hard break",
        needs: 2,
        nodes: NODES.slice(0, 1),
        lines: (markdown: string) => ["a\\", `${markdown} d`],
        seed: (doc: Doc, block: Block) => typeAt(doc, afterHardBreak(block), " ", []),
      },
      {
        whitespace: "a whitespace-only run between two nodes",
        needs: 2,
        nodes: NODES.slice(1),
        lines: (markdown: string) => ["a\\", `${markdown} d`],
        seed: (doc: Doc, block: Block) => typeAt(doc, afterHardBreak(block), " ", []),
      },
      {
        whitespace: "a trailing run at the block's end",
        needs: 1,
        nodes: NODES,
        lines: (markdown: string) => [`a ${markdown}`],
        // Typed with the stored marks an input rule leaves (`[]`), so the space lands *outside*
        // the node it follows: inside an `inline_code` run or a link's text the strip keeps it
        // (both are opaque to it), and the class would have no member there.
        seed: (doc: Doc, block: Block) =>
          typeAt(doc, block.start + block.node.content.size, " ", []),
      },
      {
        whitespace: "a line-ending run with spaces on both sides (LINE_ENDING)",
        needs: 2,
        nodes: NODES,
        lines: (markdown: string) => [`a ${markdown}`, "d e"],
        // The two spaces are typed with stored marks `[]` (an input rule's own route), so the one
        // before the break cannot join the node it follows — the run, not that node, is the case.
        seed: (doc: Doc, block: Block) => {
          const at = softLineEnding(block);
          return typeAt(typeAt(doc, at + 1, " ", []), at, " ", []);
        },
      },
      {
        whitespace: "a dropped trailing hard break",
        needs: 2,
        nodes: NODES,
        lines: (markdown: string) => [`a ${markdown}\\`, "d"],
        seed: (doc: Doc, block: Block) =>
          deleteRange(doc, afterHardBreak(block), block.start + block.node.content.size),
      },
    ];

    let cases = 0;
    let gaps = 0;
    let insideNodes = 0;
    let droppedPositions = 0;
    let excludedPositions = 0;
    const reached: string[] = [];

    for (const { whitespace, needs, nodes, lines, seed: transact } of CLASSES) {
      for (const { node, markdown } of nodes) {
        for (const { container, lines: held, wrap } of CONTAINERS) {
          if (held < needs) continue;
          it(`${whitespace}, ${node}, in a ${container}: the two views write the same bytes at every position the map returns to, and a position inside the dropped whitespace is the next kept character's`, () => {
            const seeded = seed(wrap(lines(markdown)), transact);
            const reach = assertBothViews(seeded);
            cases += 1;
            droppedPositions += reach.insideDropped.length;
            excludedPositions += reach.excluded.length;
            if (reach.gap) gaps += 1;
            else insideNodes += 1;
            reached.push(`${whitespace} | ${node} | ${container}`);
          });
        }
      }
    }

    it("a line-ending run with spaces on both sides (CELL_LINE_ENDING): a pasted line ending in a table cell collapses to one space", () => {
      // A GFM row ends at its line ending, so no cell the parser builds holds one; a paste is the
      // only route, and `replaceSelection`'s text is what a two-line paste carries in.
      for (const { node, markdown } of NODES) {
        const source = `| h1 | h2 |\n| -- | -- |\n| z | a ${markdown} d |\n`;
        const seeded = seed(source, (doc, block) => typeAt(doc, block.start + 1, " \n ", []));
        expect(seeded.block.node.type, node).toBe(schema.nodes.table_cell);
        // The pasted line ending collapses to the one space the cell already held, so the bytes
        // are the source's own canonical form (whose columns the formatter pads to the header's).
        expect(seeded.text, node).toBe(format(parse(source)));
        const reach = assertBothViews(seeded);
        cases += 1;
        droppedPositions += reach.insideDropped.length;
        excludedPositions += reach.excluded.length;
        if (reach.gap) gaps += 1;
        else insideNodes += 1;
        reached.push(`a line-ending run (CELL_LINE_ENDING) | ${node} | table cell`);
      }
    });

    it("the ownership rule at the first, middle and last character of a dropped run: all three answer the next kept character, and the run's own three positions come back to it", () => {
      // Three spaces typed at a line start: a dropped run three characters wide, so the rule's
      // first, middle and last positions are three different positions of one run.
      const seeded = seed("a\\\nbc d\n", (doc, block) => typeAt(doc, afterHardBreak(block), "   ", []));
      const reach = assertBothViews(seeded);
      expect(reach.dropped).toHaveLength(3);
      expect(reach.insideDropped).toHaveLength(3);
      const [first, middle, last] = reach.insideDropped;
      expect(middle).toBe(first + 1);
      expect(last).toBe(first + 2);
      const next = last + 1;
      expect(reach.settled).toContain(next);
      for (const pos of [first, middle, last]) {
        expect(seeded.map.toSource(pos), `dropped position ${pos}`).toEqual(seeded.map.toSource(next));
        expect(seeded.map.toRendered(seeded.map.toSource(pos)), `dropped position ${pos}`).toBe(next);
      }
      // And past the last kept character the rule's other half: the block's end.
      const end = seeded.block.start + seeded.chars.liveWidth;
      expect(seeded.map.toRendered(seeded.map.toSource(end))).toBe(end);
    });

    it("Sol's route (`a `+backtick+`cd`+backtick+` b`, the first character deleted): the caret between `c` and `d` is column 2 on both routes, and the caret before the fence is outside it only when the typed marks are", () => {
      const seeded = seed("a `cd` b\n", (doc, block) => deleteRange(doc, ...firstCharacter(block)));
      expect(seeded.text).toBe("`cd` b\n");
      const start = seeded.block.start;
      // The reconciliation's own position: between `c` and `d`, which answered column 3 — the
      // rendered view wrote `` `cXd` b `` and the source view `` `cdX` b ``.
      expect(seeded.map.toSource(start + 2)).toEqual({ line: 1, ch: 2 });
      expect(typedInRendered(seeded.doc, start + 2)).toBe("`cXd` b\n");
      expect(typedInSource(seeded.text, { line: 1, ch: 2 })).toBe("`cXd` b\n");
      // The position after the stripped lead, both routes. A click leaves `storedMarks` null and
      // the marks at that boundary are the dropped space's, empty: the caret is before the fence.
      expect(seeded.map.toSource(start + 1)).toEqual({ line: 1, ch: 0 });
      expect(typedInRendered(seeded.doc, start + 1)).toBe("X`cd` b\n");
      // With `inline_code` stored — the toggle's own route — the caret is inside the fence.
      const inside = [schema.marks.inline_code.create()];
      expect(seeded.map.toSource(start + 1, inside)).toEqual({ line: 1, ch: 1 });
      expect(typedInRendered(seeded.doc, start + 1, inside)).toBe("`Xcd` b\n");
      expect(typedInSource(seeded.text, { line: 1, ch: 1 })).toBe("`Xcd` b\n");
    });

    it("a mark with no children takes no units of the normalised sequence: with the store's root holding an empty link the editor's document cannot (DevEditor's own shape — the root is the source buffer's, the doc is the editor's), every live position is its own inverse and the text after it is where the source writes it", () => {
      // The one node class whose width is zero, and the only route to it: `[](u)` is a `link`
      // with no children, so `mdastToPM` writes nothing for it and the live document holds one
      // text node where the root holds three children — the walk's zero-width entry, whose end is
      // its start rather than the kept-character map's end of the unit before it.
      const { root, doc } = pair("a [](u) bc\n");
      const text = format(root);
      const block = targetBlock(doc);
      expect(block.node.childCount, "the live document holds no trace of the empty link").toBe(1);
      expect(block.node.textContent).toBe("a  bc");
      const map = cursorMap(root, doc);
      for (let live = 0; live <= block.node.content.size; live += 1) {
        const pos = block.start + live;
        expect(map.toRendered(map.toSource(pos)), `the inverse at ${pos}`).toBe(pos);
      }
      // The zero-width entry does not shift its neighbours: the caret before `bc` answers the
      // column the source writes `b` at, not one short of it.
      expect(map.toSource(block.start + 3)).toEqual({ line: 1, ch: text.indexOf("bc") });
      expect(map.toSource(block.start + 4)).toEqual({ line: 1, ch: text.indexOf("bc") + 1 });
    });

    it("reached every cell of the enumeration, and both sides of the clause the strip's dropped run has", () => {
      expect(new Set(reached).size).toBe(reached.length);
      expect(cases).toBe(reached.length);
      expect(cases).toBeGreaterThan(90);
      // Both outcomes: whitespace dropped from *inside* a kept node (a lead in a text run, a
      // collapsed line-ending run) and whitespace dropped *whole*, leaving a gap between two kept
      // nodes — the hole in the correspondence the block's-start clause of `toSource` is for.
      expect(gaps).toBeGreaterThan(0);
      expect(insideNodes).toBeGreaterThan(0);
      expect(gaps + insideNodes).toBe(cases);
      // The excluded positions are the dropped ones, and there is at least one per case.
      expect(droppedPositions).toBeGreaterThanOrEqual(cases);
      // The backlog class above is reached, and it is a minority of what the enumeration asserts.
      expect(excludedPositions).toBeGreaterThan(0);
      expect(excludedPositions).toBeLessThan(droppedPositions);
    });
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

/**
 * Kept apart from the suite above, which injects a clock: this is the one case that runs the
 * default timer, so `setTimeout` and the `clearTimeout` its cancel returns are both exercised.
 */
describe("the default timer", () => {
  it("schedules the deferred commit with setTimeout, and clears it on the next keystroke", () => {
    vi.useFakeTimers();
    try {
      const store = storeFor("");
      const binding = bindCodeMirror(store, new FakeSourceView());

      binding.change("a\n");
      vi.advanceTimersByTime(COALESCE_WINDOW_MS - 1);
      expect(format(store.getState().document.root)).toBe("");

      // The reschedule: if the first timer were still live it would fire one tick from here.
      binding.change("ab\n");
      vi.advanceTimersByTime(COALESCE_WINDOW_MS - 1);
      expect(format(store.getState().document.root)).toBe("");

      vi.advanceTimersByTime(1);
      expect(format(store.getState().document.root)).toBe("ab\n");
      binding.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
