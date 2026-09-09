import type { Nodes, PhrasingContent, Root, RootContent } from "mdast";
import {
  ROOT_PATH,
  childPath,
  format,
  formatWithMap,
  lineStartsOf,
  nodeAt,
  offsetOf,
  parse,
  spellingIndex,
  spellingOffsets,
  spellingPoint,
  type NodeRange,
  type PositionEntry,
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
 *
 * **Two things a (line, ch) pair can be about, and they are not the same document.**
 * {@link cursorMap} speaks *canonical* coordinates throughout — places in `format(root)`, the
 * string the source view is opened with. The bytes in the source view after that are the user's
 * own, and they need not be canonical: extra blank lines, a Setext heading, a `*` bullet all
 * serialise to something else. So a cursor read out of a live source view goes through
 * {@link canonicalCursor} first, which parses those bytes and carries the cursor across through
 * the node it is in and its offset within that node. Inside a node, neither direction assumes one
 * source character per character of the tree: the serializer's escapes and the continuation
 * prefixes of blockquotes and list items are carried by the spelling tables of task 1.2's
 * position map (`SpellingTable`).
 */

/** §6.5's source burst: every document-changing CodeMirror commit carries this coalescing key. */
export const SOURCE_KEY = "source";

/** The chord that swaps the two views. One name: `/` is not a shifted letter. */
export const TOGGLE_KEY = "Mod-/";

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

/** Whether a node type is one of the four marks {@link inlineWidth} recurses into. */
function isMark(type: string): boolean {
  return type === "emphasis" || type === "strong" || type === "delete" || type === "link";
}

/** {@link isMark} as a narrowing over a phrasing node. */
function isMarkNode(
  node: PhrasingContent,
): node is Extract<PhrasingContent, { type: "emphasis" | "strong" | "delete" | "link" }> {
  return isMark(node.type);
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
 * serialisation once. Inside a `text` node the offset is carried across through that node's
 * spelling table, so an escaped character (`\*`) and a continuation prefix (`> `, a list item's
 * indentation) are counted as the serializer wrote them and not as one character each. Every
 * other node is answered with its own start — the map places nodes, and only a text node's bytes
 * are its text (see {@link walkBlock}) — except on the delimiters of a mark, where
 * {@link delimiterPosition} tells the opening one from the closing one.
 */
export function cursorMap(root: Root, doc: PMNode): CursorMap {
  const { map, spellings, lineStarts } = formatWithMap(root);
  const entries = correspondences(root, doc);
  return {
    toSource(pos) {
      const inside = innermostAt(entries, pos);
      if (inside !== null) {
        const range = map.ranges[inside.path];
        const table = spellings[inside.path];
        if (table !== undefined) {
          const { line, column } = spellingPoint(lineStarts, table, pos - inside.pmStart);
          return { line, ch: column - 1 };
        }
        if (range !== undefined) return { line: range.startLine, ch: range.startCol - 1 };
      }
      return afterLastNode(entries, map, pos);
    },
    toRendered(position) {
      const found = nodeAt(map, position.line, position.ch + 1);
      if (found !== null) {
        const entry = entries.find((candidate) => candidate.path === found.path);
        if (entry !== undefined) {
          const table = spellings[found.path];
          if (table !== undefined) {
            return entry.pmStart + spellingIndex(lineStarts, table, position.line, position.ch + 1);
          }
          return delimiterPosition(entry, found, map, position);
        }
      }
      return afterLastLine(entries, map, position);
    },
  };
}

/**
 * Where a position that landed on a node rather than inside one of its `text` descendants goes.
 *
 * `nodeAt` answers with a mark (`emphasis`, `strong`, `delete`, `link`) exactly when the position
 * is on one of the mark's own delimiters — `*`, `**`, `~~`, or a link's `](url)` — because the
 * children cover everything between them. A delimiter is not a character of the document, so the
 * cursor belongs beside the mark, and which side is decided by the content it sits on: at or past
 * the end of the mark's last child it is the closing delimiter and the answer is the position
 * after the mark; anywhere else it is the opening one and the answer is the position before it.
 * Every other node answers with its own start, as before.
 */
function delimiterPosition(
  entry: Correspondence,
  found: PositionEntry,
  map: PositionMap,
  position: SourcePosition,
): number {
  if (!isMark(found.node.type)) return entry.pmStart;
  const children = "children" in found.node ? found.node.children : [];
  const last = map.ranges[childPath(found.path, children.length - 1)];
  if (last === undefined) return entry.pmStart;
  const column = position.ch + 1;
  const after =
    position.line > last.endLine || (position.line === last.endLine && column >= last.endCol);
  return after ? entry.pmEnd : entry.pmStart;
}

/* ------------------------------------------------------------------ live source coords ---- */

/** One node of a parsed live buffer: its path, and the offsets its source occupies. */
interface LiveNode {
  readonly path: string;
  readonly node: Nodes;
  readonly start: number;
  readonly end: number;
}

/**
 * The place in `format(parse(text))` that (`line`, `ch`) of `text` names.
 *
 * The source view holds the user's own bytes, and `cursorMap` speaks canonical coordinates, so a
 * cursor read from a live view is translated here first: `text` is parsed, the node the cursor is
 * in is found in *its* coordinates, and the cursor is re-expressed as that node's own path and an
 * offset within it — which the canonical position map then places, escapes and continuation
 * prefixes included. `alpha\n\n\n\nbeta` and `alpha\n\nbeta` parse to the same tree, so the cursor
 * before `beta` is the same cursor in both, whichever line the user's bytes put it on.
 *
 * Line endings are normalised exactly as `parse` normalises them, so the offsets the parser
 * reports and the (line, ch) CodeMirror reports describe the same string; CodeMirror counts a
 * `\r\n` and a lone `\r` as one line break too, so no line number moves under the rewrite.
 *
 * A position no node owns — a blank line, the end of a document — is answered from the last node
 * that ends at or before it, whose canonical end is where `cursorMap` will look for the block
 * above; with no such node the answer is the top of the document.
 */
export function canonicalCursor(text: string, position: SourcePosition): SourcePosition {
  const live = text.replace(/\r\n?/g, "\n");
  const root = parse(live);
  const liveStarts = lineStartsOf(live);
  const offset = offsetOf(liveStarts, position.line, position.ch + 1);
  const nodes = liveNodes(root);
  const { map, spellings, lineStarts } = formatWithMap(root);

  const inside = innermostLive(nodes, offset);
  if (inside !== null) {
    const range = map.ranges[inside.path];
    const table = spellings[inside.path];
    if (inside.node.type === "text") {
      const written = spellingOffsets(inside.node.value, live, inside.start);
      if (table !== undefined && written !== undefined) {
        const index = spellingIndex(liveStarts, written, position.line, position.ch + 1);
        const { line, column } = spellingPoint(lineStarts, table, index);
        return { line, ch: column - 1 };
      }
    }
    if (range !== undefined) return { line: range.startLine, ch: range.startCol - 1 };
  }
  const before = lastLiveNodeBefore(nodes, offset);
  const range = before === null ? undefined : map.ranges[before.path];
  if (range === undefined) return { line: 1, ch: 0 };
  return { line: range.endLine, ch: range.endCol - 1 };
}

/** Every node of a parsed buffer that carries source offsets, in pre-order, the root excluded. */
function liveNodes(root: Root): LiveNode[] {
  const out: LiveNode[] = [];
  const visit = (node: Nodes, path: string): void => {
    const at = node.position;
    if (path !== ROOT_PATH && at?.start.offset !== undefined && at.end.offset !== undefined) {
      out.push({ path, node, start: at.start.offset, end: at.end.offset });
    }
    if ("children" in node) {
      (node.children as Nodes[]).forEach((child, index) => visit(child, childPath(path, index)));
    }
  };
  visit(root, ROOT_PATH);
  return out;
}

/** The innermost live node covering `offset`, or `null`. A boundary belongs to the later node. */
function innermostLive(nodes: readonly LiveNode[], offset: number): LiveNode | null {
  let best: LiveNode | null = null;
  for (const node of nodes) {
    if (node.start <= offset && offset <= node.end) best = node;
  }
  return best;
}

/** The last live node ending at or before `offset`, which is what an unowned position is after. */
function lastLiveNodeBefore(nodes: readonly LiveNode[], offset: number): LiveNode | null {
  let best: LiveNode | null = null;
  for (const node of nodes) {
    if (node.end <= offset && (best === null || node.end >= best.end)) best = node;
  }
  return best;
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
  /**
   * Injected timer for the deferred commit: run `run` in `ms`, and return the cancel for it.
   * `setTimeout`/`clearTimeout` by default; a test injects a clock it steps by hand.
   */
  readonly schedule?: (run: () => void, ms: number) => () => void;
}

export interface SourceBinding {
  /** The source view's text changed: remember it, and commit it at the end of the burst. */
  change(text: string): void;
  /** Commit the text typed since the last commit now. A no-op when nothing is pending. */
  flush(): void;
  /** Flush, then stop pulling store changes into the view. */
  destroy(): void;
}

/** {@link SourceBindOptions.schedule}'s default: a plain timer. */
function timerSchedule(run: () => void, ms: number): () => void {
  const handle: ReturnType<typeof setTimeout> = setTimeout(run, ms);
  return () => clearTimeout(handle);
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
 *
 * **The commit waits for the end of the burst** (task 1.17; DECISIONS #review-1-r0 F5). `parse` is
 * 37 ms on a 10 k-word document against `format`'s 0.9 ms, so parsing the whole buffer on every
 * keystroke put the largest single cost in the product on the keystroke path. The store coalesces
 * a source burst into one undo entry anyway, so nothing is gained by pushing each keystroke:
 * `change` records the text and schedules the commit one coalescing window later, and a further
 * keystroke inside that window replaces both the text and the timer. The window is the stack's own
 * (`coalesceWindowMs`), so the chain of keystrokes that becomes one commit here is exactly the
 * chain that used to become one coalesced undo entry — the grouping the user sees is unchanged,
 * and so is `openKey`, because the deferred commit still carries `coalesceKey`.
 *
 * In between, the CodeMirror buffer is what the user sees and it is already authoritative (above),
 * so a pending commit changes nothing on screen. What it does change is that the typed text is not
 * in the store yet, so anything that reads the store instead of the buffer flushes first:
 * {@link SourceBinding.flush} for a toggle, {@link SourceBinding.destroy} for an unmount. A pull
 * goes the other way — an undo, a redo, a loaded fixture supersede what was typed, so the pending
 * commit is dropped rather than written over the snapshot that has just arrived.
 */
export function bindCodeMirror(
  store: DocumentStore,
  view: BoundSourceView,
  options: SourceBindOptions = {},
): SourceBinding {
  const coalesceKey = options.coalesceKey ?? SOURCE_KEY;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? timerSchedule;
  let shown = store.getState().document.root;
  let shownText = "";
  /** The text typed since the last commit, and the cancel of the commit scheduled for it. */
  let pending: string | null = null;
  let cancel: (() => void) | null = null;

  /** Forget the pending text and unschedule its commit. */
  const drop = (): void => {
    pending = null;
    if (cancel !== null) cancel();
    cancel = null;
  };

  const commitPending = (): void => {
    const text = pending;
    drop();
    if (text === null) return;
    const { document, commit } = store.getState();
    const root = parse(text);
    shown = root;
    shownText = text;
    commit(root, document.sidecar, { coalesceKey, at: now() });
  };

  const pull = (root: Root): void => {
    drop();
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
      // with text this binding has just written; that is the echo, and it commits nothing. The
      // text last *seen* is the pending one while a commit is waiting: typing a character and
      // deleting it again inside one window is a change back to `shownText`, and taking that for
      // an echo would leave the pending commit to write the deleted character back.
      if (text === (pending ?? shownText)) return;
      pending = text;
      if (cancel !== null) cancel();
      cancel = schedule(commitPending, store.getState().stack.coalesceWindowMs);
    },
    flush: commitPending,
    destroy() {
      commitPending();
      unsubscribe();
    },
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
