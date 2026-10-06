import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { attach, emptySidecar, format, outlineOf, parse, parseSidecar, rewriteAssetUrls, type Sidecar } from "@essaydown/core";
import {
  bindCodeMirror,
  bindProseMirror,
  canonicalCursor,
  createDocumentStore,
  cursorMap,
  editorPlugins,
  questionHintsPlugin,
  renderedSelection,
  schema,
  sourceCursor,
  sourceExtensions,
  sourceOffset,
  sourceToggleKeymap,
  sourceUndoKeymap,
  storePlugins,
  toggleMode,
  togglePlugins,
  type DocumentStore,
  type DocumentStoreState,
  type EditorMode,
  type SourceBinding,
  type SourcePosition,
} from "@essaydown/editor";
import { EditorState as SourceEditorState } from "@codemirror/state";
import { EditorView as SourceEditorView } from "@codemirror/view";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import "prosemirror-view/style/prosemirror.css";
import "@essaydown/editor/src/source.css";
import type { Mode } from "../modes/modes";
import {
  createDocumentSync,
  MarkdownWritten,
  type DocumentSync,
  type FlushResult,
  type RenameOutcome,
} from "./document-sync";
import { createImageNodeView } from "./image-view";
import { imagePastePlugin } from "./image-paste";
import { sidecarPathFor, stemOf } from "./paths";
import { createSidecarBaseline } from "./sidecar-sync";
import { installTestHook, type TestHookHost } from "./test-hook";

/** What `loadDocument` read for one path: the file's bytes and its sidecar. */
export interface LoadedDocument {
  readonly text: string;
  readonly sidecar: Sidecar;
  /**
   * The sidecar's raw JSON text exactly as read from disk; null when no sidecar file exists. Kept
   * even when it did not parse (`sidecar` is then the empty default) — an unreadable file is never
   * adopted as ours, and `chooseSidecarForWrite` re-reads and re-tries it on every save rather than
   * treating it as a known-good baseline (DECISIONS #review-2-r0 U5).
   */
  readonly sidecarRaw: string | null;
}

/** `read_doc` + `read_sidecar` for a workspace-relative document path. */
export async function loadDocument(path: string): Promise<LoadedDocument> {
  const text = await invoke<string>("read_doc", { path });
  const raw = await invoke<string | null>("read_sidecar", { path: sidecarPathFor(path) });
  if (raw === null) return { text, sidecar: emptySidecar(), sidecarRaw: null };
  try {
    return { text, sidecar: parseSidecar(JSON.parse(raw)), sidecarRaw: raw };
  } catch {
    return { text, sidecar: emptySidecar(), sidecarRaw: raw };
  }
}

/** The one-line §6.1 banner text. */
export const NON_CANONICAL_MESSAGE = "This file will be saved in Essay Down's Markdown style";

export function storeFor(text: string, sidecar: Sidecar): DocumentStore {
  const root = parse(text);
  return createDocumentStore(root, attach(sidecar, root).sidecar);
}

export interface DocumentPaneHandle {
  /**
   * Save a pending edit now (before a rename, a switch or a delete moves the file). The caller
   * drops or moves the document only on `clean` or `saved` (document-sync.ts).
   */
  flush(): Promise<FlushResult>;
  /**
   * Rename the open document to `newPath` inside its sync's chain (document-sync.ts `renamed`):
   * `move` is the IPC that moves the files; the pane rewrites the document's image URLs to the new
   * stem and writes them, and reads and writes `newPath` from the move on.
   */
  rename(newPath: string, move: () => Promise<void>): Promise<RenameOutcome>;
}

