import type { Node as PMNode } from "prosemirror-model";

/**
 * Where a ProseMirror position sits in document terms (Rewrite mode, task 3.4): the index of the
 * top-level block of the editable doc that contains it, and — when that block is a paragraph — the
 * offset into the paragraph's plain text as `core`'s `paragraphText` counts it, which is what
 * sentence ranges index.
 *
 * The doc's top-level children are the mdast root's children minus the `yaml` front matter
 * (`mdastToPM`), so the caller adds one to `block` when the root has front matter.
 */
export interface CursorBlock {
  readonly block: number;
  /** Plain-text offset of the position in its top-level paragraph; null for any other block. */
  readonly offset: number | null;
}

/**
 * The plain text an inline leaf stands for, as `paragraphText` reads its mdast twin: an image's
 * alt, inline html's raw value, a hard break's single space.
 */
function leafText(leaf: PMNode): string {
  if (leaf.type.name === "image") return (leaf.attrs.alt as string | null) ?? "";
  if (leaf.type.name === "raw_inline") return leaf.attrs.value as string;
  return " ";
}

/** {@link CursorBlock} of `position` in `doc`, or null when the position is outside the doc. */
export function cursorBlock(doc: PMNode, position: number): CursorBlock | null {
  if (!Number.isInteger(position) || position < 0 || position > doc.content.size) return null;
  const $pos = doc.resolve(position);
  const block = Math.min($pos.index(0), doc.childCount - 1);
  if ($pos.depth !== 1 || $pos.parent.type.name !== "paragraph") return { block, offset: null };
  return { block, offset: $pos.parent.textBetween(0, $pos.parentOffset, "", leafText).length };
}
