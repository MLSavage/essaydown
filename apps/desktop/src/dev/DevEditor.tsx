import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { emptySidecar, format, parse } from "@essaydown/core";
import {
  bindCodeMirror,
  bindProseMirror,
  canonicalCursor,
  createDocumentStore,
  createFormatCache,
  cursorMap,
  editorPlugins,
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
  type EditorMode,
  type SourceBinding,
  type SourcePosition,
} from "@essaydown/editor";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { EditorState as SourceEditorState } from "@codemirror/state";
import { EditorView as SourceEditorView } from "@codemirror/view";
import "prosemirror-view/style/prosemirror.css";
import "@essaydown/editor/src/source.css";
import "./dev-editor.css";
import { clearOutlineHandoff, readOutlineHandoff } from "./outline-handoff.js";
import { questionHintPlugin } from "./outline-hints.js";

/**
 * The `/dev/editor` route of PRD §8 (Phases 0–1): one document store, and beside it the canonical
 * Markdown that store currently serialises to.
 *
 * Since task 1.7 the route shows *one of two* views over that store — the ProseMirror editor of
 * tasks 1.1/1.3/1.4, or the CodeMirror source view of task 1.5 — and Cmd/Ctrl+/ swaps them. The
 * swap is not an edit: `toggleMode` only closes the open coalescing group, so the first Undo after
 * a toggle takes back the last real edit rather than the toggle. The cursor is carried across in
 * the canonical string's own coordinates (1-based line, 0-based `ch`): the outgoing view converts
 * its cursor to a {@link SourcePosition}, `carried` holds it, and the incoming view converts it
 * back. Coming out of the source view that conversion is `canonicalCursor`, because the bytes in
 * that view are the user's and a (line, ch) of theirs is not a (line, ch) of `format(root)`.
 * Nothing clears `carried` — re-applying the same position is idempotent, and clearing it would
 * lose the cursor to React StrictMode's second mount.
 *
 * The dev-only top bar is the Phase 1 human gate's handle on the route: "Load fixture…" opens a
 * file chooser and commits whatever Markdown it is given, and "Copy Markdown" puts the store's
 * canonical serialisation on the clipboard.
 *
 * Since task 1.8, the route also opens with `/dev/outline`'s produced document when it was
 * reached via that route's "Produce" button: {@link readOutlineHandoff} is read once, before the
 * store is created, and its `hints` (one per heading, in document order) are drawn as muted
 * `.question-hint` lines by {@link questionHintPlugin}. The handoff is otherwise absent (a direct
 * visit, or "Load fixture…"), which is the `hints.length === 0` case the plugin already treats as
 * "draw nothing".
 *
 * Dev-only, and pure web: nothing here calls Tauri, so Playwright can drive it (PRD §4).
 */
