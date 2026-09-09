import type { Root, Yaml } from "mdast";
import {
  createUndoStack,
  current,
  endCoalescing,
  format,
  push,
  redo,
  undo,
  type DocumentState,
  type PushOptions,
  type Sidecar,
  type UndoStack,
  type UndoStackOptions,
} from "@essaydown/core";
import type { Extension } from "@codemirror/state";
import { keymap as codeMirrorKeymap, type KeyBinding } from "@codemirror/view";
import { keymap as proseMirrorKeymap } from "prosemirror-keymap";
import type { Command, EditorState, Plugin, Transaction } from "prosemirror-state";
import { createStore, type StoreApi } from "zustand/vanilla";
import { mdastToPM, pmToMdast } from "./schema.js";

/**
 * The Zustand document store of PRD §4 and §6.5: one `{root, sidecar}` snapshot stack (task
 * 0.11's `core/undo.ts`) that every view edits through, so Cmd/Ctrl+Z means the same thing in the
 * rendered view, in the source view, and in every mode.
 *
 * **The stack stays in `core`.** Nothing about undo is decided here — coalescing, the 1 s window,
 * the 500 cap and the structural sharing are all `core/undo.ts`'s, and this module only holds the
 * one mutable cell the app needs (`core` is pure by CLAUDE.md, so it cannot own a cell) and
 * translates between that cell and the two editors.
 *
 * **Direction of travel.** The store is the document; a view is a projection of it. An edit goes
 * view → store ({@link DocumentBinding.dispatch}), and every other change of the current snapshot
 * — an undo, a redo, later a mode mutation — goes store → view, pulled by the subscription
 * {@link bindProseMirror} installs. The two are told apart by *reference*: the binding remembers
 * the `Root` object the view is currently showing, and `push` stores a root by reference, so a
 * store change whose root is that same object is the binding's own commit coming back and is
 * ignored. Nothing here compares serialised bytes to decide whether to re-render.
 *
 * **No built-in histories.** `prosemirror-history` and `@codemirror/commands` are not installed
 * anywhere in this workspace (PRD §4: "ProseMirror's and CodeMirror's built-in histories are
 * disabled"), so the keymaps below are the only undo bindings either editor has. Task 1.19
 * removed the `codemirror` kitchen-sink package, the one thing that had put `@codemirror/commands`
 * into `pnpm-lock.yaml` though nothing imported it; `test/no-codemirror-history.test.ts` reads the
 * manifest and the lockfile's `packages/editor` importer so the claim stays a test, not a comment.
 */

/** §6.5's typing burst: every doc-changing ProseMirror transaction carries this coalescing key. */
export const TYPING_KEY = "typing";

/** The store's state: the stack, the snapshot it currently shows, and the four store actions. */
export interface DocumentStoreState {
  /** The whole history. `document` is always `current(stack)`. */
  readonly stack: UndoStack;
  /**
   * The snapshot the document currently shows, kept beside the stack so a subscriber can select
   * it directly. Its identity is the stack entry's, so it changes only when the snapshot does.
   */
  readonly document: DocumentState;
  /** Push a committed mutation (`core`'s `push`, with this store's stack). */
  commit(root: Root, sidecar: Sidecar, options?: PushOptions): void;
  /** Step back one snapshot. */
  undo(): void;
  /** Step forward one snapshot. */
  redo(): void;
  /** End the open coalescing group without pushing (§6.5's source/rendered toggle). */
  endCoalescing(): void;
}

export type DocumentStore = StoreApi<DocumentStoreState>;

/**
 * A store holding one document, seeded with the snapshot it was opened at. `options` are the undo
 * stack's ({@link UndoStackOptions}), which is where the cap and the coalescing window live.
 */
export function createDocumentStore(
  root: Root,
  sidecar: Sidecar,
  options: UndoStackOptions = {},
): DocumentStore {
  return createStore<DocumentStoreState>((set, get) => {
    const seed = createUndoStack(root, sidecar, options);
    const move = (next: UndoStack): void => set({ stack: next, document: current(next) });
    return {
      stack: seed,
      document: current(seed),
      commit: (nextRoot, nextSidecar, pushOptions) =>
        move(push(get().stack, nextRoot, nextSidecar, pushOptions)),
      undo: () => move(undo(get().stack)),
      redo: () => move(redo(get().stack)),
      endCoalescing: () => move(endCoalescing(get().stack)),
    };
  });
}

/**
 * A one-slot memo of a root's canonical Markdown, keyed on the root's *identity*.
 *
 * A reader of "what does the store currently serialise to?" is called far more often than the
 * store changes: `useSyncExternalStore` calls its snapshot getter on every render and on every
 * notification, so `/dev/editor` was running `format(root)` several times per keystroke over the
 * whole document (task 1.10's phase check; DECISIONS #review-1-r0 F5). `push` stores a root by
 * reference — the same identity both bindings' echo guards are built on — so a read whose root is
 * the one already serialised answers with the string instance it produced last time and `format`
 * runs once per committed snapshot.
 *
 * One slot, not a map: the readers are all "the current snapshot", and a cache that outlived the
 * snapshot would hold every root an undo stack has ever had. Alternating between two roots
 * therefore re-serialises, which is what the stack's own `undo`/`redo` do anyway.
 *
 * `serialise` is injected only so a test can count the calls; every caller uses the default.
 */
export function createFormatCache(
  serialise: (root: Root) => string = format,
): (root: Root) => string {
  let cached: Root | null = null;
  let text = "";
  return (root) => {
    if (root !== cached) {
      cached = root;
      text = serialise(root);
    }
    return text;
  };
}

