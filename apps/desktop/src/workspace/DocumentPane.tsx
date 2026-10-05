import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { attach, emptySidecar, format, parse, parseSidecar, rewriteAssetUrls, type Sidecar } from "@essaydown/core";
import {
  bindProseMirror,
  createDocumentStore,
  editorPlugins,
  schema,
  storePlugins,
  type DocumentStore,
} from "@essaydown/editor";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import "prosemirror-view/style/prosemirror.css";
import { createDocumentSync, type DocumentSync, type FlushResult, type RenameOutcome } from "./document-sync";
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

function storeFor(text: string, sidecar: Sidecar): DocumentStore {
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
  readonly ref?: Ref<DocumentPaneHandle>;
}

function describe(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The open document (task 2.5): the rendered editor over a document store, autosaved through
 * `document-sync.ts`, reloaded on `fs:changed` for its own path, with the 'Changed on disk' banner
 * (Reload / Keep mine) when the file changes under an edit and §6.1's non-canonical banner on
 * open.
 *
 * **Readers of the store.** The save's `serialize` is the one reader here that is not an editing
 * surface. The pane mounts the rendered view only, which commits every transaction as it is
 * dispatched (`bindProseMirror`), so there is no pending source burst to settle before it reads
 * (CLAUDE.md's rule binds a reader beside the source view, which this page does not mount).
 *
 * **A reload is a new store**, not a commit onto the old one: the external text is not an edit
 * the user made, so it is not an undo step, and an Undo that took it back would autosave the old
 * text over the file that was just changed on disk.
 *
 * `current-content` (hidden) holds the text the pane believes is on disk — what it last read or
 * wrote — so the shell e2e can compare it with the file byte for byte (DECISIONS #022).
 */
export default function DocumentPane({ root, path, initial, onUndoOpen, onError, ref }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [store, setStore] = useState(() => storeFor(initial.text, initial.sidecar));
  // What the sync's I/O reads at call time: a rename moves `path` without a remount, and a reload
  // replaces `store`.
  const pathRef = useRef(path);
  const errorRef = useRef(onError);
  const storeRef = useRef(store);
  // On a change only: `rename` moves `pathRef` before the parent re-renders with the new `path`.
  useLayoutEffect(() => {
    pathRef.current = path;
  }, [path]);
  useLayoutEffect(() => {
    errorRef.current = onError;
    storeRef.current = store;
  });
  const [known, setKnown] = useState(initial.text);
  const [conflict, setConflict] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [nonCanonical, setNonCanonical] = useState(() => format(parse(initial.text)) !== initial.text);
  const syncRef = useRef<DocumentSync | null>(null);

  useEffect(() => {
    // The sidecar's raw JSON text and the sidecar it stands for, as this pane last read or wrote
    // them (tasks 2.19, 2.23); reset on every reload of this document (a new `initial`), and moved
    // forward together by every write below. The store's `document.sidecar` is never the next
    // write's source: this build has no in-app sidecar edit (docs/V1.1-BACKLOG.md
    // `[review-2-r1, sidecar baseline vs store]`).
    const baseline = createSidecarBaseline(initial.sidecarRaw, initial.sidecar);
    const sync = createDocumentSync(
      initial.text,
      {
        read: () => invoke<string>("read_doc", { path: pathRef.current }),
        write: async (text) => {
          // The same synchronous step as `serialize` (document-sync.ts): the root is read from
          // the state `text` was serialised from, before the first `await`.
          const at = pathRef.current;
          const { root } = storeRef.current.getState().document;
          await invoke("write_doc", { path: at, contents: text });
          const sidecarPath = sidecarPathFor(at);
          // Re-read before writing: `watch.rs` reports `.md` paths only, so a sidecar-only change
          // by another writer is never seen except here (DECISIONS #review-2-r0 U5).
          const diskRaw = await invoke<string | null>("read_sidecar", { path: sidecarPath });
          const choice = baseline.choose(diskRaw, root);
          if (choice.action === "skip") {
            errorRef.current(describe(choice.error));
            return;
          }
          const raw = `${JSON.stringify(choice.sidecar, null, 2)}\n`;
          await invoke("write_sidecar", { path: sidecarPath, contents: raw });
          baseline.wrote(raw, choice.sidecar);
        },
      },
      {
        serialize: () => format(storeRef.current.getState().document.root),
        reloaded: (text) => {
          setStore(storeFor(text, baseline.current()));
          setConflict(false);
          setReloads((n) => n + 1);
        },
        conflicted: () => setConflict(true),
        knownChanged: (text) => {
          setKnown(text);
          // Written in canonical form: the §6.1 banner has said what it had to say.
          if (format(parse(text)) === text) setNonCanonical(false);
        },
        failed: (error) => errorRef.current(describe(error)),
      },
      {
        setTimeout: (callback, ms) => window.setTimeout(callback, ms),
        clearTimeout: (handle) => window.clearTimeout(handle as number),
        now: () => Date.now(),
      },
    );
    syncRef.current = sync;
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
      syncRef.current = null;
    };
  }, [initial]);

  // A snapshot change only: the store also notifies when the caret moves (`cursor`), which is not
  // an edit and must not schedule a save.
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (state.document !== previous.document) syncRef.current?.edited();
      }),
    [store],
  );

  // The shell e2e's handle on this pane's store (task 3.1; ./test-hook.ts).
  useEffect(() => installTestHook(window as TestHookHost, store), [store]);

  // A rename re-reads the document at the new path inside the sync's chain, so the next save does
  // not find the disk changed (DECISIONS #review-2-r0 U20), and its image-URL rewrite is written
  // there too, never read before the move and written after it (DECISIONS #review-2-r3, task 3.11).
  useImperativeHandle(
    ref,
    () => ({
      flush: async () => (await syncRef.current?.flush()) ?? "clean",
      rename: async (newPath, move) => {
        const sync = syncRef.current;
        if (sync === null) return { moved: false, result: "failed" };
        const oldStem = stemOf(pathRef.current);
        const newStem = stemOf(newPath);
        return sync.renamed(
          (text) => rewriteAssetUrls(text, oldStem, newStem),
          async () => {
            await move();
            pathRef.current = newPath;
          },
        );
      },
    }),
    [],
  );

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const saveImage = async (bytes: Uint8Array, extension: string): Promise<string> =>
      invoke<string>("save_image", { docPath: pathRef.current, bytes: Array.from(bytes), extension });
    const view = new EditorView(element, {
      state: EditorState.create({
        schema,
        plugins: [...storePlugins(store), ...editorPlugins(), imagePastePlugin(saveImage)],
      }),
      nodeViews: { image: createImageNodeView(root, () => pathRef.current) },
    });
    // The same two-line wiring as /dev/editor: the binding needs the view, and the view's
    // `dispatchTransaction` needs the binding.
    const binding = bindProseMirror(store, view);
    view.setProps({ dispatchTransaction: (transaction) => binding.dispatch(transaction) });
    return () => {
      binding.destroy();
      view.destroy();
    };
  }, [store, root]);

  return (
    <div className="document-pane" data-testid="document" data-reloads={reloads}>
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
              void syncRef.current?.reload();
            }}
          >
            Reload
          </button>
          <button
            type="button"
            data-testid="conflict-keep-mine"
            onClick={() => {
              void syncRef.current?.keepMine().then(() => {
                if (syncRef.current?.conflict === false) setConflict(false);
              });
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      <div className="document-editor" data-testid="editor" ref={host} />
      <pre className="workspace-content" data-testid="current-content" hidden>
        {known}
      </pre>
    </div>
  );
}
