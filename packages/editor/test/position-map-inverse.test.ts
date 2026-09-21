import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Nodes, Root } from "mdast";
import { formatWithMap, parse } from "@essaydown/core";
import type { Node as PMNode } from "prosemirror-model";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";
import { cursorMap, type CursorMap } from "../src/toggle.js";
import { deleteAtEveryBlockEnd, deleteBesideEveryMarkedRun } from "./typing-legs.js";

/**
 * The cursor map's own round-trip family, asserted as a property over the corpus (task 1.52,
 * DECISIONS #review-1-r6 L5 with the corpus half of L3/L4; CLAUDE.md's rule that a fix for one
 * member of a stated invariant asserts the invariant over the corpus and enumerates instances
 * only as named guards on top of it).
 *
 * The invariant: for every position `p` a caret can occupy in the editor's document,
 * `toRendered(toSource(p)) === p`, and `toSource` is monotone in `p` within each textblock. Its
 * members so far, each found one at a time by a reviewer seeding one shape: the encoded
 * neighbour of 1.46, the html-before-a-break and inline-code spellings of 1.51, and this task's
 * cell end (every cell end answered the row's first position) with the block end after a trailing
 * inline atom (#030 Decision 2) and a paragraph's end inside a list item or blockquote that
 * continues on a later line, the same non-mark branch of `delimiterPosition` — all three of
 * this task's are answered by `containerEnd` and `isLeafEnd` in `toggle.ts`.
 *
 * Two corpus legs — one seeded from `parse(fixture)`, one from the writing surface's own output
 * after the destructive transactions of `typing-legs.ts` — and the named guards after them.
 *
 * **The position set** is computed from each document, never a literal: every position whose
 * parent is a textblock (the positions between blocks are not caret positions), less the
 * position between the two UTF-16 units of one astral code point, which no caret can occupy
 * either (one character is one code point, `typing-legs.ts`'s rule; the spelling table counts
 * units because the parser does, so that one non-position has no column of its own inside a
 * `&#x1F600;` reference). Both exclusions are stated here once and counted below so they are
 * seen to be small.
 *
 * **A class the corpus holds and this task does not own — the inverse holds at every text
 * position outside a fenced code block's interior**: `code_block` is a ProseMirror textblock,
 * but the map's third clause places a leaf block (`code`, `thematicBreak`, `html`) whole — it has
 * no spelling table (`packages/core/src/positions.ts`, outside this task's scope) — so every
 * caret inside a fence maps to the node's start and back to the position *before* the block.
 * Recorded as the `[1.52, code block interior]` line in docs/V1.1-BACKLOG.md (L4's block-level
 * sibling) and decided at DECISIONS #032: the exclusion is a named member asserted positively,
 * never an `it.fails` — on the three fixtures that hold a fence every non-identity position is
 * inside a `code_block`, nothing else is, and at least one such position exists per member (the
 * assertion that goes red the day `code` gets its table, so the exclusion cannot outlive its
 * cause); both legs' reach cases count the excluded positions and assert they are exactly the
 * `code_block` interiors of exactly those fixtures.
 */

const FIXTURES = "fixtures/markdown";

function fixtureIndex(): Record<string, unknown> {
  return JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
}