interface Props {
  /** The canonical absolute folder `open_folder` returned, for resolving an image's relative `src`
   * against the document's directory (PRD §6.4). */
  readonly root: string;
  /** Workspace-relative; changes in place on a rename (after `rename` moved it), without a remount. */
  readonly path: string;
  readonly initial: LoadedDocument;
  /** §6.1's Undo-open: the user declined the first open of a non-canonical file. */
  readonly onUndoOpen: () => void;
  readonly onError: (message: string) => void;
  /**
   * The pane's document store, each time it is replaced (an open, a reload), and null when the
   * pane unmounts — so a mode's views outside the pane (the Outline's sidebar tree and question
   * list, task 3.2) read and edit the same store the editor does.
   */
  readonly onStore?: (store: DocumentStore | null) => void;
  /** The app's current mode (PRD §6.3): a view of the store, read here only for Produce's own
   * behaviour (the question hints and typewriter scrolling, task 3.3) — nothing it does changes
   * the document. */
  readonly mode: Mode;
  /** Settings' `typewriterScroll` (task 2.7), read only while `mode` is `"produce"`. */
  readonly typewriterScroll: boolean;
  /** A question hint's click (§6.3: "read-only; click → Outline"). */
  readonly onJumpToOutline: () => void;
  readonly ref?: Ref<DocumentPaneHandle>;
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** What {@link createPaneSync} reads and drives in the pane; every member is called at call time. */
export interface PaneSyncHost {
  /** The pane's store: a reload replaces it. */
  store(): DocumentStore;
  /** The document's workspace-relative path: a rename moves it. */
  path(): string;
  /** A rename's move landed at `path`. */
  moved(path: string): void;
  /** A reload's new store. */
  replaced(store: DocumentStore): void;
  /** Show or hide the 'Changed on disk' banner. */
  banner(shown: boolean): void;
  /** The text the pane believes is on disk moved (document-sync.ts `knownChanged`). */
  knownChanged(text: string): void;
  error(message: string): void;
}

/** The pane's sync and its handle, wired to a {@link PaneSyncHost} (one per `initial`). */
export interface PaneSync extends DocumentPaneHandle {
  readonly sync: DocumentSync;
  /** The store's subscriber: a snapshot change is an edit; a caret move or an adopted sidecar is not. */
  storeChanged(state: DocumentStoreState, previous: DocumentStoreState): void;
}

/**
 * The open document's save path (task 2.5): `document-sync.ts` over `read_doc`, `write_doc` and the
 * sidecar's re-read and write, and the handle's `flush` and `rename`. Out of the component so a
 * vitest drives the production sequence through the pane (tests/document-sync.test.ts).
 *
 * **Settled before deciding** (DECISIONS #review-3-r0 S1). The sync's `settle` is the store's: the
 * watcher's check and Keep mine commit a source burst still inside its window before they decide or
 * serialise, and the commit reports itself through {@link PaneSync.storeChanged} synchronously, so
 * the decision sees the document dirty.
 *
 * **A sidecar not written is a failed save** (DECISIONS #review-3-r0 S3). A disk sidecar that does
 * not parse is never overwritten (DECISIONS #review-2-r0 U5), so the save's sidecar half is a
 * `MarkdownWritten` failure naming the sidecar: the Markdown baseline stays the written text, the
 * document stays dirty and `flush` is `failed`, so no caller drops the in-memory sidecar.
 */
export function createPaneSync(initial: LoadedDocument, host: PaneSyncHost): PaneSync {
  // Set only while a save adopts the disk's sidecar into the store: external state, not an edit,
  // so `storeChanged` must not schedule another save for it.
  let adopting = false;
  // The sidecar's raw JSON text as this pane last read or wrote it (tasks 2.19, 2.23), reset on
  // every reload of this document (a new `initial`). Since task 3.2 the parsed half is the
  // store's: the Outline edits questions through it, so the store's present sidecar is every
  // write's source, and a sidecar adopted from the disk is put back into it in the same step as
  // the raw text moves (docs/V1.1-BACKLOG.md `[review-2-r1, sidecar baseline vs store]`).
  const baseline = createSidecarBaseline(initial.sidecarRaw, {
    current: () => host.store().getState().document.sidecar,
    adopt: (sidecar) => {
      adopting = true;
      try {
        host.store().getState().adoptSidecar(sidecar);
      } finally {
        adopting = false;
      }
    },
  });
  const sync = createDocumentSync(
    initial.text,
    {
      read: () => invoke<string>("read_doc", { path: host.path() }),
      write: async (text) => {
        // The same synchronous step as `serialize` (document-sync.ts): the root and the sidecar
        // are read from the state `text` was serialised from, before the first `await`.
        const at = host.path();
        const { root, sidecar } = host.store().getState().document;
        await invoke("write_doc", { path: at, contents: text });
        // From here the Markdown is on disk, so a failure is the sidecar's alone and is reported
        // apart from it (`MarkdownWritten`; backlog `[review-2-r2, sidecar failure after a
        // Markdown write]`).
        try {
          const sidecarPath = sidecarPathFor(at);
          // Re-read before writing: `watch.rs` reports `.md` paths only, so a sidecar-only change
          // by another writer is never seen except here (DECISIONS #review-2-r0 U5).
          const diskRaw = await invoke<string | null>("read_sidecar", { path: sidecarPath });
          const choice = baseline.choose(diskRaw, root, sidecar);
          if (choice.action === "skip") {
            throw new Error(`${sidecarPath} was not saved: ${describe(choice.error)}`);
          }
          const raw = `${JSON.stringify(choice.sidecar, null, 2)}\n`;
          await invoke("write_sidecar", { path: sidecarPath, contents: raw });
          baseline.wrote(raw, choice);
        } catch (error) {
          throw new MarkdownWritten(error);
        }
      },
    },
    {
      serialize: () => format(host.store().getState().document.root),
      reloaded: (text) => {
        host.replaced(storeFor(text, host.store().getState().document.sidecar));
        host.banner(false);
      },
      conflicted: () => host.banner(true),
      knownChanged: (text) => host.knownChanged(text),
      failed: (error) => host.error(describe(error)),
      settle: () => host.store().getState().settle(),
    },
    {
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
  );
  return {
    sync,
    storeChanged(state, previous) {
      if (state.document !== previous.document && !adopting) sync.edited();
    },
    flush: () => {
      // A source burst still inside its window is an edit the save must carry (task 3.19).
      host.store().getState().settle();
      return sync.flush();
    },
    rename: (newPath, move) => {
      host.store().getState().settle();
      const oldStem = stemOf(host.path());
      const newStem = stemOf(newPath);
      return sync.renamed(
        (text) => rewriteAssetUrls(text, oldStem, newStem),
        async () => {
          await move();
          host.moved(newPath);
        },
      );
    },
  };
}

/**
 * The open document (task 2.5): the rendered editor over a document store, autosaved through
 * `document-sync.ts`, reloaded on `fs:changed` for its own path, with the 'Changed on disk' banner
 * (Reload / Keep mine) when the file changes under an edit and §6.1's non-canonical banner on
 * open.
 *
 * **Two surfaces over one store** (PRD §146, task 3.19; the toggle of `/dev/editor`, task 1.7).
 * `surface` is `rendered` (ProseMirror) or `source` (CodeMirror over `format(root)`), beside and
 * independent of the app's `mode`: Cmd/Ctrl+/ swaps the one mounted view and works in every §6.3
 * mode, forcing none. The toggle is not an edit — `toggleMode` only closes the coalescing group —
 * and the caret is carried in canonical (line, ch) coordinates, as on the dev route. The mode panels
 * keep reading `store.cursor`, which only the rendered view drives: in the source view a Rewrite or
 * Reorder action acts on the last rendered-view caret (a recorded cut, DECISIONS #054; backlog
 * `[3.19, source caret does not drive the mode panels]`).
 *
 * **Readers of the store.** The source view commits at the end of a burst, so a reader that is not
 * an editing surface settles the pending burst first: the handle's `flush` and `rename` call the
 * store's `settle()`, as do the watcher's check and Keep mine (through the sync's `settle`,
 * {@link createPaneSync}) and the test hook's readers, and the store's own `dispatch`/`undo`/`redo`
 * settle before they move (DECISIONS #054's one seam). The autosave's `serialize` does not: it runs
 * inside the sync's own chain, and a burst it misses is committed by the source view's timer within
 * a window, which marks the document edited and schedules the save that carries it.
 *
 * **A reload is a new store**, not a commit onto the old one: the external text is not an edit
 * the user made, so it is not an undo step, and an Undo that took it back would autosave the old
 * text over the file that was just changed on disk.
 *
 * `current-content` (hidden) holds the text the pane believes is on disk — what it last read or
 * wrote — so the shell e2e can compare it with the file byte for byte (DECISIONS #022).
 */
export default function DocumentPane({
  root,
  path,
  initial,
  onUndoOpen,
  onError,
  onStore,
  mode,
  typewriterScroll,
  onJumpToOutline,
  ref,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [store, setStore] = useState(() => storeFor(initial.text, initial.sidecar));
  // What the sync's I/O reads at call time: a rename moves `path` without a remount, and a reload
  // replaces `store`.
  const pathRef = useRef(path);
  const errorRef = useRef(onError);
  const storeRef = useRef(store);
  // Read by the question-hints plugin and the typewriter-scroll wrapper below, which both live
  // inside an effect scoped to `[store, root]` and must not rebuild the whole `EditorView` on
  // every mode switch or settings change.
  const modeRef = useRef(mode);
  const typewriterScrollRef = useRef(typewriterScroll);
  const onJumpToOutlineRef = useRef(onJumpToOutline);
  const viewRef = useRef<EditorView | null>(null);
  // The source surface (task 3.19): which view is mounted, the mounted source view and its binding,
  // and the caret the outgoing view handed the incoming one — kept with the store it belongs to, so
  // a reload (a new store) never places a caret read from the old document. Nothing clears it:
  // re-applying it is idempotent, and clearing it would lose it to StrictMode's second mount.
  const [surface, setSurface] = useState<EditorMode>("rendered");
  const surfaceRef = useRef<EditorMode>("rendered");
  const sourceHost = useRef<HTMLDivElement>(null);
  const sourceViewRef = useRef<SourceEditorView | null>(null);
  const sourceBindingRef = useRef<SourceBinding | null>(null);
  const carried = useRef<{ store: DocumentStore; at: SourcePosition } | null>(null);
  // On a change only: `rename` moves `pathRef` before the parent re-renders with the new `path`.
  useLayoutEffect(() => {
    pathRef.current = path;
  }, [path]);
  useLayoutEffect(() => {
    errorRef.current = onError;
    storeRef.current = store;
    modeRef.current = mode;
    typewriterScrollRef.current = typewriterScroll;
    onJumpToOutlineRef.current = onJumpToOutline;
  });
  const [known, setKnown] = useState(initial.text);
  const [conflict, setConflict] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [nonCanonical, setNonCanonical] = useState(() => format(parse(initial.text)) !== initial.text);
  const paneSyncRef = useRef<PaneSync | null>(null);

  useEffect(() => {
    const paneSync = createPaneSync(initial, {
      store: () => storeRef.current,
      path: () => pathRef.current,
      moved: (next) => {
        pathRef.current = next;
      },
      replaced: (next) => {
        setStore(next);
        setReloads((n) => n + 1);
      },
      banner: setConflict,
      knownChanged: (text) => {
        setKnown(text);
        // Written in canonical form: the §6.1 banner has said what it had to say.
        if (format(parse(text)) === text) setNonCanonical(false);
      },
      error: (message) => errorRef.current(message),
    });
    const { sync } = paneSync;
    paneSyncRef.current = paneSync;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen<{ path: string }>("fs:changed", (event) => {
      if (event.payload.path === pathRef.current) sync.changed();
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
      sync.dispose();
      paneSyncRef.current = null;
    };
  }, [initial]);

  // A snapshot change only: the store also notifies when the caret moves (`cursor`), which is not
  // an edit and must not schedule a save.
  useEffect(() => store.subscribe((state, previous) => paneSyncRef.current?.storeChanged(state, previous)), [store]);

  // The Outline's views live outside the pane (task 3.2) and edit this store too.
  const storeListener = useRef(onStore);
  useLayoutEffect(() => {
    storeListener.current = onStore;
  });
  useEffect(() => {
    storeListener.current?.(store);
    return () => storeListener.current?.(null);
  }, [store]);

  // The shell e2e's handle on this pane's store (task 3.1; ./test-hook.ts).
  useEffect(() => installTestHook(window as TestHookHost, store), [store]);

  // A rename re-reads the document at the new path inside the sync's chain, so the next save does
  // not find the disk changed (DECISIONS #review-2-r0 U20), and its image-URL rewrite is written
  // there too, never read before the move and written after it (DECISIONS #review-2-r3, task 3.11).
  useImperativeHandle(
    ref,
    () => ({
      flush: async () => (await paneSyncRef.current?.flush()) ?? "clean",
      rename: async (newPath, move) =>
        (await paneSyncRef.current?.rename(newPath, move)) ?? { moved: false, result: "failed" },
    }),
    [],
  );

  // Cmd/Ctrl+/ from either view (PRD §146): the same steps as `/dev/editor`'s toggle. The pending
  // source burst is committed first, so the incoming view is built from a store that holds it and
  // the toggle itself pushes nothing; then the outgoing view's caret is put into canonical
  // coordinates — the rendered caret through the cursor map, told the stored marks a typed
  // character would take (task 1.52), the source caret through `canonicalCursor`, because the
  // buffer holds the user's own bytes — and the coalescing group is closed.
  const toggle = useCallback(() => {
    const current = storeRef.current;
    sourceBindingRef.current?.flush();
    const rendered = viewRef.current;
    const source = sourceViewRef.current;
    if (surfaceRef.current === "rendered" && rendered !== null) {
      const at = cursorMap(current.getState().document.root, rendered.state.doc).toSource(
        rendered.state.selection.head,
        rendered.state.storedMarks,
      );
      carried.current = { store: current, at };
    } else if (surfaceRef.current === "source" && source !== null) {
      carried.current = { store: current, at: canonicalCursor(source.state.doc.toString(), sourceCursor(source.state)) };
    }
    const next = toggleMode(current, surfaceRef.current);
    surfaceRef.current = next;
    setSurface(next);
  }, []);

  useEffect(() => {
    if (surface !== "source") return;
    const element = sourceHost.current;
    if (element === null) return;
    // `binding` is built from the view, which the update listener needs, so the listener and the
    // undo hook read it at call time (the same shape as /dev/editor).
    let binding: SourceBinding | null = null;
    const view = new SourceEditorView({
      state: SourceEditorState.create({
        doc: format(store.getState().document.root),
        extensions: [
          ...sourceExtensions(),
          sourceToggleKeymap(toggle),
          sourceUndoKeymap(store, () => binding?.flush()),
          SourceEditorView.updateListener.of((update) => {
            if (update.docChanged) binding?.change(update.state.doc.toString());
          }),
        ],
      }),
      parent: element,
    });
    binding = bindCodeMirror(store, {
      get state() {
        return view.state;
      },
      dispatch: (spec) => {
        view.dispatch(spec);
      },
    });
    sourceViewRef.current = view;
    sourceBindingRef.current = binding;
    const at = carried.current;
    if (at !== null && at.store === store) {
      view.dispatch({ selection: { anchor: sourceOffset(view.state, at.at) }, scrollIntoView: true });
      view.focus();
    }
    return () => {
      sourceViewRef.current = null;
      sourceBindingRef.current = null;
      // `destroy` flushes, then unregisters the store's settle seam.
      binding?.destroy();
      view.destroy();
    };
  }, [store, surface, toggle]);

  useEffect(() => {
    if (surface !== "rendered") return;
    const element = host.current;
    if (element === null) return;
    const saveImage = async (bytes: Uint8Array, extension: string): Promise<string> =>
      invoke<string>("save_image", { docPath: pathRef.current, bytes: Array.from(bytes), extension });
    // Produce mode's question hints (PRD §6.3, task 3.3): `modeRef`/`onJumpToOutlineRef` are read
    // fresh on every draw, so this plugin needs no rebuild when the mode or the sidecar changes —
    // only a redraw, which the two effects below force.
    const questionHints = questionHintsPlugin(
      () => modeRef.current === "produce",
      () => outlineOf(storeRef.current.getState().document).map((section) => section.question),
      () => onJumpToOutlineRef.current(),
    );
    const view = new EditorView(element, {
      state: EditorState.create({
        schema,
        plugins: [
          ...storePlugins(store),
          ...togglePlugins(toggle),
          ...editorPlugins(),
          imagePastePlugin(saveImage),
          questionHints,
        ],
      }),
      nodeViews: { image: createImageNodeView(root, () => pathRef.current) },
    });
    viewRef.current = view;
    // The same two-line wiring as /dev/editor: the binding needs the view, and the view's
    // `dispatchTransaction` needs the binding.
    const binding = bindProseMirror(store, view);
    view.setProps({
      dispatchTransaction: (transaction) => {
        binding.dispatch(transaction);
        // Produce mode's optional typewriter scrolling (§6.3): after every transaction — a
        // keystroke, an arrow key, a mode-forced redraw — keep the caret at the scroll
        // container's vertical centre, only while Produce and the setting are both on.
        if (modeRef.current !== "produce" || !typewriterScrollRef.current) return;
        const container = element.closest<HTMLElement>('[data-testid="main"]');
        if (container === null) return;
        const coords = view.coordsAtPos(view.state.selection.head);
        const rect = container.getBoundingClientRect();
        container.scrollTop += coords.top - (rect.top + rect.height / 2);
      },
    });
    const at = carried.current;
    if (at !== null && at.store === store) {
      const pos = cursorMap(store.getState().document.root, view.state.doc).toRendered(at.at);
      view.dispatch(view.state.tr.setSelection(renderedSelection(view.state.doc, pos)));
      view.focus();
    }
    return () => {
      viewRef.current = null;
      binding.destroy();
      view.destroy();
    };
  }, [store, root, surface, toggle]);

  // A mode switch draws or clears the question hints: they read `modeRef` fresh, but only a new
  // state update makes the view redraw its decorations, so an empty transaction forces one.
  useEffect(() => {
    const view = viewRef.current;
    if (view !== null) view.dispatch(view.state.tr);
  }, [mode]);

  // A question set or cleared through the Outline (task 3.2) changes the sidecar alone, which
  // commits no ProseMirror transaction — so this store subscription is the question hints' own
  // path to a redraw while Produce is showing them.
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.document === previous.document || modeRef.current !== "produce") return;
        const view = viewRef.current;
        if (view !== null) view.dispatch(view.state.tr);
      }),
    [store],
  );

