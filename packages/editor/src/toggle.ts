import type { Nodes, PhrasingContent, Root, RootContent } from "mdast";
import {
  ROOT_PATH,
  childPath,
  format,
  formatWithMap,
  nodeAt,
  parse,
  type NodeRange,
  type PositionMap,
} from "@essaydown/core";
import type {
  EditorState as SourceEditorState,
  Extension,
  TransactionSpec,
} from "@codemirror/state";
import { keymap as codeMirrorKeymap, type KeyBinding } from "@codemirror/view";
import { keymap as proseMirrorKeymap } from "prosemirror-keymap";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection, type Command, type Plugin, type Selection } from "prosemirror-state";
import { schema } from "./schema.js";
import type { DocumentStore } from "./store.js";

/**
 * The source toggle of PRD §6.5 and task 1.7: Cmd/Ctrl+/ swaps the rendered (ProseMirror) view
 * and the source (CodeMirror) view over the one document store of task 1.6, carrying the cursor
 * across through the position map of task 1.2.
 *
 * **The store is the document, so a toggle is not an edit.** {@link toggleMode} only closes the
 * open coalescing group ({@link DocumentStoreState.endCoalescing}); it pushes nothing, so the
 * first Undo after a toggle undoes the last real edit and there is no no-op step to press through.
 * The two views are both bound to the store — {@link bindProseMirror} and
 * {@link bindCodeMirror} — so neither has to be told what the other did.
 *
 * **The source view holds the user's bytes, the store holds a tree.** Every source edit is parsed
 * and committed with the `"source"` coalescing key, and `parse` is lenient: an unclosed fence, a
 * half-typed table, a front-matter block with its terminator deleted all parse to *something*, so
 * an intermediate source state is a legal document and never an error. The store's root is that
 * lenient parse; the source view keeps showing the bytes the user typed (the binding remembers
 * them and skips its own echo), so nothing reformats under the cursor mid-edit.
 *
 * **Cursor mapping.** A ProseMirror position and a (line, ch) pair are related through the
 * correspondence between the ProseMirror doc and the mdast tree — which is 1:1 by construction
 * (`schema.ts`), except that ProseMirror needs a placeholder paragraph wherever `block+` has
 * nothing to hold and mdast keeps `yaml` outside the doc — composed with 1.2's position map,
 * which places every mdast node in the canonical string. Coordinates are CodeMirror's: `line` is
 * 1-based, `ch` is a 0-based offset in UTF-16 code units, while the position map's columns are
 * 1-based, so the two differ by exactly one and the conversion is spelled out at every crossing.
 */

/** §6.5's source burst: every document-changing CodeMirror commit carries this coalescing key. */
export const SOURCE_KEY = "source";

/** The chord that swaps the two views. One name: `/` is not a shifted letter. */
export const TOGGLE_KEY = "Mod-/";

/** LF, the only line terminator the canonical string contains (`format` emits `\n`). */
const NEWLINE = 10;

/** Which of the two views is showing. */
export type EditorMode = "rendered" | "source";

/** A cursor in the canonical Markdown, in CodeMirror's coordinates: 1-based line, 0-based `ch`. */
export interface SourcePosition {
  readonly line: number;
  readonly ch: number;
}

/** The other mode. A toggle is an involution, so this is the whole of "which way". */
export function otherMode(mode: EditorMode): EditorMode {
  return mode === "rendered" ? "source" : "rendered";
}

/**
 * Perform one toggle over `store` and return the mode to show next.
 *
 * §6.5: "a source/rendered toggle ends the current coalescing group without pushing a new
 * snapshot". Both halves matter — closing the group makes the edit *after* a toggle its own undo
 * step, and pushing nothing keeps the toggle itself invisible to Undo.
 */
export function toggleMode(store: DocumentStore, mode: EditorMode): EditorMode {
  store.getState().endCoalescing();
  return otherMode(mode);
}

/* ------------------------------------------------------------------ correspondence -------- */

/** One mdast node, its path in the root, and the ProseMirror positions it occupies. */
interface Correspondence {
  readonly path: string;
  readonly node: Nodes;
  /** First ProseMirror position the node covers. */
  readonly pmStart: number;
  /** One past the last position it covers. */
  readonly pmEnd: number;
}

/** An mdast child paired with the path it has in its root. */
interface PathedChild {
  readonly node: RootContent;
  readonly path: string;
}

function pathed(children: readonly RootContent[], parentPath: string): PathedChild[] {
  return children.map((node, index) => ({ node, path: childPath(parentPath, index) }));
}