function read(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

/** The `(root, doc)` pair `cursorMap` takes, both from the editor's own conversion of `source`. */
function pair(source: string): { root: Root; doc: PMNode } {
  const editor = mdastToPM(parse(source));
  return { root: pmToMdast(editor), doc: editor.doc };
}

const HIGH_SURROGATE_LAST = /[\uD800-\uDBFF]$/;
const LOW_SURROGATE_FIRST = /^[\uDC00-\uDFFF]/;

/** Whether `pos` sits between the two UTF-16 units of one code point (see the file comment). */
function insideSurrogatePair(doc: PMNode, pos: number): boolean {
  const $pos = doc.resolve(pos);
  const before = $pos.nodeBefore;
  const after = $pos.nodeAfter;
  return (
    before !== null &&
    after !== null &&
    before.isText &&
    after.isText &&
    HIGH_SURROGATE_LAST.test(before.text as string) &&
    LOW_SURROGATE_FIRST.test(after.text as string)
  );
}

/** One textblock of `doc` with the caret positions it holds, in order. */
interface TextblockPositions {
  node: PMNode;
  /** The position of the block's first content character. */
  start: number;
  positions: number[];
  /** How many positions the surrogate-pair rule left out of `positions`. */
  surrogateInteriors: number;
}

/**
 * Every caret position of `doc`, grouped by textblock and computed from the doc (see the file
 * comment for the two exclusions). Empty textblocks hold exactly one position.
 */
function textblocksOf(doc: PMNode): TextblockPositions[] {
  const out: TextblockPositions[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const start = pos + 1;
    const block: TextblockPositions = { node, start, positions: [], surrogateInteriors: 0 };
    for (let at = start; at <= start + node.content.size; at += 1) {
      if (insideSurrogatePair(doc, at)) block.surrogateInteriors += 1;
      else block.positions.push(at);
    }
    out.push(block);
    return false;
  });
  return out;
}

/** `(line, ch)` as one number, for the monotonicity check. */
function sourceKey(position: { line: number; ch: number }): number {
  return position.line * 1_000_000 + position.ch;
}

/** The result of one document's inverse sweep: what was reached, and what did not come back. */
interface Sweep {
  positions: number;
  blocks: number;
  surrogateInteriors: number;
  /** Every position `toRendered ∘ toSource` did not return to, with where it went. */
  failures: { pos: number; back: number; block: string }[];
}

/**
 * The invariant over one document: every caret position of every textblock comes back through
 * the two directions, and within each textblock `toSource` never moves backwards. `upTo` bounds
 * the positions asserted for the identity per block (the destructive leg passes the end of the
 * block's correspondence; the parse leg passes nothing, every position).
 */
function sweep(map: CursorMap, doc: PMNode, upTo?: (block: TextblockPositions) => number): Sweep {
  const result: Sweep = { positions: 0, blocks: 0, surrogateInteriors: 0, failures: [] };
  for (const block of textblocksOf(doc)) {
    const limit = upTo === undefined ? Number.POSITIVE_INFINITY : upTo(block);
    const positions = block.positions.filter((pos) => pos <= limit);
    result.blocks += 1;
    result.surrogateInteriors += block.surrogateInteriors;
    let previous = Number.NEGATIVE_INFINITY;
    for (const pos of positions) {
      const at = map.toSource(pos);
      const back = map.toRendered(at);
      if (back !== pos) result.failures.push({ pos, back, block: block.node.type.name });
      const key = sourceKey(at);
      expect(key, `toSource is monotone: position ${pos} in ${block.node.type.name}`).toBeGreaterThanOrEqual(previous);
      previous = key;
      result.positions += 1;
    }
  }
  return result;
}

/** How many ProseMirror positions an mdast inline block's children occupy — `toggle.ts`'s `inlineWidth`. */
function mdastInlineWidth(node: Nodes): number {
  if (node.type === "text" || node.type === "inlineCode") return node.value.length;
  if (!("children" in node)) return 1;
  return node.children.reduce((total, child) => total + mdastInlineWidth(child as Nodes), 0);
}

/**
 * The mdast blocks `walkBlock` pairs the editor's textblocks with, in pre-order: the
 * phrasing-bearing ones and `code` (a `code_block` is a textblock too). The two sequences are
 * the same length for a document the deletion legs produce — they split nothing, so no
 * placeholder paragraph is in the editor's tree — which the caller asserts.
 */
