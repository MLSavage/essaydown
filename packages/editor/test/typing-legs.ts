import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { expect } from "vitest";
import { schema } from "../src/schema.js";

/**
 * The two typing-shaped transactions the editor-seeded round-trip legs share.
 *
 * Task 1.13 wrote the block-end space and task 1.25 the in-block letter, both inside
 * `editor-fixed-point.test.ts`. Task 1.27 (DECISIONS #review-1-r1 G6) adds a third leg — the
 * position map over the same editor output — and the promoted rule asks every family's leg to be
 * seeded from *the writing surface's own output*, which only holds if all of them type the same
 * thing. So the transactions live here and are imported by both suites rather than copied into
 * the second one, where a later fix to one would silently leave the other typing something else.
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