/**
 * The one ProseMirror node with no mdast counterpart: `schema.ts` inserts an empty paragraph
 * wherever `block+` needs a block and mdast has none, and drops it again on the way back. It is
 * therefore skipped here without consuming an mdast sibling — the exact inverse of
 * `blocksToMdast` — so a document the user has opened a blank line in still lines up.
 */
function isPlaceholder(node: PMNode): boolean {
  return node.type === schema.nodes.paragraph && node.content.size === 0;
}

/**
 * How many ProseMirror positions one phrasing node's content occupies. mdast nests marks and
 * ProseMirror puts them on the text, so a mark node is exactly as wide as its children and a leaf
 * that is not text (`image`, `break`, `html`) is one position wide, like the atom it becomes.
 */
function inlineWidth(node: PhrasingContent): number {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value.length;
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
      return node.children.reduce((total, child) => total + inlineWidth(child), 0);
    default:
      return 1;
  }
}

/** Whether `node` is one of the four mark nodes {@link inlineWidth} recurses into. */
function isMarkNode(
  node: PhrasingContent,
): node is Extract<PhrasingContent, { type: "emphasis" | "strong" | "delete" | "link" }> {
  return (
    node.type === "emphasis" ||
    node.type === "strong" ||
    node.type === "delete" ||
    node.type === "link"
  );
}

function walkInline(
  contentStart: number,
  children: readonly PhrasingContent[],
  path: string,
  out: Correspondence[],
): void {
  let offset = 0;
  children.forEach((node, index) => {
    const pmStart = contentStart + offset;
    const width = inlineWidth(node);
    const nodePath = childPath(path, index);
    out.push({ path: nodePath, node, pmStart, pmEnd: pmStart + width });
    if (isMarkNode(node)) walkInline(pmStart, node.children, nodePath, out);
    offset += width;
  });
}

function walkBlocks(
  parent: PMNode,
  contentStart: number,
  children: readonly PathedChild[],
  out: Correspondence[],
): void {
  let index = 0;
  parent.forEach((child, offset) => {
    if (isPlaceholder(child)) return;
    const counterpart = children[index];
    index += 1;
    if (counterpart !== undefined) walkBlock(child, contentStart + offset, counterpart, out);
  });
}

function walkBlock(pm: PMNode, pmStart: number, entry: PathedChild, out: Correspondence[]): void {
  const { node, path } = entry;
  out.push({ path, node, pmStart, pmEnd: pmStart + pm.nodeSize });
  const contentStart = pmStart + 1;
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "tableCell":
      walkInline(contentStart, node.children, path, out);
      return;
    case "blockquote":
    case "listItem":
    case "list":
    case "table":
    case "tableRow":
      walkBlocks(pm, contentStart, pathed(node.children, path), out);
      return;
    default:
      // `code`, `thematicBreak` and `html` are placed but not entered: their bytes are not their
      // text (a fence line precedes a code block's value), so the position map cannot say where
      // inside them a given character went, and a cursor in one maps to the node itself.
      return;
  }
}

/**
 * The correspondence list for one `(root, doc)` pair, in pre-order — a parent always precedes its
 * children — so "the last entry containing this position" is the innermost one.
 *
 * `doc` is taken rather than derived from `root` because the view's document is the live one: it
 * can hold a placeholder paragraph the last commit dropped, and the mapping has to be right for
 * the document the cursor is actually in.
 */
function correspondences(root: Root, doc: PMNode): Correspondence[] {
  const out: Correspondence[] = [];
  const blocks = pathed(root.children, ROOT_PATH).filter((entry) => entry.node.type !== "yaml");
  walkBlocks(doc, 0, blocks, out);
  return out;
}

/* ------------------------------------------------------------------ the cursor map ------- */

/**
 * Walk `offset` UTF-16 code units into `value` from the start of `range`.
 *
 * The walk counts a `\n` as a new line and everything else as one column, which is a *lower
 * bound* on the real column: wherever the serializer escaped a character (`\*`) or prefixed a
 * line (`> `, list indentation) the canonical string is longer than the value, never shorter. So
 * the result is always inside the node's own range, and it is exact for the ordinary case of a
 * paragraph of unescaped prose, which is the case a cursor is in.
 */
function advance(range: NodeRange, value: string, offset: number): SourcePosition {
  let line = range.startLine;
  let col = range.startCol;
  for (let i = 0; i < offset; i += 1) {
    if (value.charCodeAt(i) === NEWLINE) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, ch: col - 1 };
}

/** The innermost correspondence covering `pos`, or `null`. A boundary belongs to the later node. */
function innermostAt(entries: readonly Correspondence[], pos: number): Correspondence | null {
  let best: Correspondence | null = null;
  for (const entry of entries) {
    if (entry.pmStart <= pos && pos <= entry.pmEnd) best = entry;
  }
  return best;
}