function mdastTextblocks(root: Root): Nodes[] {
  const out: Nodes[] = [];
  const visit = (node: Nodes): void => {
    if (
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "tableCell" ||
      node.type === "code"
    ) {
      out.push(node);
      return;
    }
    if ("children" in node) (node.children as Nodes[]).forEach(visit);
  };
  root.children.filter((child) => child.type !== "yaml").forEach(visit);
  return out;
}

/**
 * The fixtures holding a fenced code block — the `[1.52, code block interior]` exclusion's
 * members (DECISIONS #032), asserted positively: on these every non-identity position is inside
 * a `code_block` and at least one exists; on every other fixture the inverse holds everywhere.
 */
const CODE_BLOCK_MEMBERS = ["code-fence-basic.md", "code-fence-nested.md", "essay-fixture.md"];

/** The caret positions of `doc` whose parent is a `code_block` — the exclusion's exact extent. */
function codeBlockInteriors(doc: PMNode): number {
  return textblocksOf(doc)
    .filter((block) => block.node.type === schema.nodes.code_block)
    .reduce((total, block) => total + block.positions.length, 0);
}

describe("cursor map: toRendered ∘ toSource is the identity over every text position outside a fenced code block's interior, of every fixture", () => {
  const names = Object.keys(fixtureIndex());
  const reached: string[] = [];
  let surrogateInteriorsSkipped = 0;
  const fixturesWithSurrogateInteriors: string[] = [];
  /** (iv) The excluded positions, counted, with the fixtures they came from. */
  let excludedPositions = 0;
  let codeBlockPositions = 0;
  const fixturesExcluded: string[] = [];

  for (const name of names) {
    const codeMember = CODE_BLOCK_MEMBERS.includes(name);
    it(`${name}: ${codeMember ? "every non-identity position is inside a code_block and at least one exists (the [1.52, code block interior] backlog class, DECISIONS #032), and nothing else" : "the inverse holds at every text position, and toSource is monotone within each textblock"}`, () => {
      const { root, doc } = pair(read(name));
      const map = cursorMap(root, doc);
      const result = sweep(map, doc);
      expect(result.positions, name).toBeGreaterThan(0);
      if (codeMember) {
        expect(result.failures.length, name).toBeGreaterThan(0);
        expect(result.failures.filter((failure) => failure.block !== "code_block"), name).toEqual([]);
      } else {
        expect(result.failures, name).toEqual([]);
      }
      excludedPositions += result.failures.length;
      codeBlockPositions += codeBlockInteriors(doc);
      if (result.failures.length > 0) fixturesExcluded.push(name);
      surrogateInteriorsSkipped += result.surrogateInteriors;
      if (result.surrogateInteriors > 0) fixturesWithSurrogateInteriors.push(name);
      reached.push(name);
    });
  }

  it("reached every fixture in the index, the exclusion is exactly the code_block interiors of exactly the named members, and the surrogate-pair rule left out only interiors of astral fixtures", () => {
    expect(reached.sort()).toEqual([...names].sort());
    expect(names.length).toBeGreaterThan(40);
    expect(CODE_BLOCK_MEMBERS.every((name) => names.includes(name))).toBe(true);
    // (iv) Every excluded position is a code_block interior and every code_block interior is
    // excluded — the count is the class, no more, no fewer — and only the members hold one.
    expect(excludedPositions).toBeGreaterThan(0);
    expect(excludedPositions).toBe(codeBlockPositions);
    expect(fixturesExcluded.sort()).toEqual([...CODE_BLOCK_MEMBERS].sort());
    // Non-vacuous: the rule fired somewhere (the corpus holds astral fixtures), and only there.
    expect(surrogateInteriorsSkipped).toBeGreaterThan(0);
    expect(fixturesWithSurrogateInteriors).toContain("astral-neighbour.md");
    for (const name of fixturesWithSurrogateInteriors) {
      // The fixture's text holds a pair (its bytes may spell it as a `&#x1F600;` reference).
      expect(/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(pair(read(name)).doc.textContent), name).toBe(true);
    }
  });
});