export default function DevEditor() {
  const host = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // Read once, purely (see outline-handoff.ts): a StrictMode double-render must not lose it.
  const handoff = useMemo(() => readOutlineHandoff(), []);
  const hints = useRef<readonly string[]>(handoff?.hints ?? []);
  const store = useMemo(
    () => createDocumentStore(parse(handoff?.markdown ?? ""), emptySidecar()),
    [handoff],
  );
  useEffect(() => {
    clearOutlineHandoff();
  }, []);
  // `useSyncExternalStore` calls its getter on every render and every notification, so the
  // serialisation is memoised on the root's identity (task 1.17) rather than run per call. One
  // cache for the life of the route, not one per store: the key is the root object, and a new
  // store is built from a fresh `parse`, so no two stores can present the same root here.
  const formatted = useMemo(() => createFormatCache(), []);
  const markdown = useSyncExternalStore(store.subscribe, () =>
    formatted(store.getState().document.root),
  );
  const [mode, setMode] = useState<EditorMode>("rendered");
  const [status, setStatus] = useState("");

  // The mode the toggle reads, so that closing the coalescing group stays out of a React state
  // updater (which StrictMode may call twice).
  const modeRef = useRef<EditorMode>("rendered");
  const rendered = useRef<EditorView | null>(null);
  const source = useRef<SourceEditorView | null>(null);
  const sourceBinding = useRef<SourceBinding | null>(null);
  const carried = useRef<SourcePosition | null>(null);

  const toggle = useCallback(() => {
    const pm = rendered.current;
    const cm = source.current;
    // The source view commits on the burst boundary (task 1.17), so what is typed in the last
    // window before a toggle is still only in the CodeMirror buffer; the rendered view is built
    // from the store, so the pending commit is made *before* the group is closed — which is the
    // order the per-keystroke commit produced, and leaves the toggle itself pushing nothing.
    sourceBinding.current?.flush();
    const root = store.getState().document.root;
    if (pm !== null) {
      carried.current = cursorMap(root, pm.state.doc).toSource(pm.state.selection.head);
    } else if (cm !== null) {
      // The source view holds the user's own bytes, which need not be canonical, and the cursor
      // map speaks canonical coordinates; `canonicalCursor` translates through the parsed node.
      carried.current = canonicalCursor(cm.state.doc.toString(), sourceCursor(cm.state));
    }
    const next = toggleMode(store, modeRef.current);
    modeRef.current = next;
    setMode(next);
  }, [store]);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;

    if (mode === "rendered") {
      const view = new EditorView(element, {
        state: EditorState.create({
          schema,
          plugins: [
            ...storePlugins(store),
            ...togglePlugins(toggle),
            ...editorPlugins(),
            ...(hints.current.length > 0 ? [questionHintPlugin(hints.current)] : []),
          ],
        }),
      });
      // The binding needs the view, and the view's `dispatchTransaction` needs the binding, so the
      // prop is installed on the second line rather than passed to the constructor. Nothing
      // dispatches in between: `bindProseMirror`'s initial pull goes through `updateState`.
      const binding = bindProseMirror(store, view);
      view.setProps({ dispatchTransaction: (transaction) => binding.dispatch(transaction) });
      rendered.current = view;
      const at = carried.current;
      if (at !== null) {
        const pos = cursorMap(store.getState().document.root, view.state.doc).toRendered(at);
        view.dispatch(view.state.tr.setSelection(renderedSelection(view.state.doc, pos)));
      }
      view.focus();
      return () => {
        rendered.current = null;
        binding.destroy();
        view.destroy();
      };
    }

    // `binding` is read by the update listener the view is built with, and built from the view, so
    // it starts null; the only update that can arrive in between is the state's own creation,
    // which changes nothing the store has not already got.
    let binding: SourceBinding | null = null;
    const view = new SourceEditorView({
      state: SourceEditorState.create({
        doc: format(store.getState().document.root),
        extensions: [
          ...sourceExtensions(),
          sourceToggleKeymap(toggle),
          sourceUndoKeymap(store),
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
    source.current = view;
    sourceBinding.current = binding;
    const at = carried.current;
    if (at !== null) {
      view.dispatch({ selection: { anchor: sourceOffset(view.state, at) }, scrollIntoView: true });
    }
    view.focus();
    return () => {
      source.current = null;
      sourceBinding.current = null;
      // `destroy` flushes: an unmount (a toggle, a StrictMode remount, leaving the route) must not
      // drop the text typed inside the last burst window.
      binding?.destroy();
      view.destroy();
    };
  }, [mode, store, toggle]);

  const loadFixture = useCallback(
    async (files: FileList | null): Promise<void> => {
      const file = files?.[0];
      if (file === undefined) return;
      const text = await file.text();
      const { document, commit } = store.getState();
      commit(parse(text), document.sidecar);
      setStatus(`Loaded ${file.name}`);
    },
    [store],
  );

  const copyMarkdown = useCallback(async (): Promise<void> => {
    const text = format(store.getState().document.root);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied Markdown");
    } catch {
      setStatus("Copy failed: the browser refused clipboard access");
    }
  }, [store]);

  return (
    <main className="dev-editor">
      <h1 className="dev-editor-title">/dev/editor</h1>
      <div className="dev-editor-bar">
        <button type="button" data-testid="load-fixture" onClick={() => fileInput.current?.click()}>
          Load fixture…
        </button>
        <input
          className="dev-editor-file"
          data-testid="fixture-file"
          type="file"
          accept=".md,.markdown,text/markdown"
          ref={fileInput}
          onChange={(event) => {
            void loadFixture(event.currentTarget.files);
          }}
        />
        <button
          type="button"
          data-testid="copy-markdown"
          onClick={() => {
            void copyMarkdown();
          }}
        >
          Copy Markdown
        </button>
        <span className="dev-editor-mode" data-testid="mode">
          {mode}
        </span>
        <span className="dev-editor-status" data-testid="status">
          {status}
        </span>
      </div>
      <div className="dev-editor-host" data-testid="editor" ref={host} />
      <pre className="dev-editor-markdown" data-testid="markdown">
        {markdown}
      </pre>
    </main>
  );
}