/**
 * Where a position no node owns goes: to the end of the last node that ends at or before it — the
 * placeholder paragraph of an opened blank line, and any node the position map left unresolved,
 * both land here. With nothing before it the cursor goes to the top of the document.
 */
function afterLastNode(
  entries: readonly Correspondence[],
  map: PositionMap,
  pos: number,
): SourcePosition {
  let best: NodeRange | null = null;
  let bestEnd = -1;
  for (const entry of entries) {
    const range = map.ranges[entry.path];
    if (range === undefined || entry.pmEnd > pos || entry.pmEnd < bestEnd) continue;
    best = range;
    bestEnd = entry.pmEnd;
  }
  return best === null ? { line: 1, ch: 0 } : { line: best.endLine, ch: best.endCol - 1 };
}


/** The inverse of {@link advance}: how far into `value` the (line, ch) of `position` is. */
function offsetWithin(range: NodeRange, value: string, position: SourcePosition): number {
  const col = position.ch + 1;
  let line = range.startLine;
  let column = range.startCol;
  for (let i = 0; i < value.length; i += 1) {
    if (line > position.line || (line === position.line && column >= col)) return i;
    if (value.charCodeAt(i) === NEWLINE) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return value.length;
}

/**
 * {@link afterLastNode}'s mirror: the ProseMirror position for a place in the canonical string
 * that no node owns — a blank line, a column past the end of a line, or a line belonging to a node
 * (`yaml`) the ProseMirror document does not hold.
 *
 * The answer is built from the last node that *ends* at or before `position`, and a node and its
 * innermost descendant usually end at the same place (a paragraph and its last text node both end
 * after the last character). That tie is broken by where the unowned position is relative to that
 * end, and this is the one rule for it:
 *
 * - same line — the cursor is in the trailing columns of the node's own last line, so it belongs
 *   *inside* the block: the innermost end (`text`'s `pmEnd`, the position after its last
 *   character).
 * - a later line — the block is over, so the cursor belongs *after* it: the outermost end (the
 *   block's `pmEnd`), which {@link renderedSelection} then snaps into whatever follows.
 *
 * `entries` is in pre-order, so among the tied entries the first is the outermost and the last the
 * innermost; the tightest (smallest) `pmEnd` is taken for the inner answer either way.
 */
function afterLastLine(
  entries: readonly Correspondence[],
  map: PositionMap,
  position: SourcePosition,
): number {
  const col = position.ch + 1;
  let bestLine = 0;
  let bestCol = 0;
  let outer = 0;
  let inner = 0;
  for (const entry of entries) {
    const range = map.ranges[entry.path];
    if (range === undefined) continue;
    if (range.endLine > position.line || (range.endLine === position.line && range.endCol > col)) {
      continue;
    }
    if (range.endLine > bestLine || (range.endLine === bestLine && range.endCol > bestCol)) {
      bestLine = range.endLine;
      bestCol = range.endCol;
      outer = entry.pmEnd;
      inner = entry.pmEnd;
    } else if (range.endLine === bestLine && range.endCol === bestCol) {
      inner = Math.min(inner, entry.pmEnd);
    }
  }
  return position.line === bestLine ? inner : outer;
}

/** The two directions of the cursor mapping for one `(root, doc)` pair. */
export interface CursorMap {
  /** The place in `format(root)` that ProseMirror position `pos` names. */
  toSource(pos: number): SourcePosition;
  /**
   * The ProseMirror position that `position` in `format(root)` names. Raw: it can name a place
   * between two blocks (a blank line names the end of the block above it), which is why
   * {@link renderedSelection} snaps it before it becomes a selection.
   */
  toRendered(position: SourcePosition): number;
}

/**
 * The cursor mapping between `doc`'s positions and `format(root)`'s (line, ch) pairs.
 *
 * Both directions share one position map and one correspondence list, so a toggle pays for the
 * serialisation once. Inside a `text` node the offset is carried across character by character;
 * every other node is answered with its own start, because the map places nodes and only a text
 * node's bytes are its text (see {@link walkBlock}).
 */
export function cursorMap(root: Root, doc: PMNode): CursorMap {
  const { map } = formatWithMap(root);
  const entries = correspondences(root, doc);
  return {
    toSource(pos) {
      const inside = innermostAt(entries, pos);
      if (inside !== null) {
        const range = map.ranges[inside.path];
        if (range !== undefined) {
          return inside.node.type === "text"
            ? advance(range, inside.node.value, pos - inside.pmStart)
            : { line: range.startLine, ch: range.startCol - 1 };
        }
      }
      return afterLastNode(entries, map, pos);
    },
    toRendered(position) {
      const found = nodeAt(map, position.line, position.ch + 1);
      if (found !== null) {
        const entry = entries.find((candidate) => candidate.path === found.path);
        if (entry !== undefined) {
          return found.node.type === "text"
            ? entry.pmStart + offsetWithin(found, found.node.value, position)
            : entry.pmStart;
        }
      }
      return afterLastLine(entries, map, position);
    },
  };
}

/** `pos` as a selection of `doc`, clamped into the document and snapped to a text position. */
export function renderedSelection(doc: PMNode, pos: number): Selection {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  return TextSelection.near(doc.resolve(clamped));
}

/* ------------------------------------------------------------------ CodeMirror coords ----- */

/** The cursor of a CodeMirror state, in {@link SourcePosition} coordinates. */
export function sourceCursor(state: SourceEditorState): SourcePosition {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, ch: head - line.from };
}

