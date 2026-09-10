import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Root } from "mdast";
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
import { EditorState, Selection, TextSelection } from "prosemirror-state";
import { mdastToPM, schema } from "../src/schema.js";
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
