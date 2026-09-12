import type { Mark as PMMark, Node as PMNode } from "prosemirror-model";
import { Fragment, Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
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
 * Task 1.34 (DECISIONS #review-1-r3 I1) adds the deletion leg's second range set,
 * {@link deleteToEveryMarkedRunEnd}: the first set deletes to the *block's* end after every break,
 * so the break was always the block's last node and never a run's last node with text after it.
 * Task 1.35 (DECISIONS #review-1-r3 I3/I4) adds {@link typeSpaceAtEveryLinkEnd}, the **link
 * edge**: a space typed at the end of every link's text, inside the link, so that the link's edge
 * whitespace meets whatever boundary the link's own edge is at — a flanking mark's, the block's,
 * or none. Task 1.36 (DECISIONS #review-1-r3 I2) adds the first **block-level** transactions,
 * {@link splitEveryListItemParagraph} and {@link pasteIntoEveryListItemParagraph}: every inline
 * leg above leaves the block tree as the parser built it, so a parsed block attribute that
 * outlives the structure it described (`listItem.spread` after a paste adds a paragraph) was
 * outside all of them.
 *
 * Task 1.41 (DECISIONS #review-1-r4 J1) adds **the mark's neighbour**,
 * {@link deleteBesideEveryMarkedRun} and {@link punctuateThenDeleteAfterEveryMarkedRun}: every leg
 * above types or deletes *inside* a run or *at* a block's end, so a Backspace over the unmarked
 * whitespace *between* a flanking-marked run and its neighbour — the one-keystroke route both r4
 * reviewers found (`~~beta.~~` then a space, `~~…](essay.md)~~` then a space) — was outside all of
 * them, and 1.40's `delete` handler had no corpus leg reaching the tree it exists for.
 *
 * One character is one code point, throughout this file: a leg that types after or deletes "the
 * first character" or "the last character" of a run reads it with `[...text]`, never by UTF-16
 * length, so an astral character at that edge is typed after, or deleted, whole — never split
 * between its two surrogate units (task 1.47, DECISIONS #review-1-r5 K1's corpus half).
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
export const INLINE_CONTENT = new Set([
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
      let firstCharWidth = 1;
      node.descendants((child, childPos) => {
        if (first !== null) return false;
        if (child.isText) {
          first = pos + 1 + childPos;
          // One character is one code point: an astral first character is two positions wide.
          firstCharWidth = ([...(child.text as string)][0] as string).length;
        }
        return true;
      });
      // After the first character of the run, never before it: the position before it is the
      // block start, which the other leg already types at.
      if (first !== null) at.push((first as number) + firstCharWidth);
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

/**
 * {@link deleteToEveryMarkedRunEnd}'s result: the changed document, how many ranges it deleted
 * (one per hard break inside a flanking mark's run that had run content after it), and how many
 * of those ranges reached the block's end (so the break is then the block's last node, which the
 * block's-end clause drops, rather than the run's last node with text after it).
 */
export interface MarkedRunDeletionLeg {
  doc: PMNode;
  afterBreaksInRuns: number;
  toBlockEnd: number;
}

/**
 * The deletion leg's second range set (task 1.34, DECISIONS #review-1-r3 I1, Claude's route: one
 * Backspace inside an emphasised verse loaded from a file): for every `hard_break` carrying a
 * flanking mark, in a paragraph, heading or table cell, the inline content from the break's end to
 * the end of that *mark's run* — the maximal stretch of adjacent nodes carrying the mark, not the
 * block — is deleted, so the break becomes the run's last node with whatever followed the run
 * (unmarked text, another mark's run, nothing) still after it. Where the break carries more than
 * one flanking mark the shortest run's end is taken, so the break is last in at least one run and
 * the text after it keeps the marks whose runs go on. A break inside a range already taken (a
 * second break in the same run) is deleted with it and counts nothing; the ranges are therefore
 * disjoint and are applied back-to-front so that each leaves the ranges still to come unmoved.
 * `tr.delete` is the call a Backspace makes.
 *
 * This is a second *document*, not a third pass over {@link deleteAtEveryBlockEnd}'s: that leg's
 * first set deletes after every break to the block's end, which is this range widened past the
 * run's end, so the two shapes — the break last in its block, the break last in its run with text
 * after it — cannot both be built from one break.
 */
export function deleteToEveryMarkedRunEnd(doc: PMNode): MarkedRunDeletionLeg {
  const ranges: [number, number][] = [];
  let toBlockEnd = 0;
  doc.descendants((node, pos) => {
    if (!INLINE_CONTENT.has(node.type)) return true;
    const children: PMNode[] = [];
    const starts: number[] = [];
    node.forEach((child, offset) => {
      children.push(child);
      starts.push(pos + 1 + offset);
    });
    const blockEnd = pos + 1 + node.content.size;
    let coveredTo = -1;
    children.forEach((child, i) => {
      if (child.type !== schema.nodes.hard_break || starts[i] < coveredTo) return;
      const marks = FLANKING_MARKS.filter((mark) => mark.isInSet(child.marks) !== undefined);
      if (marks.length === 0) return;
      const from = starts[i] + child.nodeSize;
      let to = blockEnd;
      for (const mark of marks) {
        let j = i + 1;
        while (j < children.length && mark.isInSet(children[j].marks) !== undefined) j += 1;
        to = Math.min(to, j < children.length ? starts[j] : blockEnd);
      }
      if (from >= to) return;
      ranges.push([from, to]);
      if (to === blockEnd) toBlockEnd += 1;
      coveredTo = to;
    });
    return false;
  });
  let tr = EditorState.create({ doc }).tr;
  for (const [from, to] of [...ranges].reverse()) tr = tr.delete(from, to);
  return { doc: tr.doc, afterBreaksInRuns: ranges.length, toBlockEnd };
}

/**
 * {@link typeSpaceAtEveryLinkEnd}'s result: the changed document and how many link-marked text
 * nodes it typed a space at the end of.
 */
export interface LinkEdgeLeg {
  doc: PMNode;
  links: number;
}

/**
 * A ProseMirror transaction shaped like typing a space with the caret *inside a link*, at the end
 * of its text — the shape task 1.35 repairs (DECISIONS #review-1-r3 I3/I4: `*a [b ](u)* c`, a
 * link whose edge whitespace is at a flanking mark's edge, and `see [the essay ](u)`, one whose
 * edge is the block's): at the end of every text node carrying `link`, in a paragraph, heading or
 * table cell, one space is inserted by `insertText` with **that node's own marks set as the
 * transaction's stored marks first** (the marks `insertText` reads before it asks the position),
 * because `link` is not inclusive — at the end of a link's text `$pos.marks()` drops it, and a
 * space inserted without marks would land after the link, where the mark-edge leg
 * ({@link typeSpaceInsideEveryMarkedRun}) already types. Each step clears the stored marks, so
 * they are set before every insertion; the insertions are applied back-to-front so that each one
 * leaves the positions still to come unmoved.
 */
export function typeSpaceAtEveryLinkEnd(doc: PMNode): LinkEdgeLeg {
  const ends: [number, PMNode][] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText || parent === null || !INLINE_CONTENT.has(parent.type)) return true;
    if (schema.marks.link.isInSet(node.marks) !== undefined) ends.push([pos + node.nodeSize, node]);
    return true;
  });
  let tr = EditorState.create({ doc }).tr;
  for (const [pos, node] of [...ends].reverse())
    tr = tr.setStoredMarks([...node.marks]).insertText(" ", pos);
  return { doc: tr.doc, links: ends.length };
}

/**
 * {@link splitEveryListItemParagraph}'s and {@link pasteIntoEveryListItemParagraph}'s result: the
 * changed document and how many list items it reached.
 */
export interface ListSplitLeg {
  doc: PMNode;
  items: number;
}

/** The end position of every list item's first paragraph, ascending. */
function firstParagraphEnds(doc: PMNode): number[] {
  const ends: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== schema.nodes.list_item) return true;
    const first = node.firstChild;
    if (first !== null && first.type === schema.nodes.paragraph)
      ends.push(pos + 2 + first.content.size);
    return true;
  });
  return ends;
}

/**
 * A ProseMirror transaction shaped like Sol's fuzz probe (DECISIONS #review-1-r3 I2, the first 25
 * mismatches of 11,955 single transactions were all a `split` inside a list item's paragraph):
 * `tr.split` at the end of every list item's first paragraph, applied back-to-front so that each
 * split leaves the positions still to come unmoved. The split at the *end* leaves an empty
 * paragraph as the item's second child — the paragraph `blocksToMdast` drops before the item's
 * `spread` is derived — so the bytes a caller expects are the fixture's own: the leg is the
 * absence case, a second child that does not make the item spread, and a derivation that counted
 * the editor's children instead of the serialized ones would write a blank line before every
 * nested list.
 */
export function splitEveryListItemParagraph(doc: PMNode): ListSplitLeg {
  const ends = firstParagraphEnds(doc);
  let tr = EditorState.create({ doc }).tr;
  for (const pos of [...ends].reverse()) tr = tr.split(pos);
  return { doc: tr.doc, items: ends.length };
}

/**
 * The slice `prosemirror-view` builds from a two-line plain-text paste: one paragraph per line,
 * open one level at each end (`Slice.maxOpen`), which the fitter places as a continuation of
 * the paragraph under the caret and a second paragraph after it.
 */
export function twoLinePasteSlice(first: string, second: string): Slice {
  return new Slice(
    Fragment.from([
      schema.node("paragraph", null, schema.text(first)),
      schema.node("paragraph", null, schema.text(second)),
    ]),
    1,
    1,
  );
}

/**
 * A ProseMirror transaction shaped like the route Sol's finding took (DECISIONS #review-1-r3 I2):
 * a two-line plain-text paste with the caret at the end of a list item's paragraph — Enter there
 * is `splitListItem`, which opens a new item, so the paste is the one keystroke that gives an item
 * a second paragraph. `replaceSelection` with {@link twoLinePasteSlice} is the call
 * `prosemirror-view`'s paste handler makes; it runs at the end of every list item's first
 * paragraph, back-to-front so that each replacement leaves the positions still to come unmoved.
 */
export function pasteIntoEveryListItemParagraph(doc: PMNode): ListSplitLeg {
  const ends = firstParagraphEnds(doc);
  let tr = EditorState.create({ doc }).tr;
  for (const pos of [...ends].reverse()) {
    tr = tr
      .setSelection(TextSelection.create(tr.doc, pos))
      .replaceSelection(twoLinePasteSlice("X", "Y"));
  }
  return { doc: tr.doc, items: ends.length };
}

/**
 * {@link deleteBesideEveryMarkedRun}'s result: the changed document, and how many single
 * whitespace characters it deleted — one per run side that had one, counted once even where two
 * mark passes name the same neighbour (nested marks over the same span, or two adjacent runs
 * sharing the one space between them).
 */
export interface MarkNeighbourLeg {
  doc: PMNode;
  deleted: number;
}

/**
 * The child nodes and their document positions of an inline-content block, in order — the shape
 * both functions below scan a maximal run over.
 */
function inlineChildren(node: PMNode, blockStart: number): { children: PMNode[]; starts: number[] } {
  const children: PMNode[] = [];
  const starts: number[] = [];
  node.forEach((child, offset) => {
    children.push(child);
    starts.push(blockStart + offset);
  });
  return { children, starts };
}

/**
 * A ProseMirror transaction shaped like a Backspace over the one character just outside a flanking
 * mark's run — the review's own reproduction (DECISIONS #review-1-r4 J1, task 1.41): for every
 * maximal run of `emphasis`, `strong` or `delete` in a paragraph, heading or table cell, the
 * whitespace character immediately outside the run is deleted on each side where the adjacent
 * sibling is text and starts (after the run) or ends (before the run) with one. Two single-
 * character deletions per run, applied separately — never merged into one range — so a run flanked
 * by whitespace on both sides loses exactly one character from each neighbour and never reaches
 * past it into whatever follows. `tr.delete` is the call a Backspace makes; every range found is
 * collected first and the transaction applies them back-to-front, so each leaves the ranges still
 * to come unmoved.
 */
export function deleteBesideEveryMarkedRun(doc: PMNode): MarkNeighbourLeg {
  const ranges = new Map<string, [number, number]>();
  const addRange = (from: number, to: number): void => {
    ranges.set(`${from}-${to}`, [from, to]);
  };
  doc.descendants((node, pos) => {
    if (!INLINE_CONTENT.has(node.type)) return true;
    const { children, starts } = inlineChildren(node, pos + 1);
    for (const mark of FLANKING_MARKS) {
      let i = 0;
      while (i < children.length) {
        if (mark.isInSet(children[i].marks) === undefined) {
          i += 1;
          continue;
        }
        const runStart = i;
        while (i < children.length && mark.isInSet(children[i].marks) !== undefined) i += 1;
        const runEnd = i;
        if (runStart > 0) {
          const before = children[runStart - 1];
          if (before.isText) {
            const text = before.text as string;
            const last = [...text].pop();
            const end = starts[runStart - 1] + before.nodeSize;
            if (last !== undefined && /\s/u.test(last)) addRange(end - last.length, end);
          }
        }
        if (runEnd < children.length) {
          const after = children[runEnd];
          if (after.isText) {
            const text = after.text as string;
            const first = [...text][0];
            const start = starts[runEnd];
            if (first !== undefined && /\s/u.test(first)) addRange(start, start + first.length);
          }
        }
      }
    }
    return false;
  });
  const sorted = [...ranges.values()].sort((a, b) => b[0] - a[0]);
  let tr = EditorState.create({ doc }).tr;
  for (const [from, to] of sorted) tr = tr.delete(from, to);
  return { doc: tr.doc, deleted: sorted.length };
}

/**
 * {@link punctuateThenDeleteAfterEveryMarkedRun}'s result: the changed document, and how many
 * runs it typed a period into and then deleted the following whitespace from.
 */
export interface MarkNeighbourPunctuateLeg {
  doc: PMNode;
  punctuated: number;
}

/**
 * The "certain case" of the review's reproduction: rather than deleting the neighbour whitespace
 * outright, a `.` is typed at the run's end, with the run's own marks (`setStoredMarks` first, the
 * call {@link typeSpaceAtEveryLinkEnd} makes for the same reason — inserting at a run's exclusive
 * edge would otherwise place the text outside it), and then the whitespace that character's
 * neighbour was is deleted — the exact shape the r4 reviewers reproduced by hand (`~~beta.~~` then
 * a Backspace over the following space, `~~…](essay.md)~~` the same). Only the run's *after* side
 * has a "then deletes the whitespace after it" to speak of; a run with no whitespace immediately
 * outside it is untouched. Each run's insertion and deletion are two steps of the same local
 * transaction, so the position computed before either is still valid for both; runs are processed
 * back-to-front so that each pair leaves the positions still to come unmoved.
 */
export function punctuateThenDeleteAfterEveryMarkedRun(doc: PMNode): MarkNeighbourPunctuateLeg {
  const targets = new Map<number, { wsLen: number; marks: readonly PMMark[] }>();
  doc.descendants((node, pos) => {
    if (!INLINE_CONTENT.has(node.type)) return true;
    const { children, starts } = inlineChildren(node, pos + 1);
    for (const mark of FLANKING_MARKS) {
      let i = 0;
      while (i < children.length) {
        if (mark.isInSet(children[i].marks) === undefined) {
          i += 1;
          continue;
        }
        while (i < children.length && mark.isInSet(children[i].marks) !== undefined) i += 1;
        const runEnd = i;
        const last = children[runEnd - 1];
        if (runEnd < children.length && last.isText) {
          const after = children[runEnd];
          if (after.isText) {
            const text = after.text as string;
            const first = [...text][0];
            if (first !== undefined && /\s/u.test(first)) {
              targets.set(starts[runEnd], { wsLen: first.length, marks: last.marks });
            }
          }
        }
      }
    }
    return false;
  });
  const ordered = [...targets.entries()].sort((a, b) => b[0] - a[0]);
  let tr = EditorState.create({ doc }).tr;
  for (const [pos, { wsLen, marks }] of ordered) {
    tr = tr.setStoredMarks([...marks]).insertText(".", pos);
    tr = tr.delete(pos + 1, pos + 1 + wsLen);
  }
  return { doc: tr.doc, punctuated: ordered.length };
}
