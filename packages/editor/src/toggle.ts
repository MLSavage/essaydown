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
import { Mark, type Node as PMNode } from "prosemirror-model";
import { TextSelection, type Command, type Plugin, type Selection } from "prosemirror-state";
import {
  CELL_LINE_ENDING,
  LINE_ENDING,
  keptCharacters,
  schema,
  type KeptCharacters,
} from "./schema.js";
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

/**
 * One textblock's live inline content, normalised: where its content starts in the live document,
 * and the kept-character map of the children the conversion read ({@link keptCharacters}). Every
 * inline correspondence's positions are read from it, so the map speaks the live document's
 * coordinates even where the conversion dropped characters the live document still holds.
 */
interface InlineBlock {
  /** The live position of the block's first content character. */
  readonly contentStart: number;
  readonly chars: KeptCharacters;
}

/** One mdast node, its path in the root, and the ProseMirror positions it occupies. */
interface Correspondence {
  readonly path: string;
  readonly node: Nodes;
  /** First ProseMirror position the node covers — a **live** position. */
  readonly pmStart: number;
  /** One past the last live position it covers. */
  readonly pmEnd: number;
  /**
   * For an inline node: the block whose kept-character map placed it, and the offset of its first
   * unit in that block's normalised sequence. Absent for a block entry, whose positions are the
   * editor's own node extents.
   */
  readonly inline?: { readonly block: InlineBlock; readonly outputStart: number };
}

/** What {@link correspondences} builds: the entries, and the blocks their positions came from. */
interface Walk {
  readonly entries: Correspondence[];
  readonly blocks: InlineBlock[];
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
 * How many **units of the normalised sequence** one inline leaf occupies — one per UTF-16 code
 * unit of its text, one for an atom (`image`, `break`, `html`), which is what `nodeSize` counts
 * on the ProseMirror node it became. A mark node has no width of its own: its extent is the union
 * of its children's, which {@link walkInline} takes from the cursor it shares with them, so no
 * mdast value's length is ever used as a ProseMirror distance.
 */
function leafUnits(node: PhrasingContent): number {
  return node.type === "text" || node.type === "inlineCode" ? node.value.length : 1;
}

/** Whether a node type is one of the four marks {@link walkInline} recurses into. */
function isMark(type: string): boolean {
  return type === "emphasis" || type === "strong" || type === "delete" || type === "link";
}

/** {@link isMark} as a narrowing over a phrasing node. */
function isMarkNode(
  node: PhrasingContent,
): node is Extract<PhrasingContent, { type: "emphasis" | "strong" | "delete" | "link" }> {
  return isMark(node.type);
}

/**
 * The inline entries of one textblock, in pre-order, walked over the block's **normalised
 * sequence** and placed through its kept-character map: `cursor.offset` counts units of that
 * sequence (a leaf consumes {@link leafUnits}; a mark consumes whatever its children do), and
 * both ends of every entry are the live positions the map answers for those units. A block with
 * no dropped whitespace has the identity map, so every entry is exactly where the widths used to
 * put it.
 */
function walkInline(
  block: InlineBlock,
  children: readonly PhrasingContent[],
  path: string,
  walk: Walk,
  cursor: { offset: number },
): void {
  children.forEach((node, index) => {
    const nodePath = childPath(path, index);
    const outputStart = cursor.offset;
    // Pre-order: the parent's entry is pushed before its children's and its extent patched in
    // once they have consumed their units.
    const at = walk.entries.length;
    walk.entries.push({ path: nodePath, node, pmStart: 0, pmEnd: 0 });
    if (isMarkNode(node)) walkInline(block, node.children, nodePath, walk, cursor);
    else cursor.offset += leafUnits(node);
    const pmStart = block.contentStart + block.chars.liveOf(outputStart);
    walk.entries[at] = {
      path: nodePath,
      node,
      pmStart,
      pmEnd:
        cursor.offset === outputStart
          ? pmStart
          : block.contentStart + block.chars.liveEndOf(cursor.offset),
      inline: { block, outputStart },
    };
  });
}

function walkBlocks(
  parent: PMNode,
  contentStart: number,
  children: readonly PathedChild[],
  walk: Walk,
): void {
  let index = 0;
  parent.forEach((child, offset) => {
    if (isPlaceholder(child)) return;
    const counterpart = children[index];
    index += 1;
    if (counterpart !== undefined) walkBlock(child, contentStart + offset, counterpart, walk);
  });
}

/** One ProseMirror node's children, in order. */
function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((child) => out.push(child));
  return out;
}

