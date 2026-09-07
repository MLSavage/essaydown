import { Plugin, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/** Task 1.8's acceptance selector: one per heading `/dev/outline` produced. */
export const QUESTION_HINT_CLASS = "question-hint";

/** The DOM for one hint line, built fresh per widget the way `reveal.ts`'s delimiters are. */
function hintDOM(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = QUESTION_HINT_CLASS;
  el.textContent = text;
  return el;
}

/**
 * `hints[i]` is heading `i`'s own question text, in document order (`/dev/outline` builds both
 * the headings and this array from the same ordered list, so they line up by construction). A
 * widget at a heading's own position — the boundary between the previous sibling and the heading,
 * since headings are always block children of the root — renders as a sibling *before* the
 * heading's block element, which is the "muted line above the heading" the task text asks for; a
 * negative `side` keeps it there if a cursor ever lands on that exact boundary. `marks: []` stops
 * it inheriting a mark from a neighbour, the same reason `reveal.ts`'s delimiters set it.
 */
function hintDecorations(state: EditorState, hints: readonly string[]): DecorationSet {
  if (hints.length === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  let index = 0;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    const text = hints[index];
    index += 1;
    if (text !== undefined) {
      decorations.push(Decoration.widget(pos, () => hintDOM(text), { side: -1, marks: [] }));
    }
    return false;
  });
  return DecorationSet.create(state.doc, decorations);
}

/** Installed only when `/dev/editor` was reached via "Produce"; `hints` is fixed for the plugin's life. */
export function questionHintPlugin(hints: readonly string[]): Plugin {
  return new Plugin({
    props: {
      decorations: (state) => hintDecorations(state, hints),
    },
  });
}
