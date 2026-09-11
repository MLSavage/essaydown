import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { expect } from "vitest";
import { schema } from "../src/schema.js";

/**
 * The keystroke-shaped transactions the editor-seeded round-trip legs share: three that type, and
 * one that deletes.
 *
 * Task 1.13 wrote the block-end space and task 1.25 the in-block letter, both inside
 * `editor-fixed-point.test.ts`. Task 1.27 (DECISIONS #review-1-r1 G6) adds a third leg — the
 * position map over the same editor output — and the promoted rule asks every family's leg to be
 * seeded from *the writing surface's own output*, which only holds if all of them type the same
 * thing. So the transactions live here and are imported by both suites rather than copied into
 * the second one, where a later fix to one would silently leave the other typing something else.
 * Task 1.29 (DECISIONS #review-1-r2 H1) adds the deletion, {@link deleteAtEveryBlockEnd}, beside
 * them: the trees a parser cannot produce are usually reached by taking something away. Task 1.30
 * (DECISIONS #review-1-r2 H8) adds {@link typeSpaceInsideEveryMarkedRun}: a space typed with the
 * caret inside a mark, at the end of an emphasised word, the one-keystroke route to the mark edge.
 */

/** {@link typeSpaceAtEveryBlockEnd}'s result: the changed document, and how many blocks it typed in. */
export interface BlockEndLeg {
  doc: PMNode;
  blocks: number;
}

/**
 * {@link typeInsideEveryBlock}'s result: the changed document, how many letters it typed, and the
 * position each of them occupies in that document (ascending), for a caller that has to ask where
 * a typed character went.
 */
export interface InsideBlockLeg {
  doc: PMNode;
  typed: number;
  positions: number[];
}

/**
 * A ProseMirror transaction shaped like typing: a space appended at the end of every paragraph and
 * every heading, applied back-to-front so that each insertion leaves the positions still to come
 * unmoved. `insertText` is the same call `typing.ts` makes for a typed character.
 */
export function typeSpaceAtEveryBlockEnd(doc: PMNode): BlockEndLeg {
  const ends: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.paragraph || node.type === schema.nodes.heading) {
      ends.push(pos + 1 + node.content.size);
    }
    return true;
  });
  let tr = EditorState.create({ doc }).tr;
  for (const pos of [...ends].reverse()) tr = tr.insertText(" ", pos);
  return { doc: tr.doc, blocks: ends.length };
}

/**
 * The letters the inside-a-block leg types. One is picked per fixture: the first that does not
 * occur in that fixture's canonical Markdown, so that "differs by exactly the inserted letters"
 * can be asserted by deleting every occurrence of it from the output and comparing. The list ends
 * in two non-ASCII letters for the fixtures (the essay) that use the whole Latin alphabet.
 */
export const TYPED_LETTERS = ["Q", "Z", "X", "J", "K", "V", "W", "Y", "Ж", "Ω"];

export function letterFor(canonical: string): string {
  const letter = TYPED_LETTERS.find((candidate) => !canonical.includes(candidate));
  expect(letter, "no candidate letter is absent from this fixture's canonical form").toBeDefined();
  return letter as string;
}

/** The three node types whose content is inline text; the only places a soft break can live. */
const INLINE_CONTENT = new Set([
  schema.nodes.paragraph,
  schema.nodes.heading,
  schema.nodes.table_cell,
]);

/**
 * A ProseMirror transaction shaped like typing *inside* a block, which is the shape task 1.25
 * repairs: one letter after the first character of every paragraph's first text run, and one at
 * the start of the second line of every text run that holds a soft line break. `insertText` is the
 * same call `typing.ts` makes for a typed character, and the insertions are applied back-to-front
 * so each one leaves the positions still to come unmoved.
 */
export function typeInsideEveryBlock(doc: PMNode, letter: string): InsideBlockLeg {
  const at: number[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type === schema.nodes.code_block || node.type === schema.nodes.raw) return false;
    if (node.type === schema.nodes.paragraph) {
      let first: number | null = null;
      node.descendants((child, childPos) => {
        if (first !== null) return false;
        if (child.isText) first = pos + 1 + childPos;
        return true;
      });
      // After the first character of the run, never before it: the position before it is the
      // block start, which the other leg already types at.
      if (first !== null) at.push((first as number) + 1);
    }
    if (node.isText && parent !== null && INLINE_CONTENT.has(parent.type)) {
      const text = node.text as string;
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1))
        at.push(pos + i + 1);
    }
    return true;
  });
  const ascending = [...at].sort((a, b) => a - b);
  let tr = EditorState.create({ doc }).tr;
  for (const pos of [...ascending].reverse()) tr = tr.insertText(letter, pos);
  // Where each letter ended up. The insertions run back-to-front, so the letter typed at the
  // `n`-th smallest position (0-based) is pushed right by the `n` insertions made before it and
  // by nothing else: it occupies `[at + n, at + n + 1)` of the document this returns.
  return {
    doc: tr.doc,
    typed: ascending.length,
    positions: ascending.map((pos, index) => pos + index),
  };
}