function walkBlock(pm: PMNode, pmStart: number, entry: PathedChild, walk: Walk): void {
  const { node, path } = entry;
  walk.entries.push({ path, node, pmStart, pmEnd: pmStart + pm.nodeSize });
  const contentStart = pmStart + 1;
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "tableCell": {
      // The conversion's own normalisation, and where every character it kept came from: the
      // live children and the line ending `blockToMdast` gives this block kind (`schema.ts`).
      const block: InlineBlock = {
        contentStart,
        chars: keptCharacters(
          childrenOf(pm),
          node.type === "tableCell" ? CELL_LINE_ENDING : LINE_ENDING,
        ),
      };
      walk.blocks.push(block);
      walkInline(block, node.children, path, walk, { offset: 0 });
      return;
    }
    case "blockquote":
    case "listItem":
    case "list":
    case "table":
    case "tableRow":
      walkBlocks(pm, contentStart, pathed(node.children, path), walk);
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
function correspondences(root: Root, doc: PMNode): Walk {
  const walk: Walk = { entries: [], blocks: [] };
  const children = pathed(root.children, ROOT_PATH).filter((entry) => entry.node.type !== "yaml");
  walkBlocks(doc, 0, children, walk);
  return walk;
}

/* ------------------------------------------------------------------ the cursor map ------- */

/**
 * Whether {@link walkBlock} walked `node`'s children, so that a position it covers but no child
 * does lies *past* its children rather than inside an atom: the phrasing-bearing blocks and the
 * containers, and never a leaf block or a phrasing node.
 */
function isEntered(node: Nodes): boolean {
  switch (node.type) {
    case "paragraph":
    case "heading":
    case "tableCell":
    case "blockquote":
    case "listItem":
    case "list":
    case "table":
    case "tableRow":
      return true;
    default:
      return false;
  }
}

/**
 * The textblock whose live inline content covers `pos`, or `null` (a position between blocks, or
 * inside a block the conversion does not enter). The content ranges of two textblocks are never
 * adjacent — a block's closing token and the next one's opening token lie between them — so at
 * most one block covers a position, edges included.
 */
function blockAt(blocks: readonly InlineBlock[], pos: number): InlineBlock | null {
  for (const block of blocks) {
    if (pos >= block.contentStart && pos <= block.contentStart + block.chars.liveWidth) return block;
  }
  return null;
}

/**
 * `pos` settled onto the live position its output offset answers — the ownership rule of
 * {@link keptCharacters}, applied once, here: a position inside whitespace the conversion dropped
 * is the position of the next kept character, and a position past the last kept character is the
 * block's end. A position the map returns to is its own answer, so a block with no dropped
 * whitespace settles every position to itself.
 */
function settled(block: InlineBlock, pos: number): number {
  const { chars, contentStart } = block;
  return contentStart + chars.liveOf(chars.offsetOf(pos - contentStart));
}

/**
 * Whether the caret at `pos` sits **after whitespace the conversion dropped and no kept node
 * covers** — a hole in the correspondence: the block's start before a stripped lead, or the space
 * between two kept nodes that a line start took — *and* belongs outside the node that follows it.
 *
 * Which of the two the caret is, is the marks a character typed there receives ({@link
 * typedMarks}), read against the live node after it, exactly as {@link innermostAt} reads them
 * against the node before at a boundary: with the dropped whitespace gone from the bytes, the
 * node after is the first thing the source line holds, and a character whose marks are that
 * node's joins it (`a `+backtick+`cd`+backtick+` b` with its lead stripped and stored marks
 * carrying `inline_code`: inside the fence), while a character whose marks are not is written
 * before it, where the dropped whitespace was (the same caret after a click: `$pos.marks()` is
 * the whitespace's own, empty, so `X`+backtick+`cd`+backtick+` b`). Only the second is this
 * clause's: the caret is then answered as a position *between* nodes, which is the block entry's
 * own rule ({@link lastNodeEnd} from the block's start, the block's first column where nothing
 * precedes it).
 */
function beyondDroppedWhitespace(
  block: InlineBlock,
  doc: PMNode,
  pos: number,
  marks: readonly Mark[],
): boolean {
  const { chars, contentStart } = block;
  const before = pos - contentStart - 1;
  if (before < 0 || chars.keeps(before)) return false;
  if (chars.ranges.some((range) => range.start <= before && before < range.end)) return false;
  const after = doc.resolve(pos).nodeAfter;
  return after !== null && !Mark.sameSet(marks, after.marks);
}

/** The innermost entered block covering `pos` (`entries` is pre-order, so the last one). */
function enclosingBlock(entries: readonly Correspondence[], pos: number): Correspondence | null {
  let best: Correspondence | null = null;
  for (const entry of entries) {
    if (isEntered(entry.node) && entry.pmStart <= pos && pos <= entry.pmEnd) best = entry;
  }
  return best;
}

/**
 * The source caret *between* two of a block's inline nodes: the end of the last of its
 * descendants that ends at or before `pos` ({@link lastNodeEnd} from the block's own start) and,
 * where none does, the **start of its first inline child** — never the block's own start, which
 * is where its marker is (`# `, `- `, a cell's pipe and padding) and not where its text begins.
 * `entries` is in pre-order, so the first entry under the block's path is that child.
 */
function betweenNodes(
  entries: readonly Correspondence[],
  map: PositionMap,
  block: Correspondence,
  pos: number,
): SourcePosition | null {
  const before = lastNodeEnd(entries, map, pos, block.pmStart);
  if (before !== null) return before;
  const prefix = `${block.path}.`;
  const first = entries.find((entry) => entry.path.startsWith(prefix));
  const range = map.ranges[first === undefined ? block.path : first.path];
  return range === undefined ? null : { line: range.startLine, ch: range.startCol - 1 };
}

/**
 * The offset **inside `entry`** — an index into its spelling table — that live position `pos`
 * names, and its inverse: the live position an offset inside `entry` sits at. Both translate
 * through the entry's block's kept-character map, so a character after whitespace the conversion
 * dropped is indexed by what the tree holds and placed by what the editor holds. Where an entry
 * has no map (a block, or a root the caller did not derive from `doc`) the two are the plain
 * arithmetic they were.
 */
function leafOffset(entry: Correspondence, pos: number): number {
  if (entry.inline === undefined) return pos - entry.pmStart;
  const { block, outputStart } = entry.inline;
  return block.chars.offsetOf(pos - block.contentStart) - outputStart;
}

function leafPosition(entry: Correspondence, offset: number): number {
  if (entry.inline === undefined) return entry.pmStart + offset;
  const { block, outputStart } = entry.inline;
  return block.contentStart + block.chars.liveOf(outputStart + offset);
}

/**
 * The marks a character typed at `pos` in the rendered view receives: `storedMarks ?? $pos.marks()`
 * — `Transaction.insertText`'s own expression, read in prosemirror-state 1.4.4 (dist/index.js
 * 627–644: `let marks = this.storedMarks; if (!marks) … marks = $from.marks()`, for the empty
 * range a keystroke inserts; the `from == null` path is `replaceSelectionWith`, 609–615, which
 * marks the text `this.storedMarks || selection.$from.marks()`, the same two in the same order).
 * `$pos.marks()` is prosemirror-model's (dist/index.js, `ResolvedPos.marks()`): inside a text
 * node the node's marks; at a boundary the marks of the node *before* (the node after only at the
 * parent's start, where nothing is before), less every mark whose spec says `inclusive: false` and
 * which the other side lacks. `storedMarks` is what the editor put there instead — an input rule's
 * `removeStoredMark`, a mark command with an empty selection — and it wins whenever it is not
 * `null`, so a caller that holds a live `EditorState` passes `state.storedMarks` and a caller that
 * holds only a document passes nothing. `null` everywhere that is not a textblock position, where
 * nothing can be typed.
 */
function typedMarks(
  doc: PMNode,
  pos: number,
  storedMarks: readonly Mark[] | null,
): readonly Mark[] | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  if (!$pos.parent.isTextblock) return null;
  return storedMarks ?? $pos.marks();
}

