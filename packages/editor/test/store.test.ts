import { describe, expect, it, vi } from "vitest";
import type { Root } from "mdast";
import { canRedo, canUndo, emptySidecar, format, parse, type Sidecar } from "@essaydown/core";
import { EditorState, Selection, TextSelection, type Transaction } from "prosemirror-state";
import { keydownHandler } from "prosemirror-keymap";
import type { EditorView as PMEditorView } from "prosemirror-view";
import { EditorState as CMState } from "@codemirror/state";
import { editorPlugins } from "../src/input.js";
import { mdastToPM, pmToMdast } from "../src/schema.js";
import {
  TYPING_KEY,
  bindProseMirror,
  createDocumentStore,
  sourceUndoKeymap,
  storePlugins,
  undoKeyBindings,
  undoKeymap,
  type BoundView,
  type DocumentStore,
} from "../src/store.js";

/**
 * The headless half of task 1.6. `e2e/web/editor-undo.spec.ts` is the acceptance — it types into a
 * real browser and presses the real chord — and this file is where the store, the binding and the
 * two keymaps are covered, and where one test is written per guard in the diff.
 *
 * Every timing test injects `now`, so nothing here waits on a wall clock: the 1 s window is
 * `core/undo.ts`'s and is already its own task's (0.11); what is proved here is that the binding
 * hands it a key and a time at all, and does so once per doc-changing transaction.
 */

const SIDECAR: Sidecar = emptySidecar();

/** A stand-in for `EditorView` holding only what `BoundView` names; see the module comment. */
class FakeView implements BoundView {
  state: EditorState;
  /** Every state this view was ever given, so a test can count re-renders as well as read one. */
  readonly applied: EditorState[] = [];

  constructor(root: Root) {
    this.state = EditorState.create({ doc: mdastToPM(root).doc, plugins: editorPlugins() });
  }

  updateState(state: EditorState): void {
    this.state = state;
    this.applied.push(state);
  }

  /** The Markdown the view currently shows. Every document bound here has no front matter. */
  markdown(): string {
    return format(pmToMdast({ doc: this.state.doc, frontMatter: null }));
  }
}

/** The transaction typing `text` at the end of the document. */
function typeAtEnd(state: EditorState, text: string): Transaction {
  const end = Selection.atEnd(state.doc).from;
  return state.tr.insertText(text, end);
}

/** A store, a view bound to it, and a clock the test moves by hand. */
function bound(source: string, options: { start?: number } = {}) {
  const root = parse(source);
  const store = createDocumentStore(root, SIDECAR);
  const view = new FakeView(root);
  const clock = { at: options.start ?? 1_000 };
  const binding = bindProseMirror(store, view, { now: () => clock.at });
  return { store, view, clock, binding, root };
}

/** Type `text` as one transaction at `clock.at`, the way `dispatchTransaction` would. */
function type(
  context: ReturnType<typeof bound>,
  text: string,
  at: number = context.clock.at,
): void {
  context.clock.at = at;
  context.binding.dispatch(typeAtEnd(context.view.state, text));
}

describe("createDocumentStore", () => {
  it("seeds the stack with the document it was opened at", () => {
    const root = parse("# Title\n");
    const store = createDocumentStore(root, SIDECAR);
    expect(store.getState().document).toEqual({ root, sidecar: SIDECAR });
    expect(store.getState().stack.entries).toHaveLength(1);
    expect(canUndo(store.getState().stack)).toBe(false);
  });

  it("keeps `document` identical to the stack's current entry through every action", () => {
    const store = createDocumentStore(parse("a\n"), SIDECAR);
    const seen: unknown[] = [];
    store.subscribe((state) => seen.push(state.document));
    const next = parse("b\n");
    store.getState().commit(next, SIDECAR);
    expect(store.getState().document.root).toBe(next);
    store.getState().undo();
    expect(format(store.getState().document.root)).toBe("a\n");
    store.getState().redo();
    expect(format(store.getState().document.root)).toBe("b\n");
    const { stack, document } = store.getState();
    expect(document).toBe(stack.entries[stack.index].state);
    expect(seen).toHaveLength(3);
  });

  it("passes its options through to the undo stack, and endCoalescing closes the group", () => {
    const store = createDocumentStore(parse("a\n"), SIDECAR, { cap: 2, coalesceWindowMs: 5 });
    expect(store.getState().stack.cap).toBe(2);
    store.getState().commit(parse("b\n"), SIDECAR, { coalesceKey: TYPING_KEY, at: 0 });
    expect(store.getState().stack.openKey).toBe(TYPING_KEY);
    store.getState().endCoalescing();
    expect(store.getState().stack.openKey).toBeNull();
    // The group is closed, so a second push inside the window is a second step, not a merge.
    store.getState().commit(parse("c\n"), SIDECAR, { coalesceKey: TYPING_KEY, at: 1 });
    expect(store.getState().stack.entries).toHaveLength(2);
    expect(format(store.getState().stack.entries[0].state.root)).toBe("b\n");
  });
});