/** `position` as an absolute offset in `state`'s document, clamped to a place that exists. */
export function sourceOffset(state: SourceEditorState, position: SourcePosition): number {
  const number = Math.min(Math.max(position.line, 1), state.doc.lines);
  const line = state.doc.line(number);
  return Math.min(line.from + Math.max(position.ch, 0), line.to);
}

/* ------------------------------------------------------------------ the source binding ---- */

/**
 * The part of CodeMirror's `EditorView` a binding uses. Narrowed to these two so the wiring is
 * covered headlessly, for the reason `BoundView` gives on the ProseMirror side.
 */
export interface BoundSourceView {
  readonly state: SourceEditorState;
  dispatch(spec: TransactionSpec): void;
}

export interface SourceBindOptions {
  /** The coalescing key a source burst carries; {@link SOURCE_KEY} by default. */
  readonly coalesceKey?: string;
  /** Injected clock, so a test can place two bursts an exact distance apart. */
  readonly now?: () => number;
}

export interface SourceBinding {
  /** The source view's text changed: parse it leniently and commit. Call from an update listener. */
  change(text: string): void;
  /** Stop pulling store changes into the view. */
  destroy(): void;
}

/**
 * Wire a source (CodeMirror) view to `store`, in both directions, and pull the store's current
 * document into it straight away.
 *
 * The two directions are told apart the same way the ProseMirror binding tells them apart, by
 * identity rather than by bytes: the binding remembers the `Root` it last put into or took out of
 * the view, and a store notification carrying that same object is its own echo. It remembers the
 * *text* as well, because the source view is the one place where the document the user sees is
 * not `format(root)` — an intermediate edit is whatever they typed, and re-serialising the lenient
 * parse back over it would move the cursor and un-type half a fence.
 */
export function bindCodeMirror(
  store: DocumentStore,
  view: BoundSourceView,
  options: SourceBindOptions = {},
): SourceBinding {
  const coalesceKey = options.coalesceKey ?? SOURCE_KEY;
  const now = options.now ?? Date.now;
  let shown = store.getState().document.root;
  let shownText = "";

  const pull = (root: Root): void => {
    shown = root;
    const text = format(root);
    shownText = text;
    if (view.state.doc.toString() === text) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  };

  pull(shown);
  const unsubscribe = store.subscribe((state) => {
    if (state.document.root !== shown) pull(state.document.root);
  });

  return {
    change(text) {
      // The pull above dispatches a change of its own, so the view's update listener calls back
      // with text this binding has just written; that is the echo, and it commits nothing.
      if (text === shownText) return;
      const { document, commit } = store.getState();
      const root = parse(text);
      shown = root;
      shownText = text;
      commit(root, document.sidecar, { coalesceKey, at: now() });
    },
    destroy: unsubscribe,
  };
}

/* ------------------------------------------------------------------ the chord ------------- */

/** Cmd/Ctrl+/ for the rendered view. */
export function toggleKeymap(toggle: () => void): Record<string, Command> {
  return {
    [TOGGLE_KEY]: () => {
      toggle();
      return true;
    },
  };
}

/** {@link toggleKeymap} as a plugin, to sit beside `storePlugins` and before the editing keymaps. */
export function togglePlugins(toggle: () => void): Plugin[] {
  return [proseMirrorKeymap(toggleKeymap(toggle))];
}

/** The same chord for the source view. */
export function toggleKeyBindings(toggle: () => void): KeyBinding[] {
  return [
    {
      key: TOGGLE_KEY,
      run: () => {
        toggle();
        return true;
      },
      preventDefault: true,
    },
  ];
}

/** {@link toggleKeyBindings} as a CodeMirror extension, to sit beside `sourceExtensions()`. */
export function sourceToggleKeymap(toggle: () => void): Extension {
  return codeMirrorKeymap.of(toggleKeyBindings(toggle));
}
