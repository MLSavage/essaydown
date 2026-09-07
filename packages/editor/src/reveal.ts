import type { Mark, Node as PMNode } from "prosemirror-model";
import { Plugin, type EditorState, type Selection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { marks as markSpecs, schema } from "./schema.js";

/**
 * Reveal-on-active-line: the Markdown delimiters of the marks and the heading level are drawn as
 * widget decorations on the block the cursor is in, and nowhere else.
 *
 * Nothing here changes the document. A delimiter is a {@link Decoration.widget} — DOM that
 * ProseMirror draws at a position and that is not part of the doc — so `pmToMdast` sees the same
 * tree whether a delimiter is showing or not, and a block loses its delimiters by simply not
 * being decorated any more. `revealDecorations` is a pure function of the state and is installed
 * as the plugin's `decorations` prop, which the view re-reads on every state update, including a
 * selection-only one; that is what makes the reveal follow the cursor.
 *
 * **What is decorated.** The task text names emphasis, strong, code, links and headings, so those
 * five are what {@link markDelimiters} and {@link revealDelimiters} produce: `*`, `**`, `` ` ``,
 * `[` … `](url)` and `#` … `######`. The schema's fifth mark, `delete`, is deliberately *not*
 * revealed — it is not in the task text — and `reveal.test.ts` asserts its absence beside the
 * presence cases rather than leaving the gap silent. Block-level delimiters are not revealed
 * either: a code block's fences, a blockquote's `>` and a list's bullets are structure the
 * rendered view already shows, and the task text names none of them.
 *
 * **Ownership of the ends of a run.** A mark run over a block's inline children is the half-open
 * range `[from, to)` of document positions its children cover: the opening delimiter is drawn at
 * `from`, the closing one at `to`, and a position that no run covers gets no delimiter. A mark
 * covering no child cannot exist in ProseMirror (a mark is a property of a node, so a zero-width
 * run has no node to hang on), so no delimiter is ever drawn for one; adjacent runs of different
 * marks therefore meet at one position, where the closing delimiter of the first is drawn before
 * the opening delimiter of the second. `reveal.test.ts` tests a run at the first, middle and last
 * position of a paragraph.
 *
 * **The `side` numbers**, which is how that ordering is expressed: widgets at one position are
 * drawn in ascending `side`. A closing delimiter takes a negative side and an opening one a
 * positive side, so a close always precedes an open at the same position; within each group the
 * mark's rank in {@link markSpecs} — the schema's nesting order, `link` outermost — orders them,
 * so `[**a**](url)` reveals as `[`, `**`, `a`, `**`, `](url)`. The sign has a second, matching
 * meaning in prosemirror-view: a negative side draws the widget before a cursor at that position
 * and puts inserted content after it, which is what keeps a closing delimiter attached to the
 * text it closes. The heading marker sits at the block start, before every opening delimiter, and
 * takes a negative side for the same cursor reason; no run can close there, so nothing collides
 * with it.
 */

/** The class every revealed delimiter carries, so a later theme can restyle the whole set. */
export const DELIMITER_CLASS = "essaydown-delimiter";

/**
 * Muted grey, inline for the same reason as the schema's grey box: the delimiters are legible
 * wherever this plugin is mounted, with no stylesheet for this task to invent, and
 * {@link DELIMITER_CLASS} is there for a theme to override.
 */
const DELIMITER_STYLE = "color:#a9a9a4;font-weight:normal;font-style:normal;";

/** Drawn before every opening delimiter of the block; see the module comment. */
const HEADING_SIDE = -1000;

/** The schema's mark declaration order, which is its nesting order (see {@link markSpecs}). */
const MARK_ORDER = Object.keys(markSpecs);

/** One revealed delimiter: the literal Markdown, where it is drawn, and in which order. */
export interface Delimiter {
  /** The document position the delimiter is drawn at. */
  pos: number;
  /** prosemirror-view's widget `side`: the drawing order at one position. */
  side: number;
  /** The literal Markdown shown. */
  text: string;
  /** What it belongs to: a mark type name, or `heading`. */
  kind: string;
}

interface Run {
  mark: Mark;
  open: string;
  close: string;
  rank: number;
  from: number;
  to: number;
}

/**
 * The Markdown that opens and closes `mark`, or null for a mark this task does not reveal.
 *
 * The link's closing delimiter carries its destination, which is what the writer needs to see;
 * this is the delimiter as it is *displayed*, not a serializer — the authoritative bytes are the
 * formatter's, and no document is written from this string.
 */
export function markDelimiters(mark: Mark): { open: string; close: string } | null {
  switch (mark.type.name) {
    case "strong":
      return { open: "**", close: "**" };
    case "emphasis":
      return { open: "*", close: "*" };
    case "inline_code":
      return { open: "`", close: "`" };
    case "link": {
      const url = mark.attrs.url as string;
      const title = mark.attrs.title as string | null;
      return { open: "[", close: title === null ? `](${url})` : `](${url} "${title}")` };
    }
    default:
      return null;
  }
}

/**
 * The textblock the cursor is in, with the position of its first child, or null when there is
 * none — a node selection on a block atom (a `raw` box, a thematic break) resolves to the parent
 * that holds it, not to a textblock.
 *
 * The block is the one containing the selection's *head*, so a selection dragged across two
 * blocks reveals the one the cursor ended in. That is the task text's "the block containing the
 * cursor" read literally; revealing every block a selection touches would be a different feature.
 */
export function activeBlock(selection: Selection): { node: PMNode; start: number } | null {
  const $head = selection.$head;
  for (let depth = $head.depth; depth >= 0; depth--) {
    const node = $head.node(depth);
    if (node.isTextblock) return { node, start: $head.start(depth) };
  }
  return null;
}

/**
 * The maximal runs of each revealed mark over `block`'s inline children.
 *
 * A run is open while consecutive children carry a mark equal to the one that opened it —
 * `Mark.eq`, not the type, so two adjacent links with different urls are two runs — and closes at
 * the first child that does not, or at the end of the block.
 */
function markRuns(block: PMNode, start: number): Run[] {
  const runs: Run[] = [];
  const open = new Map<string, Run>();
  let end = start;
  block.forEach((child, offset) => {
    const from = start + offset;
    end = from + child.nodeSize;
    for (const [name, run] of [...open]) {
      if (!child.marks.some((mark) => mark.eq(run.mark))) {
        run.to = from;
        runs.push(run);
        open.delete(name);
      }
    }
    for (const mark of child.marks) {
      const delimiters = markDelimiters(mark);
      if (delimiters === null) continue;
      if (open.has(mark.type.name)) continue;
      open.set(mark.type.name, {
        mark,
        ...delimiters,
        rank: MARK_ORDER.indexOf(mark.type.name),
        from,
        to: from,
      });
    }
  });
  for (const run of open.values()) {
    run.to = end;
    runs.push(run);
  }
  return runs;
}

/**
 * Every delimiter the active block reveals, in drawing order (by position, then by `side`).
 *
 * Pure: it reads the selection and the nodes it resolves to and touches neither.
 */
export function revealDelimiters(selection: Selection): Delimiter[] {
  const block = activeBlock(selection);
  if (block === null) return [];
  const out: Delimiter[] = [];
  if (block.node.type === schema.nodes.heading) {
    const depth = block.node.attrs.depth as number;
    out.push({
      pos: block.start,
      side: HEADING_SIDE,
      text: `${"#".repeat(depth)} `,
      kind: "heading",
    });
  }
  for (const run of markRuns(block.node, block.start)) {
    const kind = run.mark.type.name;
    out.push({ pos: run.from, side: run.rank + 1, text: run.open, kind });
    out.push({ pos: run.to, side: -(run.rank + 1), text: run.close, kind });
  }
  out.sort((a, b) => a.pos - b.pos || a.side - b.side);
  return out;
}

/**
 * The one DOM call this module makes, in the one place a headless test can reach it: the widget's
 * element is built from the view's own document rather than a global, so `reveal.test.ts` can
 * drive it with a recording double and the browser half of the acceptance can drive it for real.
 */
export function delimiterDOM(text: string): (view: { dom: { ownerDocument: Document } }) => Node {
  return (view) => {
    const element = view.dom.ownerDocument.createElement("span");
    element.className = DELIMITER_CLASS;
    element.setAttribute("contenteditable", "false");
    element.setAttribute("style", DELIMITER_STYLE);
    element.setAttribute("data-delimiter", text);
    element.textContent = text;
    return element;
  };
}

/**
 * `marks: []` is what puts the delimiter *beside* the text rather than inside it: a widget
 * otherwise inherits the marks of its neighbour, so a `**` would be rendered inside the `<strong>`
 * element it opens (bold, and for a link inside the `<a>`, hence clickable).
 */
function toWidget(delimiter: Delimiter): Decoration {
  return Decoration.widget(delimiter.pos, delimiterDOM(delimiter.text), {
    side: delimiter.side,
    marks: [],
    ignoreSelection: true,
    key: `${delimiter.kind}:${delimiter.side}:${delimiter.text}`,
  });
}

/** The decorations for a state: {@link revealDelimiters}, drawn. */
export function revealDecorations(state: EditorState): DecorationSet {
  return DecorationSet.create(state.doc, revealDelimiters(state.selection).map(toWidget));
}

/**
 * The plugin. It keeps no state of its own — the decorations are recomputed from the state the
 * view hands the prop — so it adds nothing an undo stack would have to restore (PRD §4, task 1.6).
 */
export function revealPlugin(): Plugin {
  return new Plugin({ props: { decorations: revealDecorations } });
}
