import { useEffect, useRef, useState } from "react";
import { format } from "@essaydown/core";
import { editorPlugins, pmToMdast, schema } from "@essaydown/editor";
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
 * Dev-only, and pure web: nothing here calls Tauri, so Playwright can drive it (PRD §4).
 */
export default function DevEditor() {
  const host = useRef<HTMLDivElement>(null);
  const [markdown, setMarkdown] = useState("");

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const view: EditorView = new EditorView(element, {
      state: EditorState.create({ schema, plugins: editorPlugins() }),
      dispatchTransaction(transaction) {
        view.updateState(view.state.apply(transaction));
        setMarkdown(format(pmToMdast({ doc: view.state.doc, frontMatter: null })));
      },
    });
    setMarkdown(format(pmToMdast({ doc: view.state.doc, frontMatter: null })));
    view.focus();
    return () => {
      view.destroy();
    };
  }, []);

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
