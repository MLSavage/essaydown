import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { emptySidecar, format, parse } from "@essaydown/core";
import {
  bindProseMirror,
  createDocumentStore,
  editorPlugins,
  schema,
  storePlugins,
} from "@essaydown/editor";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import "prosemirror-view/style/prosemirror.css";
import "./dev-editor.css";

/**
 * The `/dev/editor` route of PRD §8 (Phases 0–1): the ProseMirror editor of task 1.1 with the
 * input rules and keymap of task 1.3, and, beside it, the canonical Markdown the document
 * currently serialises to. The Markdown pane is what makes the route testable — the acceptance
 * types keystrokes and reads the Markdown back — and it is the same string task 1.7's dev-only
 * "Copy Markdown" button will copy.
 *
 * Since task 1.6 the document is the store's, not the view's: the pane serialises the store's
 * current snapshot, so it shows what an undo left behind and not merely what was typed, and the
 * view is bound to the store in both directions by `bindProseMirror`.
 *
 * Dev-only, and pure web: nothing here calls Tauri, so Playwright can drive it (PRD §4).
 */
export default function DevEditor() {
  const host = useRef<HTMLDivElement>(null);
  const store = useMemo(() => createDocumentStore(parse(""), emptySidecar()), []);
  const markdown = useSyncExternalStore(store.subscribe, () =>
    format(store.getState().document.root),
  );

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const view = new EditorView(element, {
      state: EditorState.create({ schema, plugins: [...storePlugins(store), ...editorPlugins()] }),
    });
    // The binding needs the view, and the view's `dispatchTransaction` needs the binding, so the
    // prop is installed on the second line rather than passed to the constructor. Nothing
    // dispatches in between: `bindProseMirror`'s initial pull goes through `updateState`.
    const binding = bindProseMirror(store, view);
    view.setProps({ dispatchTransaction: (transaction) => binding.dispatch(transaction) });
    view.focus();
    return () => {
      binding.destroy();
      view.destroy();
    };
  }, [store]);

  return (
    <main className="dev-editor">
      <h1 className="dev-editor-title">/dev/editor</h1>
      <div className="dev-editor-host" data-testid="editor" ref={host} />
      <pre className="dev-editor-markdown" data-testid="markdown">
        {markdown}
      </pre>
    </main>
  );
}