/**
 * The front matter of a root, as `pmToMdast` wants it. PRD §6.1 keeps `yaml` opaque and it is
 * always the root's first child, so the editable document never holds it and every commit has to
 * re-attach the one the store already has.
 */
function frontMatterOf(root: Root): Yaml | null {
  const first = root.children[0];
  return first !== undefined && first.type === "yaml" ? first : null;
}

/**
 * The part of `EditorView` a binding uses: the current state, and the way to install a new one.
 * Narrowed to these two so the wiring is exercised headlessly — `prosemirror-view` is the only
 * thing in the stack that needs a DOM, and it contributes nothing to this direction of the
 * traffic (the same argument `test/typing.ts` makes for the input rules).
 */
export interface BoundView {
  readonly state: EditorState;
  updateState(state: EditorState): void;
}

export interface BindOptions {
  /** The coalescing key doc-changing transactions carry; {@link TYPING_KEY} by default. */
  readonly coalesceKey?: string;
  /** Injected clock, so a test can place two bursts an exact distance apart. */
  readonly now?: () => number;
}

export interface DocumentBinding {
  /** Apply one transaction and commit it. This is the view's `dispatchTransaction`. */
  dispatch(transaction: Transaction): void;
  /** Stop pulling store changes into the view. */
  destroy(): void;
}

/**
 * Wire a rendered (ProseMirror) view to `store`, in both directions, and pull the store's current
 * document into the view straight away — the store is the document, so a freshly bound view shows
 * what the store holds rather than whatever it was constructed with.
 *
 * A transaction that leaves the document alone (a selection move, a decoration refresh) is applied
 * and nothing is pushed: §6.5 pushes *committed mutations*, and a cursor move is not one.
 *
 * The pull replaces the whole document in one step rather than rebuilding the `EditorState`, so
 * the view keeps its plugins and its plugin state across an undo.
 */
export function bindProseMirror(
  store: DocumentStore,
  view: BoundView,
  options: BindOptions = {},
): DocumentBinding {
  const coalesceKey = options.coalesceKey ?? TYPING_KEY;
  const now = options.now ?? Date.now;
  /** The `Root` the view is currently showing; see the module comment on reference identity. */
  let shown = store.getState().document.root;

  const pull = (root: Root): void => {
    shown = root;
    const { doc } = mdastToPM(root);
    // The initial pull of a view already built from this root, and a re-entrant notification for
    // a snapshot that happens to hold the same document, both land here with nothing to do.
    if (doc.eq(view.state.doc)) return;
    const transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    view.updateState(view.state.apply(transaction));
  };

  pull(shown);
  const unsubscribe = store.subscribe((state) => {
    if (state.document.root !== shown) pull(state.document.root);
  });

  return {
    dispatch(transaction) {
      const next = view.state.apply(transaction);
      view.updateState(next);
      if (!transaction.docChanged) return;
      const { document, commit } = store.getState();
      const root = pmToMdast({ doc: next.doc, frontMatter: frontMatterOf(document.root) });
      shown = root;
      commit(root, document.sidecar, { coalesceKey, at: now() });
    },
    destroy: unsubscribe,
  };
}

/**
 * The two chords of §6.5, spelled the three ways the two keymap libraries can name them.
 *
 * Cmd/Ctrl+Z is one name. Cmd/Ctrl+Shift+Z is two, because a shifted letter reaches a keymap by
 * two different routes and which one fires depends on the browser: `KeyboardEvent.key` is `"Z"`,
 * which both `prosemirror-keymap` and `@codemirror/view` look up with the shift modifier dropped
 * (`Mod-Z`), while their `keyCode` fallback re-derives the unshifted `"z"` and looks it up with
 * the modifier kept (`Shift-Mod-z`). Binding one name only would leave the chord dead wherever
 * the other route is taken, so both are bound to the same command.
 */
const KEY_NAMES = {
  undo: "Mod-z",
  redoShiftedLetter: "Mod-Z",
  redoFromKeyCode: "Shift-Mod-z",
} as const;

/** Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z for the rendered view, dispatched at the store. */
export function undoKeymap(store: DocumentStore): Record<string, Command> {
  const undoCommand: Command = () => {
    store.getState().undo();
    return true;
  };
  const redoCommand: Command = () => {
    store.getState().redo();
    return true;
  };
  return {
    [KEY_NAMES.undo]: undoCommand,
    [KEY_NAMES.redoShiftedLetter]: redoCommand,
    [KEY_NAMES.redoFromKeyCode]: redoCommand,
  };
}

/**
 * The plugins that make a ProseMirror view the store's. Kept apart from `editorPlugins` so the
 * store bindings sit *before* the editing keymaps and cannot be shadowed by them, and so a caller
 * that has no store (the headless typing harness) still has an editor.
 */
export function storePlugins(store: DocumentStore): Plugin[] {
  return [proseMirrorKeymap(undoKeymap(store))];
}

/** The same two chords for the source view. */
export function undoKeyBindings(store: DocumentStore): KeyBinding[] {
  const run = (action: "undo" | "redo") => (): boolean => {
    store.getState()[action]();
    return true;
  };
  return [
    { key: KEY_NAMES.undo, run: run("undo"), preventDefault: true },
    { key: KEY_NAMES.redoShiftedLetter, run: run("redo"), preventDefault: true },
    { key: KEY_NAMES.redoFromKeyCode, run: run("redo"), preventDefault: true },
  ];
}

/** {@link undoKeyBindings} as a CodeMirror extension, to sit beside `sourceExtensions()`. */
export function sourceUndoKeymap(store: DocumentStore): Extension {
  return codeMirrorKeymap.of(undoKeyBindings(store));
}