describe("bindProseMirror: view -> store", () => {
  it("pushes one coalesced 'typing' snapshot per doc-changing transaction", () => {
    const context = bound("");
    type(context, "one", 1_000);
    type(context, " two", 1_100);
    type(context, " three", 1_200);
    const { stack } = context.store.getState();
    expect(format(stack.entries[stack.index].state.root)).toBe("one two three\n");
    // Three transactions, one undo step: the seed and the burst.
    expect(stack.entries).toHaveLength(2);
    expect(stack.entries[1].coalesceKey).toBe(TYPING_KEY);
  });

  it("starts a new step for a burst outside the coalescing window", () => {
    const context = bound("");
    type(context, "first", 1_000);
    type(context, " second", 2_500);
    expect(context.store.getState().stack.entries).toHaveLength(3);
  });

  it("takes the coalescing key from its options", () => {
    const context = bound("");
    context.binding.destroy();
    const other = bindProseMirror(context.store, context.view, {
      coalesceKey: "source",
      now: () => 1_000,
    });
    other.dispatch(typeAtEnd(context.view.state, "x"));
    const { stack } = context.store.getState();
    expect(stack.entries[stack.index].coalesceKey).toBe("source");
  });

  it("pushes nothing for a transaction that leaves the document alone", () => {
    const context = bound("hello\n");
    const selection = TextSelection.create(context.view.state.doc, 1);
    context.binding.dispatch(context.view.state.tr.setSelection(selection));
    expect(context.store.getState().stack.entries).toHaveLength(1);
    expect(context.view.state.selection.from).toBe(1);
  });

  it("re-attaches the store's front matter to every commit, byte for byte", () => {
    const source = "---\nquestion: 'why?'\n---\n\nbody\n";
    const context = bound(source);
    type(context, "!");
    expect(format(context.store.getState().document.root)).toBe(
      "---\nquestion: 'why?'\n---\n\nbody!\n",
    );
  });

  it("commits a document with no front matter as one with none", () => {
    const context = bound("body\n");
    type(context, "!");
    expect(context.store.getState().document.root.children[0].type).toBe("paragraph");
  });

  it("carries the store's sidecar into the snapshot it pushes", () => {
    const context = bound("body\n");
    type(context, "!");
    expect(context.store.getState().document.sidecar).toBe(SIDECAR);
  });
});

describe("bindProseMirror: store -> view", () => {
  it("does not touch a view that already shows the store's document", () => {
    const context = bound("# Title\n\nbody\n");
    expect(context.view.applied).toHaveLength(0);
  });

  it("pulls the store's document into a view built from a different one", () => {
    const store = createDocumentStore(parse("# Title\n\nbody\n"), SIDECAR);
    const view = new FakeView(parse("something else\n"));
    bindProseMirror(store, view);
    expect(view.applied).toHaveLength(1);
    expect(view.markdown()).toBe("# Title\n\nbody\n");
  });

  it("puts an undone document back into the view, and a redone one back after it", () => {
    const context = bound("");
    type(context, "first", 1_000);
    type(context, " second", 2_500);
    expect(context.view.markdown()).toBe("first second\n");
    context.store.getState().undo();
    expect(context.view.markdown()).toBe("first\n");
    context.store.getState().redo();
    expect(context.view.markdown()).toBe("first second\n");
    expect(canRedo(context.store.getState().stack)).toBe(false);
  });

  it("keeps the view's plugins across a pull", () => {
    const context = bound("");
    type(context, "gone", 1_000);
    const before = context.view.state.plugins;
    context.store.getState().undo();
    expect(context.view.state.plugins).toBe(before);
  });

  it("ignores the store change its own commit caused", () => {
    const context = bound("");
    type(context, "x", 1_000);
    // One state for the typing, and none for the notification that followed it.
    expect(context.view.applied).toHaveLength(1);
  });

  it("ignores a store change that lands on the same root object", () => {
    const context = bound("a\n");
    const { root } = context.store.getState().document;
    context.store.getState().commit(root, emptySidecar());
    expect(context.view.applied).toHaveLength(0);
  });

  it("stops pulling after destroy", () => {
    const context = bound("");
    type(context, "x", 1_000);
    context.binding.destroy();
    context.store.getState().undo();
    expect(context.view.markdown()).toBe("x\n");
  });
});

