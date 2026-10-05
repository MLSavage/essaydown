import type { Node as PMNode } from "prosemirror-model";
import { Plugin, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { schema } from "./schema.js";

/**
 * Produce mode's muted question line above each heading (PRD §6.3, task 3.3): one widget
 * decoration per top-level heading, in document order, drawn and never written into the document
 * — the same shape as {@link revealDecorations} (./reveal.ts), a pure function of the state
 * installed as the plugin's `decorations` prop, which the view re-reads on every state update.
 * That is what lets a question edited through the sidecar alone (no ProseMirror node changes) or
 * Produce mode switching on or off show up the next time anything dispatches a transaction — a
 * caller that needs it sooner dispatches an empty one (`view.dispatch(view.state.tr)`) — with no
 * plugin state of its own to keep in sync.
 *
 * `enabled` and `questionsOf` are read fresh on every draw rather than captured once, so the
 * caller's mode flag and the document store's sidecar stay the single source of truth.
 */

/** The class every question hint carries, so a stylesheet can target the whole set. */
export const QUESTION_HINT_CLASS = "question-hint";

/** One entry per top-level heading, in document order; `""` for a heading with no question. */
export type QuestionsOf = () => readonly string[];

/**
 * The one DOM call this module makes, in the one place a headless test can reach it (the same
 * split {@link delimiterDOM} in ./reveal.ts makes): the widget's element is built from the view's
 * own document, never a global.
 */
export function hintDOM(text: string, onActivate: () => void): (view: { dom: { ownerDocument: Document } }) => Node {
  return (view) => {
    const element = view.dom.ownerDocument.createElement("div");
    element.className = QUESTION_HINT_CLASS;
    element.setAttribute("contenteditable", "false");
    element.setAttribute("data-testid", "question-hint");
    element.textContent = text;
    // Read-only (§6.3): a mousedown here must not start a ProseMirror selection drag, only the
    // click that follows it.
    element.addEventListener("mousedown", (event) => event.preventDefault());
    element.addEventListener("click", onActivate);
    return element;
  };
}

/**
 * Every heading's hint widget for `state`, in document order; `DecorationSet.empty` when
 * `enabled` is false. One decoration per top-level heading that has a question — a heading with
 * none gets no widget, the absence case beside the presence one.
 */
export function questionHintDecorations(
  state: EditorState,
  enabled: () => boolean,
  questionsOf: QuestionsOf,
  onActivate: () => void,
): DecorationSet {
  if (!enabled()) return DecorationSet.empty;
  const questions = questionsOf();
  const decorations: Decoration[] = [];
  let index = 0;
  state.doc.forEach((node: PMNode, offset: number) => {
    if (node.type !== schema.nodes.heading) return;
    const at = index;
    index += 1;
    const question = questions[at] ?? "";
    if (question === "") return;
    decorations.push(
      Decoration.widget(offset, hintDOM(question, onActivate), {
        side: -1,
        ignoreSelection: true,
        key: `question-hint:${at}:${question}`,
      }),
    );
  });
  return DecorationSet.create(state.doc, decorations);
}

/**
 * The plugin: no state of its own (matching {@link revealPlugin}'s reasoning in ./reveal.ts), so
 * there is nothing for an undo stack to restore. `onActivate` fires on a click anywhere on a hint,
 * with no argument — every hint's click does the same thing, §6.3's "click → Outline".
 */
export function questionHintsPlugin(
  enabled: () => boolean,
  questionsOf: QuestionsOf,
  onActivate: () => void,
): Plugin {
  return new Plugin({
    props: {
      decorations: (state) => questionHintDecorations(state, enabled, questionsOf, onActivate),
    },
  });
}