/**
 * {@link deleteAtEveryBlockEnd}'s result: the changed document, how many continuations after a
 * hard break it deleted, and how many last characters of a block's last text run it deleted.
 */
export interface DeletionLeg {
  doc: PMNode;
  afterBreaks: number;
  lastChars: number;
}

/**
 * A ProseMirror transaction shaped like *deleting* — the shape task 1.29 repairs (DECISIONS
 * #review-1-r2 H1, Claude's lesson 2): a corpus leg seeded only from `insertText` can never reach
 * a tree that needs a deletion to build, and a paragraph ending in a hard break, three Backspace
 * presses from `hard-break.md`, was outside all eleven boundary guards and both typing legs.
 * `tr.delete` is the call a Backspace makes.
 *
 * Two deletions, applied in that order inside one transaction, each back-to-front so that every
 * range still to come is unmoved:
 *
 * 1. After every `hard_break` in a paragraph, heading or table cell, the inline content up to the
 *    next hard break or the block's end is deleted, so that every break becomes its block's last
 *    node (two breaks in a row become a block ending in two breaks, the case the strip's "until"
 *    is for).
 * 2. In the document that leaves, the last character of every such block's last text run —
 *    whatever its marks, so an inline-code run is deleted from too — so that a one-character run
 *    empties and the block's end lands on whatever precedes it: an atom, an inline-code run, a
 *    break, or nothing.
 *
 * The deletion counts are per range actually deleted (a break already last in its block has no
 * continuation to delete and counts nothing), so a caller can say which fixtures each deletion
 * reached.
 */
export function deleteAtEveryBlockEnd(doc: PMNode): DeletionLeg {
  const continuations: [number, number][] = [];
  doc.descendants((node, pos) => {
    if (!INLINE_CONTENT.has(node.type)) return true;
    const start = pos + 1;
    let from: number | null = null;
    node.forEach((child, offset) => {
      if (child.type !== schema.nodes.hard_break) return;
      if (from !== null && from < start + offset) continuations.push([from, start + offset]);
      from = start + offset + child.nodeSize;
    });
    if (from !== null && from < start + node.content.size)
      continuations.push([from, start + node.content.size]);
    return false;
  });
  let tr = EditorState.create({ doc }).tr;
  for (const [from, to] of [...continuations].reverse()) tr = tr.delete(from, to);

  // One *character* is one code point, as a Backspace deletes it: `[from, to)` spans the last
  // code point of the run, two positions wide when it is an astral one.
  const lastChars: [number, number][] = [];
  tr.doc.descendants((node, pos) => {
    if (!INLINE_CONTENT.has(node.type)) return true;
    let range: [number, number] | null = null;
    node.forEach((child, offset) => {
      if (!child.isText) return;
      const end = pos + 1 + offset + child.nodeSize;
      const last = [...(child.text as string)].pop() as string;
      range = [end - last.length, end];
    });
    if (range !== null) lastChars.push(range);
    return false;
  });
  for (const [from, to] of [...lastChars].reverse()) tr = tr.delete(from, to);
  return { doc: tr.doc, afterBreaks: continuations.length, lastChars: lastChars.length };
}

/**
 * {@link typeSpaceInsideEveryMarkedRun}'s result: the changed document and how many marked text
 * nodes it typed a space at the end of.
 */
export interface MarkEdgeLeg {
  doc: PMNode;
  runs: number;
}

/** The marks whose delimiters must flank their content: the ones the mark-edge clause is for. */
const FLANKING_MARKS = [schema.marks.emphasis, schema.marks.strong, schema.marks.delete];

/**
 * A ProseMirror transaction shaped like typing a space with the caret *inside a mark* — the shape
 * task 1.30 repairs (DECISIONS #review-1-r2 H8, Sol's reproduction: `a *b* c`, the caret after
 * `b`, one space): at the end of every text node carrying `emphasis`, `strong` or `delete`, in a
 * paragraph, heading or table cell, one space is inserted by `insertText`, the same call
 * `typing.ts` makes for a typed character. At the end of a text node `insertText` gives the new
 * text that node's marks (all three flanking marks are inclusive, so a caret there sits inside
 * them), which is why the space lands inside the mark and not after it. The insertions are
 * applied back-to-front so that each one leaves the positions still to come unmoved.
 */
export function typeSpaceInsideEveryMarkedRun(doc: PMNode): MarkEdgeLeg {
  const ends: number[] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText || parent === null || !INLINE_CONTENT.has(parent.type)) return true;
    if (FLANKING_MARKS.some((mark) => mark.isInSet(node.marks) !== undefined))
      ends.push(pos + node.nodeSize);
    return true;
  });
  let tr = EditorState.create({ doc }).tr;
  for (const pos of [...ends].reverse()) tr = tr.insertText(" ", pos);
  return { doc: tr.doc, runs: ends.length };
}