  return (
    <div className="document-pane" data-testid="document" data-reloads={reloads} data-surface={surface}>
      <div className="workspace-current-file" data-testid="current-file">
        {path}
      </div>
      {nonCanonical && (
        <div className="banner" role="status" data-testid="non-canonical-banner">
          <span>{NON_CANONICAL_MESSAGE}</span>
          <button type="button" data-testid="undo-open" onClick={onUndoOpen}>
            Undo open
          </button>
          <button type="button" data-testid="dismiss-non-canonical" onClick={() => setNonCanonical(false)}>
            OK
          </button>
        </div>
      )}
      {conflict && (
        <div className="banner banner-conflict" role="alert" data-testid="conflict-banner">
          <span>Changed on disk</span>
          <button
            type="button"
            data-testid="conflict-reload"
            onClick={() => {
              void paneSyncRef.current?.sync.reload();
            }}
          >
            Reload
          </button>
          <button
            type="button"
            data-testid="conflict-keep-mine"
            onClick={() => {
              void paneSyncRef.current?.sync.keepMine().then(() => {
                if (paneSyncRef.current?.sync.conflict === false) setConflict(false);
              });
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      {surface === "rendered" ? (
        <div key="editor" className="document-editor" data-testid="editor" ref={host} />
      ) : (
        <div key="source" className="document-editor document-source" data-testid="source" ref={sourceHost} />
      )}
      <pre className="workspace-content" data-testid="current-content" hidden>
        {known}
      </pre>
    </div>
  );
}