/**
 * The two inline nodes a position sits between, when it does: `pos` is inside a textblock and
 * has a node on each side. `marks` is {@link typedMarks}' answer at `pos`, passed in rather than
 * read here, so that one caller's `storedMarks ?? $pos.marks()` decides both this boundary's
 * ownership (task 1.53) and {@link isLeafEnd}'s block-end rule. `null` at a block's start, at its
 * end, and everywhere that is not a textblock position.
 */
interface InlineBoundary {
  readonly before: PMNode;
  readonly after: PMNode;
  readonly marks: readonly Mark[];
}

function inlineBoundary(
  doc: PMNode,
  pos: number,
  marks: readonly Mark[] | null,
): InlineBoundary | null {
  if (marks === null) return null;
  const $pos = doc.resolve(pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  if (before === null || after === null) return null;
  return { before, after, marks };
}

/**
 * The innermost correspondence covering `pos`, or `null`.
 *
 * A boundary between two inline nodes of an entered block — one node's `pmEnd` and the next
 * node's `pmStart`, one ProseMirror position whichever side the source caret takes — belongs to
 * the node whose ProseMirror marks are the marks a character typed there receives, which is
 * `doc.resolve(pos).marks()` ({@link InlineBoundary}; the rule is prosemirror-model's own and is
 * never restated here as a list of mark types): the *earlier* node when the marks at the boundary
 * equal the node before's, so that a caret at the end of an inclusive run (`~~beta.~~`, the
 * default `inclusive`) goes inside the closing delimiter, where a letter extends the run as it
 * does in the rendered view, and a caret after unmarked text before a run (`Alpha |~~beta.~~`)
 * stays before the opening delimiter; the *later* node otherwise — after a `link`, whose spec
 * says `inclusive: false`, the marks at the boundary are the plain neighbour's, and the caret
 * leaves the link. Among the nodes ending at a boundary (a mark and its last child) the innermost
 * wins, as it does among those starting there; `entries` is in pre-order, so it comes last.
 * Everywhere else — inside a node, at a block's start (no node before) and at a block's end (no
 * node after; task 1.52's rule for a trailing leaf) — the last entry covering `pos` is the answer,
 * as before (DECISIONS #review-1-r6 L6, task 1.53).
 */
function innermostAt(
  entries: readonly Correspondence[],
  pos: number,
  boundary: InlineBoundary | null,
): Correspondence | null {
  let best: Correspondence | null = null;
  let ending: Correspondence | null = null;
  for (const entry of entries) {
    if (entry.pmStart <= pos && pos <= entry.pmEnd) best = entry;
    if (entry.pmStart < pos && entry.pmEnd === pos) ending = entry;
  }
  if (boundary === null || best === null || ending === null || best.pmStart !== pos) return best;
  return Mark.sameSet(boundary.marks, boundary.before.marks) ? ending : best;
}

/**
 * The end of the last node that ends at or before `pos`, or `null` when no node does. Only the
 * entries starting after `from` are candidates, so a caller can keep the search inside one
 * block's descendants (they are exactly the entries that start after it and end at or before a
 * position it covers). Among nodes ending at the same position — a mark and its last child, the
 * only nodes whose ProseMirror extents coincide — the innermost wins (`entries` is in pre-order,
 * so it comes last): the text's end is before the mark's closing delimiter, where the spelling
 * table puts a cursor at the end of the run, since inside and outside a mark are one ProseMirror
 * position.
 */
function lastNodeEnd(
  entries: readonly Correspondence[],
  map: PositionMap,
  pos: number,
  from = -1,
): SourcePosition | null {
  let best: NodeRange | null = null;
  let bestEnd = -1;
  for (const entry of entries) {
    const range = map.ranges[entry.path];
    if (range === undefined || entry.pmStart <= from || entry.pmEnd > pos || entry.pmEnd < bestEnd)
      continue;
    best = range;
    bestEnd = entry.pmEnd;
  }
  return best === null ? null : { line: best.endLine, ch: best.endCol - 1 };
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
  return lastNodeEnd(entries, map, pos) ?? { line: 1, ch: 0 };
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
  /**
   * The place in `format(root)` that ProseMirror position `pos` names. `storedMarks` is the live
   * editor's `EditorState.storedMarks` when the caller has one: the marks a character typed at
   * `pos` would receive are `storedMarks ?? doc.resolve(pos).marks()` ({@link typedMarks}), and
   * they decide which of two nodes meeting at `pos` owns it (task 1.53) and whether the caret at
   * the end of a block-final `inlineCode` run is inside the span or after its closing fence
   * ({@link isLeafEnd}). Omitted — the document alone — the answer is the resolved marks', which
   * is what a caret placed by a click or an arrow key takes.
   *
   * At a block's **start** and at its **end** — the two positions with no inline node on one
   * side, so no boundary and no later node — those same marks decide how far out of the marks
   * enclosing the innermost leaf the source caret sits: outside every enclosing mark they do not
   * carry and inside every one they do, from the innermost outward, stopping at the first
   * carried mark ({@link markEdgePoint}, {@link blockEdge}; DECISIONS #review-1-r8 N1). They are
   * `Transaction.insertText`'s own `storedMarks ?? $from.marks()`, prosemirror-state 1.4.4,
   * `dist/index.js` 627–644.
   */
  toSource(pos: number, storedMarks?: readonly Mark[] | null): SourcePosition;
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
 * serialisation once. The mapping has three clauses, innermost node first:
 *
 * 1. Inside a `text` node the offset is carried across through that node's spelling table, so an
 *    escaped character (`\*`) and a continuation prefix (`> `, a list item's indentation) are
 *    counted as the serializer wrote them and not as one character each.
 * 2. Inside a block that {@link walkBlock} *entered* (a paragraph, heading or cell whose phrasing
 *    children were walked; a container whose blocks were) but past every child it knows, the
 *    position goes after the last of the block's own descendants ending at or before it
 *    ({@link lastNodeEnd} from the block's start). The editor's block can be wider than the
 *    mdast one — a `hard_break` left last by a deletion is dropped by the conversion, and the
 *    empty paragraph a split opens in a list item is a placeholder no correspondence covers —
 *    and the bytes put that cursor at the end of what precedes it, never at the block's first
 *    column. A block with nothing of its own before the position (a cell the deletion emptied)
 *    falls through to clause 3, and a zero-width cell's start is its end.
 * 3. Every other node is answered with its own start — an inline atom (`image`, `break`, inline
 *    `html`) when it is the innermost node, and a leaf block (`code`, `thematicBreak`, `html`)
 *    that is placed but never entered, because the map places nodes and only a text node's bytes
 *    are its text — with one exception each way. An atom is the innermost node at its own `pmEnd`
 *    when nothing follows it in its block, or when the marks at the boundary after it are its own
 *    ({@link innermostAt}), and that position is the caret *after* the atom: it is answered with
 *    the atom's end, so a block ending in an image or an inline tag round-trips at its end as a
 *    block ending in text does, and an `inlineCode` run at its block's end the same, after its
 *    closing fence ({@link isLeafEnd}; task 1.52, DECISIONS #030 Decision 2). Which node a
 *    boundary between two inline nodes belongs to is decided in {@link innermostAt} by the marks
 *    a typed character takes there, `storedMarks ?? doc.resolve(pos).marks()` ({@link typedMarks};
 *    task 1.53). Those same marks decide the caret at the end of a block-final `inlineCode` run,
 *    which has no boundary after it: the `inline_code` mark sets no `inclusive`, so the editor's
 *    default holds and a character typed there joins the span whenever the typed marks carry the
 *    mark — then the caret is inside, before the closing fence, where the spelling table puts it;
 *    only when they do not (an input rule's `removeStoredMark` cleared it a keystroke earlier) is
 *    it after the fence, as an atom's end always is. And on the
 *    delimiters of a mark
 *    {@link delimiterPosition} tells the opening one from the closing one; on a container's own
 *    columns {@link containerEnd} tells a block's end from the container's start.
 */
export function cursorMap(root: Root, doc: PMNode): CursorMap {
  const { map, spellings, lineStarts } = formatWithMap(root);
  const { entries, blocks } = correspondences(root, doc);
  return {
    toSource(rendered, storedMarks = null) {
      const block = blockAt(blocks, rendered);
      const pos = block === null ? rendered : settled(block, rendered);
      const marks = typedMarks(doc, pos, storedMarks);
      const boundary = inlineBoundary(doc, pos, marks);
      if (block !== null && marks !== null && beyondDroppedWhitespace(block, doc, pos, marks)) {
        const enclosing = enclosingBlock(entries, pos);
        const between = enclosing === null ? null : betweenNodes(entries, map, enclosing, pos);
        if (between !== null) return between;
      }
      const inside = innermostAt(entries, pos, boundary);
      if (inside !== null) {
        const range = map.ranges[inside.path];
        const table = spellings[inside.path];
        const edge = blockEdge(doc, pos, marks, block);
        if (edge !== null) {
          const outside = markEdgePoint(entries, map, inside, pos, marks ?? [], edge);
          if (outside !== null) return outside;
        }
        if (range !== undefined && isLeafEnd(inside, pos, boundary, table !== undefined, marks)) {
          return { line: range.endLine, ch: range.endCol - 1 };
        }
        if (table !== undefined) {
          const { line, column } = spellingPoint(lineStarts, table, leafOffset(inside, pos));
          return { line, ch: column - 1 };
        }
        if (isEntered(inside.node)) {
          const before = lastNodeEnd(entries, map, pos, inside.pmStart);
          if (before !== null) return before;
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
            return leafPosition(
              entry,
              spellingIndex(lineStarts, table, position.line, position.ch + 1),
            );
          }
          return delimiterPosition(entries, entry, found, map, position);
        }
      }
      return afterLastLine(entries, map, position);
    },
  };
}

/**
 * Whether `pos` is the caret *after* the inline leaf `entry` — an atom (`image`, `break`, inline
 * `html`) or an `inlineCode` run, found innermost at its own `pmEnd` — and answered with the
 * leaf's last byte: after `)`, after `</i>`, after the closing backtick fence.
 *
 * The rule is one rule on both sides, and it is the marks a character typed at `pos` receives,
 * `storedMarks ?? $pos.marks()` ({@link typedMarks}, passed in as `marks`): a leaf *with* a
 * spelling table (`inlineCode`) is answered by that table — the run's last offset, before the
 * closing fence, where a typed character joins the run as it does in the rendered view —
 * whenever those marks carry `schema.marks.inline_code`, and is answered after the fence
 * whenever they do not. A leaf *without* a table (an atom) has no inside to type into and is
 * answered with its end either way.
 *
 * At a boundary (`boundary` not `null`) the leaf is innermost only when {@link innermostAt} gave
 * it the boundary, which is the same test made of the same marks, so the table decides there and
 * an atom's end is the later node's start anyway — the two clauses of the previous sentence,
 * with `marks` already spent. At a block's end there is no boundary and no later node, and the
 * marks are all there is: `inline_code` sets no `inclusive` (`schema.ts`), so the editor's
 * default keeps it on and the resolved marks at a block-final run's end are the run's — the
 * caret is inside it, task 1.52's "after the fence" holding only for an atom, or for a run whose
 * stored marks the editor cleared (an input rule's `removeStoredMark`, one keystroke earlier),
 * which is what a `null`-free `storedMarks` argument carries in (DECISIONS #review-1-r7 M5, the
 * last tuple of L6). A `text` node's end is its table's end already, and every other position a
 * leaf covers (its start; a run's interior) is placed as before.
 */
function isLeafEnd(
  entry: Correspondence,
  pos: number,
  boundary: InlineBoundary | null,
  hasTable: boolean,
  marks: readonly Mark[] | null,
): boolean {
  if (entry.node.type === "text" || isEntered(entry.node) || pos !== entry.pmEnd) return false;
  if (!hasTable) return true;
  if (boundary !== null) return false;
  return !(marks ?? []).some((mark) => mark.type === schema.marks.inline_code);
}

/**
 * Which edge of a textblock `pos` is, when it is one: `"start"` when nothing the conversion kept
 * is before it, `"end"` when nothing it kept is after it, `null` everywhere else — inside the
 * block (kept content on each side, which is {@link inlineBoundary}'s case), in an empty block
 * (neither side has any, so there is no enclosing mark to be inside or outside of), and at every
 * position that is not a textblock position at all (`marks` is `null` there).
 *
 * The edge is read in **kept** content, not in the editor's nodes: a block whose trailing
 * whitespace the conversion dropped has an editor node after its last kept character and no bytes
 * after it, and the caret there is at the block's end in the only document the source view shows
 * (a space typed after a link at a block's end: `[bc](u) ` is `[bc](u)`, and the caret belongs
 * after `)`, which is the block-edge rule of DECISIONS #review-1-r8 N1). With nothing dropped the
 * two readings are the same test — the offset is positive exactly where a node precedes the
 * position — so a document the conversion keeps whole is answered as before.
 */
function blockEdge(
  doc: PMNode,
  pos: number,
  marks: readonly Mark[] | null,
  block: InlineBlock | null,
): "start" | "end" | null {
  if (marks === null) return null;
  const $pos = doc.resolve(pos);
  const offset = block === null ? -1 : block.chars.offsetOf(pos - block.contentStart);
  const before = block === null ? $pos.nodeBefore !== null : offset > 0;
  const after = block === null ? $pos.nodeAfter !== null : offset < block.chars.width;
  if (before && !after) return "end";
  if (!before && after) return "start";
  return null;
}

/** The mark entries enclosing `inside` that cover `pos`, innermost first (`entries` is pre-order). */
function enclosingMarks(
  entries: readonly Correspondence[],
  inside: Correspondence,
  pos: number,
): Correspondence[] {
  const out: Correspondence[] = [];
  for (const entry of entries) {
    if (!isMark(entry.node.type)) continue;
    if (!inside.path.startsWith(`${entry.path}.`)) continue;
    if (entry.pmStart > pos || entry.pmEnd < pos) continue;
    out.push(entry);
  }
  return out.reverse();
}

/**
 * **The block-edge rule (DECISIONS #review-1-r8 N1).** At a block's edge the source caret is
 * *outside* every enclosing mark the typed marks do not carry and *inside* every one they do,
 * taken from the innermost mark outward and stopping at the first mark the typed marks carry;
 * this answers the range of the outermost mark of that leading uncarried run — its end at the
 * block's `"end"` edge (past `*`, `~~`, a link's `](url)`), its start at the block's `"start"`
 * edge (before `*`, before `[`) — and `null` when the innermost enclosing mark is carried, or
 * when there is no enclosing mark, which leaves every other position exactly as it was.
 *
 * **Why both edges and no other position.** Inside a block a position has an inline node on each
 * side and {@link innermostAt} already decides which of the two owns it from the same marks
 * (task 1.53). At an edge one side is empty, so no boundary exists, {@link isLeafEnd} is `false`
 * for a `text` leaf, and the answer was the innermost text's own spelling-table end — inside
 * every enclosing delimiter, whatever the typed marks say. The marks are the only thing left to
 * read, and they are `storedMarks ?? $pos.marks()` ({@link typedMarks}), the expression
 * `Transaction.insertText` gives an inserted character, read in prosemirror-state 1.4.4,
 * `dist/index.js` 627–644 (the `insertText` path for the empty range a keystroke replaces; the
 * `replaceSelectionWith` twin at 609–615 is the same two in the same order). Both routes to a
 * caret are covered by that one expression: an input rule's `removeStoredMark` leaves stored
 * marks `[]`, so the character after `see *foo*` is plain and the caret belongs after the `*`,
 * while a click leaves `storedMarks` `null` and `$pos.marks()` keeps every inclusive mark the
 * text carries, so the caret stays inside — and drops a `link`, whose spec says
 * `inclusive: false` (`schema.ts`), on *both* routes, which is why a block that begins or ends
 * in a link leaves it on either side.
 *
 * **The nesting order.** The marks of a nested run are a set, and the delimiters are not: a
 * caret cannot be outside `**` and inside `*` at once, so the walk stops at the first carried
 * mark rather than skipping it. `*foo **bar**` at its end with stored marks `[emphasis]` is
 * after `**` and before `*` — `*foo **bar**X*` — and with stored marks `[]` it is past both.
 * The schema's mark names are the mdast node types (`emphasis`, `strong`, `delete`, `link`), so
 * a mark entry is carried exactly when some typed mark has its `type.name`.
 *
 * An inline leaf's own rule — an atom's end, an `inlineCode` run's fence ({@link isLeafEnd},
 * tasks 1.52 and 1.60) — is unchanged and decides the leaf; this rule only says how far out of
 * the marks *around* that leaf the caret then sits, and does not fire at all when the innermost
 * enclosing mark is one the typed marks carry.
 */
function markEdgePoint(
  entries: readonly Correspondence[],
  map: PositionMap,
  inside: Correspondence,
  pos: number,
  marks: readonly Mark[],
  edge: "start" | "end",
): SourcePosition | null {
  const carried = new Set(marks.map((mark) => mark.type.name));
  let outermost: Correspondence | null = null;
  for (const entry of enclosingMarks(entries, inside, pos)) {
    if (carried.has(entry.node.type)) break;
    outermost = entry;
  }
  if (outermost === null) return null;
  const range = map.ranges[outermost.path];
  if (range === undefined) return null;
  return edge === "end"
    ? { line: range.endLine, ch: range.endCol - 1 }
    : { line: range.startLine, ch: range.startCol - 1 };
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
 *
 * `nodeAt` answers with a container (`tableRow`, `table`, `listItem`, `list`, `blockquote`, or a
 * cell whose children stop short of its range) when the position is on a column the container's
 * own bytes occupy and no descendant's range covers — a cell's padding and pipes, an item's
 * marker, and the column right after a block's last character, which the block's half-open range
 * excludes while the container's does not. Those are {@link containerEnd}'s: at or past a
 * descendant block's end on that line, the answer is that block's end. Every other node — a leaf
 * block, an atom — answers with its own start, as before.
 */
function delimiterPosition(
  entries: readonly Correspondence[],
  entry: Correspondence,
  found: PositionEntry,
  map: PositionMap,
  position: SourcePosition,
): number {
  if (!isMark(found.node.type)) {
    return isEntered(found.node)
      ? (containerEnd(entries, found.path, map, position) ?? entry.pmStart)
      : entry.pmStart;
  }
  const children = "children" in found.node ? found.node.children : [];
  const last = map.ranges[childPath(found.path, children.length - 1)];
  if (last === undefined) return entry.pmStart;
  const column = position.ch + 1;
  const after =
    position.line > last.endLine || (position.line === last.endLine && column >= last.endCol);
  return after ? entry.pmEnd : entry.pmStart;
}

/**
 * The ProseMirror position for a place on a container's own columns (see
 * {@link delimiterPosition}): the end of the innermost entered block among the container's
 * descendants (the container itself included) whose range ends on `position`'s line at or before
 * it, or `null` when no block ends on that line before the position (a table's delimiter row,
 * an item's marker before its first character), which leaves the caller's old answer.
 *
 * The ownership rule for the columns between a block's last character and the next block's
 * first — a cell's closing padding and pipe, the space and pipe before the next cell, a line's
 * end inside a list item — is stated once, here: the container owns those bytes (they are its
 * delimiters and padding, not any block's text), but the *position* at or past a block's end on
 * the block's own line belongs to that block, exactly as {@link afterLastLine}'s same-line rule
 * gives a top-level paragraph's trailing columns to the paragraph. Ties (a cell and its last text
 * both end at the cell's `endCol`; an item and its last paragraph at the item's last line) go to
 * the innermost block, which comes last in pre-order, and the block's end is the end of its
 * content: its last descendant's `pmEnd`, or, for a block with no descendants (an empty cell,
 * whose zero-width range `nodeAt` never answers), the one position inside it, its own `pmEnd`
 * less the closing token — never its `pmStart`, the row's first column of DECISIONS
 * #review-1-r6 L5 (task 1.52).
 */
function containerEnd(
  entries: readonly Correspondence[],
  containerPath: string,
  map: PositionMap,
  position: SourcePosition,
): number | null {
  const column = position.ch + 1;
  const prefix = `${containerPath}.`;
  let block: Correspondence | null = null;
  let blockCol = 0;
  for (const entry of entries) {
    if (entry.path !== containerPath && !entry.path.startsWith(prefix)) continue;
    if (!isEntered(entry.node)) continue;
    const range = map.ranges[entry.path];
    if (range === undefined || range.endLine !== position.line || range.endCol > column) continue;
    if (range.endCol >= blockCol) {
      block = entry;
      blockCol = range.endCol;
    }
  }
  if (block === null) return null;
  const blockPrefix = `${block.path}.`;
  let last: Correspondence | null = null;
  for (const entry of entries) {
    if (entry.path.startsWith(blockPrefix)) last = entry;
  }
  return last === null ? block.pmEnd - 1 : last.pmEnd;
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
 * {@link SourceBinding.flush} for a toggle, for Copy Markdown (DECISIONS #review-1-r1 G1) and for
 * an Undo or a Redo from the source view (G2; `store.ts`'s `beforeHistory`),
 * {@link SourceBinding.destroy} for an unmount. A pull goes the other way — an undo, a redo, a
 * loaded fixture supersede what was typed, so the pending commit is dropped rather than written
 * over the snapshot that has just arrived. A history command is both at once, which is why it
 * flushes *before* it moves history: the burst becomes the entry the Undo then steps back over,
 * rather than being dropped by the pull the Undo causes.
 *
 * **The grouping rule, once (DECISIONS #review-1-r1 G2; #review-1-r2 H2).** Continuity is a
 * property of *adjacent keystrokes*: two keystrokes belong to one undo step when they are no more
 * than a window apart, so the chain of keystrokes that becomes one undo entry is the chain in
 * which every adjacent gap is inside the window — the chain that became one coalesced entry
 * before task 1.17 deferred the commit — whether the commits along it are fired by the timer or
 * by a flush, and however many commits the chain is cut into. A pending segment therefore carries
 * **both** its own keystroke times: the first (recorded when the segment opens) and the latest
 * (recorded on every {@link SourceBinding.change}), never the moment the commit ran. The commit
 * hands them to `push` as `from` and `at`: the segment is continuous with the previous entry when
 * its *first* keystroke is within the window of that entry's *last*, however long the segment runs,
 * and the entry then keeps the segment's last keystroke for the next comparison. Two ways of
 * getting this wrong, both seen: stamping `now()` at commit time (task 1.17's own lesson — a flush
 * a quarter-second after the previous commit merged a burst the user began 1.2 s later into the
 * previous entry, and a flush partway through a burst followed by more typing inside the window
 * opened a second entry for one burst), and carrying only the segment's *latest* keystroke (H2 —
 * a flush inside a burst whose continuation outlasted one window compared the previous entry's
 * last keystroke with the continuation's last keystroke, 1.3 s apart, and split one burst into
 * two steps although no adjacent gap was over 314 ms). Explicit closure is untouched by any of
 * this: a toggle's `endCoalescing` and a history command's `beforeHistory` flush still end the
 * group, so the edit after either is its own step.
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
  /**
   * When the pending segment's first keystroke landed and when its latest did — the `from` and the
   * `at` its commit carries, per the grouping rule above. Meaningless while `pending` is `null`,
   * and read only beside it.
   */
  let pendingFrom = 0;
  let pendingAt = 0;
  let cancel: (() => void) | null = null;

  /** Forget the pending text and unschedule its commit. */
  const drop = (): void => {
    pending = null;
    if (cancel !== null) cancel();
    cancel = null;
  };

  const commitPending = (): void => {
    const text = pending;
    const from = pendingFrom;
    const at = pendingAt;
    drop();
    if (text === null) return;
    const { document, commit } = store.getState();
    const root = parse(text);
    shown = root;
    shownText = text;
    commit(root, document.sidecar, { coalesceKey, at, from });
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
      // The keystrokes' own times, not the commit's: see the grouping rule in the module comment.
      // The first keystroke opens the segment and is what continuity is decided from; the latest
      // is what the entry keeps.
      const at = now();
      if (pending === null) pendingFrom = at;
      pending = text;
      pendingAt = at;
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