describe("cursor map: toRendered ∘ toSource is the identity over every text position outside a fenced code block's interior, of the editor's own output after a destructive transaction (deleteAtEveryBlockEnd, deleteBesideEveryMarkedRun)", () => {
  const names = Object.keys(fixtureIndex());
  const reached: string[] = [];
  let fixturesChanged = 0;
  let fixturesUnchanged = 0;
  /** (iv) The excluded positions, counted, with the fixtures they came from (DECISIONS #032). */
  let excludedPositions = 0;
  let codeBlockPositions = 0;
  const fixturesExcluded: string[] = [];
  /**
   * Positions the bytes do not hold: a block the conversion narrowed (a `hard_break` left last
   * and dropped, trailing whitespace stripped) is wider in the editor than in the tree, and its
   * positions past the correspondence are answered by `toSource`'s second clause with the end
   * of what precedes them (task 1.43's rule, asserted by `position-map-editor-leg.test.ts`), so
   * their round trip lands on the correspondence's end, not on themselves. Asserted as that,
   * and counted with the fixtures named, so the leg is seen to reach the shape.
   */
  let positionsPastCorrespondence = 0;
  const fixturesPastCorrespondence: string[] = [];
  const LEGS = [
    { leg: "deleteAtEveryBlockEnd", run: deleteAtEveryBlockEnd },
    { leg: "deleteBesideEveryMarkedRun", run: deleteBesideEveryMarkedRun },
  ] as const;

  for (const name of names) {
    for (const { leg, run } of LEGS) {
      it(`${name} after ${leg}: the inverse holds at every text position the bytes hold, positions past a narrowed block's correspondence land on its end, and toSource is monotone`, () => {
        const editor = mdastToPM(parse(read(name)));
        const changed = run(editor.doc).doc;
        if (changed.eq(editor.doc)) fixturesUnchanged += 1;
        else fixturesChanged += 1;
        const root = pmToMdast({ doc: changed, frontMatter: editor.frontMatter });
        const map = cursorMap(root, changed);
        const blocks = textblocksOf(changed);
        const counterparts = mdastTextblocks(root);
        expect(counterparts.length, `${name}: one mdast block per textblock`).toBe(blocks.length);
        const correspondenceEnd = new Map<number, number>();
        blocks.forEach((block, index) => {
          const counterpart = counterparts[index];
          const width =
            counterpart.type === "code" ? block.node.content.size : mdastInlineWidth(counterpart);
          expect(width, `${name}: the conversion never widens a block`).toBeLessThanOrEqual(
            block.node.content.size,
          );
          correspondenceEnd.set(block.start, block.start + width);
        });
        const result = sweep(map, changed, (block) => correspondenceEnd.get(block.start) as number);
        expect(result.positions, name).toBeGreaterThan(0);
        expect(
          result.failures.filter((failure) => failure.block !== "code_block"),
          name,
        ).toEqual([]);
        if (CODE_BLOCK_MEMBERS.includes(name)) expect(result.failures.length, name).toBeGreaterThan(0);
        excludedPositions += result.failures.length;
        codeBlockPositions += codeBlockInteriors(changed);
        if (result.failures.length > 0 && !fixturesExcluded.includes(name)) fixturesExcluded.push(name);
        // The positions past a narrowed block's correspondence: to the correspondence's end.
        let past = 0;
        for (const block of blocks) {
          const end = correspondenceEnd.get(block.start) as number;
          for (const pos of block.positions.filter((at) => at > end)) {
            expect(map.toRendered(map.toSource(pos)), `${name}: position ${pos} past ${end}`).toBe(end);
            past += 1;
          }
        }
        if (past > 0 && !fixturesPastCorrespondence.includes(name)) fixturesPastCorrespondence.push(name);
        positionsPastCorrespondence += past;
        reached.push(`${name} ${leg}`);
      });
    }
  }

  it("ran both destructive legs over every fixture in the index, and the corpus reached both sides of every clause", () => {
    expect(reached.sort()).toEqual(
      names.flatMap((name) => LEGS.map(({ leg }) => `${name} ${leg}`)).sort(),
    );
    expect(fixturesChanged).toBeGreaterThan(0);
    expect(fixturesUnchanged).toBeGreaterThan(0);
    // (iv) The exclusion after a destructive transaction is still exactly the code_block
    // interiors of exactly the named members (the deletion legs remove no fence).
    expect(excludedPositions).toBeGreaterThan(0);
    expect(excludedPositions).toBe(codeBlockPositions);
    expect(fixturesExcluded.sort()).toEqual([...CODE_BLOCK_MEMBERS].sort());
    // The narrowed-block shape is reached (`hard-break.md` ends a paragraph in a break once its
    // continuation is deleted), and it is a minority of the corpus.
    expect(positionsPastCorrespondence).toBeGreaterThan(0);
    expect(fixturesPastCorrespondence).toContain("hard-break.md");
    expect(fixturesPastCorrespondence.length).toBeLessThan(names.length);
  });
});

