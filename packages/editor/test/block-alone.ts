import { expect } from "vitest";
import type { Root } from "mdast";
import { format } from "@essaydown/core";
import type { Node as PMNode } from "prosemirror-model";
import { pmToMdast } from "../src/schema.js";
import { cursorMap, type CursorMap } from "../src/toggle.js";

/**
 * One textblock alone, as its own document, with the three things the byte oracle needs from it.
 *
 * `doc.cut($block.before(), $block.after())` keeps the block's containers as **open ancestors** —
 * a list item's paragraph cuts to `list > list_item > paragraph`, a cell's to
 * `table > table_row > table_cell` — so the block is converted, formatted and mapped inside the
 * tree it actually lives in, and only the rest of the document is gone.
 *
 * Why the oracle is the block and not the whole document: one byte comparison costs a
 * `format ∘ parse` of everything it is given, so a whole-document comparison at every caret
 * position of the corpus's long-form fixture is 53 s on an idle container against the 30_000 ms
 * budget every test of this family keeps (lesson [1.64]). A correspondence is block-local — every
 * branch this task changes reads one textblock's own children — so the block alone answers the
 * same question at a hundredth of the cost, and **no position is left out**: the leg sweeps every
 * one of them. The whole-document map is not thereby untested here; it carries the inverse and
 * the settling rule at every position as the two legs above do, and the caller bridges the two by
 * asserting that the whole document's column at each position is the block's own column shifted
 * by a constant per line of the block (the container's prefix — `> `, a list marker, a cell's
 * pipes and padding), which is the statement that the block-local bytes are the document's bytes.
 */
export interface BlockAlone {
  doc: PMNode;
  /** The bytes of the block alone — what a source keystroke in it edits. */
  text: string;
  map: CursorMap;
  /** Added to a position of the whole document to reach the same position of `doc`. */
  offset: number;
}

export function blockAlone(doc: PMNode, pos: number, node: PMNode): BlockAlone {
  const cut = doc.cut(pos, pos + node.nodeSize);
  let start = -1;
  cut.descendants((child, at) => {
    if (start >= 0) return false;
    if (!child.isTextblock) return true;
    start = at + 1;
    return false;
  });
  expect(start, "the cut holds the block it was cut around").toBeGreaterThan(0);
  const root: Root = pmToMdast({ doc: cut, frontMatter: null });
  return { doc: cut, text: format(root), map: cursorMap(root, cut), offset: start - (pos + 1) };
}
