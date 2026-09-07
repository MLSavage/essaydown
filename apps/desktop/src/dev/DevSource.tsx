import { useEffect, useRef } from "react";
import { sourceExtensions } from "@essaydown/editor";
import "@essaydown/editor/src/source.css";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import essayFixture from "../../../../fixtures/markdown/essay-fixture.md?raw";
import "./dev-source.css";

/**
 * The `/dev/source` route of PRD §8 (Phase 1): task 1.5's CodeMirror 6 source view, showing
 * `fixtures/markdown/essay-fixture.md` verbatim with its 7-token-class highlight theme. Dev-only
 * and pure web, like `/dev/editor` (no Tauri call, so Playwright can drive it).
 */
export default function DevSource() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const view = new EditorView({
      state: EditorState.create({ doc: essayFixture, extensions: sourceExtensions() }),
      parent: element,
    });
    return () => {
      view.destroy();
    };
  }, []);

  return (
    <main className="dev-source">
      <h1 className="dev-source-title">/dev/source</h1>
      <div className="dev-source-host" data-testid="source" ref={host} />
    </main>
  );
}