/** The ProseMirror positions at the end of every table cell's content, in document order. */
function cellEnds(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.table_cell) out.push(pos + 1 + node.content.size);
    return true;
  });
  return out;
}

/** The text nodes' `pmEnd`s that end a textblock — the cell ends' answers, from the doc. */
function blockContentEnds(doc: PMNode): number[] {
  return textblocksOf(doc).map((block) => block.start + block.node.content.size);
}

/** One named guard: the inverse over every text position of `source`, and its sweep. */
function assertInverse(source: string): { root: Root; doc: PMNode; map: CursorMap; sweep: Sweep } {
  const { root, doc } = pair(source);
  const map = cursorMap(root, doc);
  const result = sweep(map, doc);
  expect(result.positions).toBeGreaterThan(0);
  expect(result.failures).toEqual([]);
  return { root, doc, map, sweep: result };
}

describe("cursor map inverse: the named members (guards on top of the corpus property)", () => {
  it("the table `| h1 | h2 |\\n| -- | -- |\\n| ab | z |`: every cell end, header row included, is its own inverse (L5, Claude finding 4)", () => {
    const source = "| h1 | h2 |\n| -- | -- |\n| ab | z |\n";
    const { doc, map } = assertInverse(source);
    const ends = cellEnds(doc);
    expect(ends).toHaveLength(4);
    // Claude's reproduction, from the doc: the header row's two cell ends and the body row's.
    expect(ends).toEqual(blockContentEnds(doc));
    for (const end of ends) {
      const at = map.toSource(end);
      expect(map.toRendered(at), `cell end ${end} (${at.line}:${at.ch})`).toBe(end);
    }
    // The old answer, for the record: every cell end went to its row's first position (1 for
    // the header row, 11 for the body row) — not any more.
    expect(ends.map((end) => map.toRendered(map.toSource(end)))).not.toContain(1);
    expect(ends.map((end) => map.toRendered(map.toSource(end)))).not.toContain(11);
  });

  it("the padding and pipe after a cell's text belong to that cell's end, the ownership rule of `containerEnd` (at or past)", () => {
    const { root, doc, map } = assertInverse("| h1 | h2 |\n| -- | -- |\n| ab | z |\n");
    const text = formatWithMap(root).text;
    expect(text.split("\n")[0]).toBe("| h1 | h2 |");
    const [h1End, h2End] = cellEnds(doc);
    // `| h1 | h2 |`: ch 4 is the space after `h1` (at its end), ch 5 the pipe, ch 6 the space
    // before `h2` — all three are the row's bytes and all three are the caret at `h1`'s end.
    expect(map.toRendered({ line: 1, ch: 4 })).toBe(h1End);
    expect(map.toRendered({ line: 1, ch: 5 })).toBe(h1End);
    expect(map.toRendered({ line: 1, ch: 6 })).toBe(h1End);
    // Past the row's closing pipe: the last cell's end.
    expect(map.toRendered({ line: 1, ch: 10 })).toBe(h2End);
    expect(map.toRendered({ line: 1, ch: 11 })).toBe(h2End);
    // The delimiter row holds no block, so the old answer stands: the table's own start (0),
    // which `renderedSelection` snaps into the first cell.
    expect(map.toRendered({ line: 2, ch: 3 })).toBe(0);
  });

  it("an empty cell: its one position is its own inverse (the no-descendant branch of `containerEnd`)", () => {
    const source = "| a |  |\n| - | - |\n|  | d |\n";
    const { doc, map } = assertInverse(source);
    const ends = cellEnds(doc);
    expect(ends).toHaveLength(4);
    const empty = ends.filter((end) => doc.resolve(end).parent.content.size === 0);
    expect(empty).toHaveLength(2);
    for (const end of empty) {
      expect(doc.resolve(end).parent.type).toBe(schema.nodes.table_cell);
      expect(map.toRendered(map.toSource(end))).toBe(end);
    }
  });

  it("a paragraph's end inside a list item that continues on a later line, and inside a blockquote that does — the same branch, the corpus's other container", () => {
    // `- one` ends on line 1 while its item (a nested list) and the list run on; the
    // blockquote's first paragraph ends on line 1 while the quote runs to line 3.
    const list = assertInverse("- one\n  - nested\n- two\n");
    const quote = assertInverse("> alpha\n>\n> beta\n");
    for (const { doc, map } of [list, quote]) {
      const [first] = blockContentEnds(doc);
      const at = map.toSource(first);
      expect(at.line).toBe(1);
      expect(map.toRendered(at)).toBe(first);
    }
  });

  it("`a `+\"`cd`\"+` b` and `# h `+\"`c`\"+`` (task 1.51's spelling table for inline code, L4)", () => {
    assertInverse("a `cd` b\n");
    assertInverse("# h `c`\n");
  });

  it("`alpha beta\\n<span>x</span> gamma` (task 1.51's fourth candidate, L3)", () => {
    const { root } = assertInverse("alpha beta\n<span>x</span> gamma\n");
    expect(formatWithMap(root).text).toBe("alpha beta <span>x</span> gamma\n");
  });

  it("`*a.*&#x1F600;*(b)*` (task 1.49, the astral character between two runs)", () => {
    const { sweep: result } = assertInverse("*a.*&#x1F600;*(b)*\n");
    expect(result.surrogateInteriors).toBe(1);
  });

  it("`alpha <i>beta</i>` and `alpha ![x](u)`: the block end after a trailing inline atom is its own inverse (DECISIONS #030 Decision 2, the member 1.51 excluded by name)", () => {
    for (const source of ["alpha <i>beta</i>\n", "alpha ![x](u)\n", "# h <b>x</b>\n"]) {
      const { root, doc, map } = assertInverse(source);
      const [end] = blockContentEnds(doc);
      expect(doc.resolve(end).nodeBefore?.isAtom).toBe(true);
      const at = map.toSource(end);
      // The atom's end, not its start: the column after `</i>`, `)` or `</b>`.
      const line = formatWithMap(root).text.split("\n")[0];
      expect(at).toEqual({ line: 1, ch: line.length });
      // And the position before the atom still answers the atom's start (clause 3 unchanged
      // there), so the two positions the atom covers keep two columns.
      const before = map.toSource(end - 1);
      expect(before.ch).toBeLessThan(at.ch);
      expect(map.toRendered(before)).toBe(end - 1);
    }
  });

  it("a cell ending in an atom: both rules meet and the cell end is its own inverse", () => {
    const { doc, map } = assertInverse("| ![x](u) | b |\n| - | - |\n| c | <i>d</i> |\n");
    for (const end of cellEnds(doc)) expect(map.toRendered(map.toSource(end))).toBe(end);
  });
});