/** A keydown event as the two keymap libraries read one; `keyCode` is the fallback route. */
function keyEvent(init: {
  key: string;
  keyCode: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

/** The view a `keydownHandler` reads: its state, and where to send a command's transaction. */
function handlerView(): PMEditorView {
  const state = EditorState.create({ doc: mdastToPM(parse("a\n")).doc });
  return { state, dispatch: () => undefined } as unknown as PMEditorView;
}

describe("undoKeymap (rendered view)", () => {
  function pressed(store: DocumentStore, event: KeyboardEvent): boolean {
    return keydownHandler(undoKeymap(store))(handlerView(), event);
  }

  function twoSteps(): DocumentStore {
    const store = createDocumentStore(parse("a\n"), SIDECAR);
    store.getState().commit(parse("b\n"), SIDECAR);
    return store;
  }

  it("undoes on Ctrl+z", () => {
    const store = twoSteps();
    expect(pressed(store, keyEvent({ key: "z", keyCode: 90, ctrlKey: true }))).toBe(true);
    expect(format(store.getState().document.root)).toBe("a\n");
  });

  it("redoes on the shifted-letter route, where the event's key is 'Z'", () => {
    const store = twoSteps();
    store.getState().undo();
    expect(pressed(store, keyEvent({ key: "Z", keyCode: 90, ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(format(store.getState().document.root)).toBe("b\n");
  });

  it("redoes on the keyCode route, where the event's key is not a letter", () => {
    const store = twoSteps();
    store.getState().undo();
    // A layout whose shifted `z` is not `Z`: only `base[90]` can name the binding here.
    expect(pressed(store, keyEvent({ key: "Ω", keyCode: 90, ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(format(store.getState().document.root)).toBe("b\n");
  });

  it("leaves an unmodified z alone", () => {
    const store = twoSteps();
    expect(pressed(store, keyEvent({ key: "z", keyCode: 90 }))).toBe(false);
    expect(format(store.getState().document.root)).toBe("b\n");
  });

  it("is installed by storePlugins, ahead of the editing keymaps", () => {
    const store = twoSteps();
    const plugins = storePlugins(store);
    expect(plugins).toHaveLength(1);
    const handle = plugins[0].props.handleKeyDown;
    expect(handle).toBeTypeOf("function");
    const view = handlerView();
    expect(handle?.call(plugins[0], view, keyEvent({ key: "z", keyCode: 90, ctrlKey: true }))).toBe(
      true,
    );
    expect(format(store.getState().document.root)).toBe("a\n");
  });
});

describe("undoKeyBindings (source view)", () => {
  it("binds the same three names, each preventing the browser's own undo", () => {
    const store = createDocumentStore(parse("a\n"), SIDECAR);
    const bindings = undoKeyBindings(store);
    expect(bindings.map((binding) => binding.key)).toEqual(["Mod-z", "Mod-Z", "Shift-Mod-z"]);
    expect(bindings.every((binding) => binding.preventDefault === true)).toBe(true);
  });

  it("runs undo and redo at the store", () => {
    const store = createDocumentStore(parse("a\n"), SIDECAR);
    store.getState().commit(parse("b\n"), SIDECAR);
    const [undoBinding, redoShifted, redoFromCode] = undoKeyBindings(store);
    const view = null as never;
    expect(undoBinding.run?.(view)).toBe(true);
    expect(format(store.getState().document.root)).toBe("a\n");
    expect(redoShifted.run?.(view)).toBe(true);
    expect(format(store.getState().document.root)).toBe("b\n");
    store.getState().undo();
    expect(redoFromCode.run?.(view)).toBe(true);
    expect(format(store.getState().document.root)).toBe("b\n");
  });

  it("is an extension a CodeMirror state accepts", () => {
    const store = createDocumentStore(parse("a\n"), SIDECAR);
    const state = CMState.create({ doc: "a", extensions: [sourceUndoKeymap(store)] });
    expect(state.doc.toString()).toBe("a");
  });
});

/** Kept out of the way of the suite above: `vi` is imported for this one assertion. */
describe("the default clock", () => {
  it("times a commit with Date.now when no clock is injected", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_234);
    try {
      const root = parse("");
      const store = createDocumentStore(root, SIDECAR, { at: 0 });
      const view = new FakeView(root);
      const binding = bindProseMirror(store, view);
      binding.dispatch(typeAtEnd(view.state, "x"));
      const { stack } = store.getState();
      expect(stack.entries[stack.index].at).toBe(1_234);
    } finally {
      now.mockRestore();
    }
  });
});
