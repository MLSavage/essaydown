import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { emptySidecar, format, parse } from "@essaydown/core";
import {
  bindCodeMirror,
  bindProseMirror,
  createDocumentStore,
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
 * back. Nothing clears `carried` — re-applying the same position is idempotent, and clearing it
 * would lose the cursor to React StrictMode's second mount.
 *
 * The dev-only top bar is the Phase 1 human gate's handle on the route: "Load fixture…" opens a
 * file chooser and commits whatever Markdown it is given, and "Copy Markdown" puts the store's
 * canonical serialisation on the clipboard.
 *
 * Dev-only, and pure web: nothing here calls Tauri, so Playwright can drive it (PRD §4).
 */
export default function DevEditor() {
  const host = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const store = useMemo(() => createDocumentStore(parse(""), emptySidecar()), []);
  const markdown = useSyncExternalStore(store.subscribe, () =>
    format(store.getState().document.root),
  );
  const [mode, setMode] = useState<EditorMode>("rendered");
  const [status, setStatus] = useState("");

  // The mode the toggle reads, so that closing the coalescing group stays out of a React state
  // updater (which StrictMode may call twice).
  const modeRef = useRef<EditorMode>("rendered");
  const rendered = useRef<EditorView | null>(null);
  const source = useRef<SourceEditorView | null>(null);
  const carried = useRef<SourcePosition | null>(null);

  const toggle = useCallback(() => {
    const pm = rendered.current;
    const cm = source.current;
    const root = store.getState().document.root;
    if (pm !== null) {
      carried.current = cursorMap(root, pm.state.doc).toSource(pm.state.selection.head);
    } else if (cm !== null) {
      carried.current = sourceCursor(cm.state);
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
          plugins: [...storePlugins(store), ...togglePlugins(toggle), ...editorPlugins()],
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
    const at = carried.current;
    if (at !== null) {
      view.dispatch({ selection: { anchor: sourceOffset(view.state, at) }, scrollIntoView: true });
    }
    view.focus();
    return () => {
      source.current = null;
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
        <button
          type="button"
          data-testid="load-fixture"
          onClick={() => fileInput.current?.click()}
        >
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
