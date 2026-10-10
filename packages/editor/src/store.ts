import type { Root, Yaml } from "mdast";
import {
  amendSidecar,
  carryEdit,
  createUndoStack,
  current,
  endCoalescing,
  format,
  push,
  redo,
  undo,
  type DocumentState,
  type PushOptions,
  type TopLevelEdit,
  type Sidecar,
  type UndoStack,
  type UndoStackOptions,
} from "@essaydown/core";
import type { Extension } from "@codemirror/state";
import { keymap as codeMirrorKeymap, type KeyBinding } from "@codemirror/view";
import { keymap as proseMirrorKeymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import { Selection, type Command, type EditorState, type Plugin, type Transaction } from "prosemirror-state";
import { createStore, type StoreApi } from "zustand/vanilla";
import { LINE_ENDING, keptCharacters, mdastToPM, pmToMdastWithSources, schema } from "./schema.js";

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
 * — an undo, a redo, a mode mutation ({@link DocumentStoreState.dispatch}) — goes store → view,
 * pulled by the subscription
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

/**
 * A mode mutation (PRD §6.3, §6.5): one of `core`'s pure `DocumentState → DocumentState` functions
 * (`applyMoveBlock`, `applyMoveSection`, `applyReorderSentences`, …) with its arguments bound. The
 * store hands it the snapshot it currently shows and pushes what it returns, so a mode never
 * builds a root itself and every mode edit is one undo step holding both halves.
 */
export type ModeMutation = (state: DocumentState) => DocumentState;

/**
 * The store's state: the stack, the snapshot it currently shows, the cursor, and the store actions.
 */
export interface DocumentStoreState {
  /** The whole history. `document` is always `current(stack)`. */
  readonly stack: UndoStack;
  /**
   * The snapshot the document currently shows, kept beside the stack so a subscriber can select
   * it directly. Its identity is the stack entry's, so it changes only when the snapshot does.
   */
  readonly document: DocumentState;
  /**
   * The rendered view's caret as a ProseMirror position (`selection.head`; PRD §6.1: the store
   * tracks the cursor by ProseMirror position), or `null` before a view has reported one. Not part
   * of any snapshot: a cursor move is not an edit, so it never pushes and an undo never restores it.
   */
  readonly cursor: number | null;
  /** Record the caret; a no-op when it is already there, so a subscriber is not woken for nothing. */
  setCursor(position: number): void;
  /**
   * Apply a {@link ModeMutation} to the current snapshot and push its result as one undo step: no
   * coalescing key, so it never merges with a typing burst or with the next mode mutation. A
   * mutation that returns the snapshot it was given (both halves, by reference) pushes nothing.
   */
  dispatch(mutation: ModeMutation): void;
  /**
   * Make `sidecar` the present snapshot's sidecar without pushing (`core`'s `amendSidecar`): the
   * pane adopts a sidecar another writer put on disk (task 3.2), which is not an edit and so is
   * no undo step. A no-op when the present sidecar already is `sidecar`.
   */
  adoptSidecar(sidecar: Sidecar): void;
  /** Push a committed mutation (`core`'s `push`, with this store's stack). */
  commit(root: Root, sidecar: Sidecar, options?: PushOptions): void;
  /** Step back one snapshot. */
  undo(): void;
  /** Step forward one snapshot. */
  redo(): void;
  /** End the open coalescing group without pushing (§6.5's source/rendered toggle). */
  endCoalescing(): void;
  /**
   * Commit a source burst that is still only in the CodeMirror buffer (task 3.19; DECISIONS #054).
   * The source view commits at the end of a burst (`bindCodeMirror`), so a reader or a writer that
   * is not the source view itself would otherwise see — or write over — a snapshot that lags the
   * buffer by up to one window (CLAUDE.md's stale-read rule). A no-op until a source binding has
   * registered its flush through {@link registerSettle}, and again after that binding is destroyed.
   * {@link dispatch}, {@link undo} and {@link redo} call it first, so a mode mutation lands on top
   * of the typed text and an undo steps back over the burst rather than dropping it.
   */
  settle(): void;
  /**
   * Make `flush` what {@link settle} runs, and return the unregister. The unregister clears the seam
   * only while it is still this registration's, so a binding destroyed after a newer one registered
   * never disarms the newer one.
   */
  registerSettle(flush: () => void): () => void;
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
    /** The registered source binding's flush; see {@link DocumentStoreState.settle}. */
    let settler: (() => void) | null = null;
    const settle = (): void => settler?.();
    return {
      stack: seed,
      document: current(seed),
      cursor: null,
      setCursor: (position) => {
        if (get().cursor !== position) set({ cursor: position });
      },
      dispatch: (mutation) => {
        settle();
        const before = get().document;
        const after = mutation(before);
        if (after.root === before.root && after.sidecar === before.sidecar) return;
        move(push(get().stack, after.root, after.sidecar));
      },
      adoptSidecar: (sidecar) => {
        const next = amendSidecar(get().stack, sidecar);
        if (next !== get().stack) move(next);
      },
      commit: (nextRoot, nextSidecar, pushOptions) =>
        move(push(get().stack, nextRoot, nextSidecar, pushOptions)),
      undo: () => {
        settle();
        move(undo(get().stack));
      },
      redo: () => {
        settle();
        move(redo(get().stack));
      },
      endCoalescing: () => move(endCoalescing(get().stack)),
      settle,
      registerSettle: (flush) => {
        settler = flush;
        return () => {
          if (settler === flush) settler = null;
        };
      },
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
 * and nothing is pushed: §6.5 pushes *committed mutations*, and a cursor move is not one. Every
 * transaction and every pull reports the view's caret to the store ({@link DocumentStoreState.cursor}).
 *
 * The pull replaces the whole document in one step rather than rebuilding the `EditorState`, so
 * the view keeps its plugins and its plugin state across an undo.
 */
/**
 * The transaction that turns `state.doc` into `doc` — the whole content replaced, so the view
 * holds exactly the store's document — with the caret placed by where the two documents differ
 * (`Fragment.findDiffStart`/`findDiffEnd`) rather than mapped through the whole-document
 * replacement, which would send it to the end of the document. The rule is the mapping of a
 * replace step over just the changed range: a caret before it keeps its position, one after it
 * moves by the change in size, and one inside it or on its edge goes to the end of the new range
 * (so a load into an empty view still leaves the caret after the loaded text, as before). So a mode mutation that rewrites one sentence (task 3.4's "Use this"), or an undo of
 * it, leaves the caret in the paragraph it was in, and Rewrite's sidebar on that paragraph.
 *
 * Called only for documents that differ (`bindProseMirror`'s `pull` checks `eq` first), so both
 * diff ends exist.
 */
function replaceKeepingCaret(state: EditorState, doc: EditorState["doc"]): Transaction {
  const transaction = state.tr.replaceWith(0, state.doc.content.size, doc.content);
  const start = state.doc.content.findDiffStart(doc.content) as number;
  const end = state.doc.content.findDiffEnd(doc.content) as { a: number; b: number };
  const head = state.selection.head;
  // A diff whose ends overlap (a repeated run inserted or removed) ends no earlier than it starts.
  const endA = Math.max(end.a, start);
  const position =
    head < start
      ? head
      : head > endA
        ? head + doc.content.size - state.doc.content.size
        : Math.max(end.b, start);
  return transaction.setSelection(Selection.near(transaction.doc.resolve(position)));
}

/**
 * One doc-changing transaction as core's `carryEdit` reads it (task 4.9; PRD §6.2, in-app
 * operations update anchors live), in the indices of the two mdast roots either side of it.
 * `offset` is the front matter the editable document never holds (1 when the root has it);
 * `sources` is {@link pmToMdastWithSources}' list for `transaction.doc`, and the same list for
 * `transaction.before` is computed only when the sidecar has an entry to ask about.
 *
 * **Regions** are {@link replacedRuns}, with every block the conversion drops left out (it has
 * no mdast index and no candidates).
 *
 * **mapBlock**: an old block goes to the block holding its first content position, mapped forward
 * with the position kept after anything inserted there — a block typed above or below leaves it
 * where its own text went, a split at its start sends it to the half its text kept, a join at its
 * start to the block it merged into. It goes nowhere when that position's next token was deleted,
 * or when the block it lands in is one the conversion drops.
 *
 * **mapOffset** (task 4.26; DECISIONS #review-4-r0 U2): the same mapping one character at a time.
 * A plain-text offset of an old paragraph becomes a live position through the paragraph's own
 * kept-character map ({@link keptCharacters}: the characters the editor holds, never widths read
 * from the converted tree), goes through the transaction's mapping kept after anything inserted
 * there, and comes back through the kept-character map of the paragraph it landed in. It goes
 * nowhere when that character was deleted, or when it lands outside a top-level paragraph the
 * conversion keeps — and `carryEdit` falls back to `mapBlock` there.
 */
export function carryThrough(
  transaction: Transaction,
  offset: number,
  sources: readonly number[],
): TopLevelEdit {
  let before: readonly number[] | null = null;
  const beforeSources = (): readonly number[] =>
    (before ??= pmToMdastWithSources({ doc: transaction.before, frontMatter: null }).sources);
  const toMdast = (list: readonly number[], blocks: readonly number[]): number[] =>
    blocks.flatMap((block) => {
      const at = list.indexOf(block);
      return at === -1 ? [] : [at + offset];
    });

  return {
    regions: () =>
      replacedRuns(transaction.before, transaction.doc).map((run) => ({
        before: toMdast(beforeSources(), run.before),
        after: toMdast(sources, run.after),
      })),
    mapBlock: (index) => {
      const old = beforeSources()[index - offset];
      if (old === undefined) return null;
      let from = 0;
      for (let i = 0; i < old; i += 1) from += transaction.before.child(i).nodeSize;
      const inner = transaction.mapping.mapResult(from + 1, 1);
      if (inner.deleted) return null;
      const at = sources.indexOf(transaction.doc.resolve(inner.pos).index(0));
      return at === -1 ? null : at + offset;
    },
    mapOffset: (index, plain) => {
      const old = beforeSources()[index - offset];
      if (old === undefined) return null;
      const block = transaction.before.child(old);
      if (block.type !== schema.nodes.paragraph) return null;
      let from = 0;
      for (let i = 0; i < old; i += 1) from += transaction.before.child(i).nodeSize;
      const was = keptCharacters(childrenOf(block), LINE_ENDING);
      const live = was.liveOf(keptOffset(was.nodes, plain));
      const inner = transaction.mapping.mapResult(from + 1 + live, 1);
      if (inner.deleted) return null;
      const $pos = transaction.doc.resolve(inner.pos);
      if ($pos.depth !== 1 || $pos.parent.type !== schema.nodes.paragraph) return null;
      const at = sources.indexOf($pos.index(0));
      if (at === -1) return null;
      const kept = keptCharacters(childrenOf($pos.parent), LINE_ENDING);
      return { index: at + offset, offset: plainOffset(kept.nodes, kept.offsetOf($pos.parentOffset)) };
    },
  };
}

function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((child) => out.push(child));
  return out;
}

/**
 * How many plain-text units (core's `paragraphText`) a kept inline node holds: its text, an
 * image's alt, an inline tag's value, one for a break. ProseMirror counts an atom as one.
 */
function plainWidth(node: PMNode): number {
  if (node.isText) return (node.text as string).length;
  if (node.type === schema.nodes.image) return ((node.attrs.alt as string | null) ?? "").length;
  if (node.type === schema.nodes.raw_inline) return (node.attrs.value as string).length;
  return node.nodeSize;
}

/**
 * The kept offset before the character at plain-text offset `plain` in `nodes`; past the last
 * character, the end. **Ownership, stated once:** the nodes partition the plain text into
 * adjacent half-open slices, and an offset belongs to the node whose slice holds it — an offset
 * inside an atom's text (an image's alt, an inline tag's value) to the atom's start, since the
 * atom is one position wide, and a zero-width atom (an image with no alt) to nothing, so the
 * offset at one is the start of whatever follows it.
 */
function keptOffset(nodes: readonly PMNode[], plain: number): number {
  let kept = 0;
  let seen = 0;
  for (const node of nodes) {
    const width = plainWidth(node);
    if (plain < seen + width) return node.isText ? kept + plain - seen : kept;
    kept += node.nodeSize;
    seen += width;
  }
  return kept;
}

/**
 * The plain-text offset of kept offset `at` in `nodes`, the inverse of {@link keptOffset}: a
 * position before an atom (zero-width or not) is the offset its text starts at.
 */
function plainOffset(nodes: readonly PMNode[], at: number): number {
  let kept = 0;
  let seen = 0;
  for (const node of nodes) {
    if (at < kept + node.nodeSize) return node.isText ? seen + at - kept : seen;
    kept += node.nodeSize;
    seen += plainWidth(node);
  }
  return seen;
}

/**
 * The runs of top-level blocks a transaction replaced, read from ProseMirror's structural sharing:
 * a block the transaction did not touch is the same node object in both documents. Old blocks are
 * matched to new ones greedily in document order; a new block that is not an old one, or is one
 * already passed (a node moved, or reused twice by a paste), belongs to the current run, and every
 * old block skipped over by a match is replaced. The matched blocks are therefore in the same order
 * on both sides and every run sits between the same two of them — which is all `carryEdit` relies
 * on; a run larger than the edit is only slower, never wrong.
 */
export function replacedRuns(
  before: PMNode,
  after: PMNode,
): { before: number[]; after: number[] }[] {
  const oldIndex = new Map<PMNode, number>();
  before.forEach((child, _offset, index) => oldIndex.set(child, index));
  const runs: { before: number[]; after: number[] }[] = [];
  let run: { before: number[]; after: number[] } = { before: [], after: [] };
  let kept = -1;
  const close = (upTo: number): void => {
    for (let i = kept + 1; i < upTo; i += 1) run.before.push(i);
    if (run.before.length + run.after.length > 0) runs.push(run);
    run = { before: [], after: [] };
  };
  after.forEach((child, _offset, index) => {
    const old = oldIndex.get(child);
    if (old === undefined || old <= kept) {
      run.after.push(index);
      return;
    }
    close(old);
    kept = old;
  });
  close(before.childCount);
  return runs;
}

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
    if (!doc.eq(view.state.doc)) view.updateState(view.state.apply(replaceKeepingCaret(view.state, doc)));
    store.getState().setCursor(view.state.selection.head);
  };

  pull(shown);
  const unsubscribe = store.subscribe((state) => {
    if (state.document.root !== shown) pull(state.document.root);
  });

  return {
    dispatch(transaction) {
      const next = view.state.apply(transaction);
      view.updateState(next);
      if (transaction.docChanged) {
        const { document, commit } = store.getState();
        const frontMatter = frontMatterOf(document.root);
        const after = pmToMdastWithSources({ doc: next.doc, frontMatter });
        const root = after.root;
        shown = root;
        const sidecar = carryEdit(
          document,
          root,
          carryThrough(transaction, frontMatter === null ? 0 : 1, after.sources),
        );
        commit(root, sidecar, { coalesceKey, at: now() });
      }
      store.getState().setCursor(next.selection.head);
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

/**
 * The same two chords for the source view, with the seam that settles a pending source burst
 * before history moves (DECISIONS #review-1-r1 G2).
 *
 * The source view commits on the burst boundary (task 1.17's `bindCodeMirror`), so a chord pressed
 * inside the window runs against history that does not contain what is on screen — and the pull
 * the undo then causes *drops* the pending text, which is how Sol's reproduction (b) lost ` second`
 * for good. `beforeHistory` is called first by every one of the three bindings, so there is one
 * seam for all of them and no command can be added later that skips it.
 *
 * **Why a hook here and not a keymap installed by the binding.** The alternative was for
 * `bindCodeMirror` to install this keymap itself, which reads better but cannot be built: a
 * CodeMirror view's extensions are fixed when the view is constructed, and the binding is
 * constructed *from* the view (it needs `view.state`), so a binding that owned the keymap would
 * have to reconfigure a live view through a compartment — machinery added to fix machinery — and
 * it would widen `BoundSourceView` from the two members that keep the binding headlessly testable
 * to a real `EditorView`. The hook keeps the dependency pointing one way: the keymap knows only
 * "settle whatever is pending", never that a source binding exists. It is optional because the
 * chords are meaningful without one (a view with no deferred commit has nothing to settle), and
 * `DevEditor` passes the binding's `flush`.
 */
export function undoKeyBindings(store: DocumentStore, beforeHistory?: () => void): KeyBinding[] {
  const run = (action: "undo" | "redo") => (): boolean => {
    beforeHistory?.();
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
export function sourceUndoKeymap(store: DocumentStore, beforeHistory?: () => void): Extension {
  return codeMirrorKeymap.of(undoKeyBindings(store, beforeHistory));
}
