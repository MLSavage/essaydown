import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Nodes, Root, Yaml } from "mdast";
import { format, formatWithMap, parse } from "@essaydown/core";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import {
  CELL_LINE_ENDING,
  LINE_ENDING,
  keptCharacters,
  mdastToPM,
  pmToMdast,
  schema,
} from "../src/schema.js";
import { cursorMap, type CursorMap } from "../src/toggle.js";
import { blockAlone } from "./block-alone";
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
 * never marking a case as an expected failure — on the three fixtures that hold a fence every non-identity position is
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

  /**
   * DECISIONS #review-1-r7 M6: vitest's default per-test timeout is 5,000 ms, and the
   * essay-fixture leg below ran 3,401 / 2,930 / 1,364 ms on the accepted ubuntu / windows / macos
   * runners of gate 1.verify.r7.g2h and 5,051 ms once in a cold build (Claude's r7 review) — over
   * the 5,000 ms default on that one run. 30_000 ms gives headroom without masking a real stall;
   * it is not a narrowing of the position set either destructive leg asserts.
   */
  const DESTRUCTIVE_LEG_TIMEOUT_MS = 30_000;

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
      }, DESTRUCTIVE_LEG_TIMEOUT_MS);
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

/* --------- the third destructive leg: the first character of every textblock deleted -------- */

/** One ProseMirror node's children, in order. */
function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((child) => out.push(child));
  return out;
}

/**
 * The kept-character map of one textblock's live children, with the line ending the conversion
 * gives that block kind (`schema.ts`: a cell's line-ending run collapses to a space, everything
 * else's to a soft break).
 */
function keptIn(block: PMNode): ReturnType<typeof keptCharacters> {
  return keptCharacters(
    childrenOf(block),
    block.type === schema.nodes.table_cell ? CELL_LINE_ENDING : LINE_ENDING,
  );
}

/**
 * A third destructive transaction for the editor-seeded legs (task 1.64, DECISIONS #review-1-r8
 * N2), and the one the reconciliation used to find N2: the **first character** of every textblock
 * outside a fenced code block deleted, applied back-to-front so each deletion leaves the ranges
 * still to come unmoved. `tr.delete` is the call a Delete keystroke makes.
 *
 * It is the shortest route to a tree the parser cannot produce *and* that the conversion has to
 * narrow: a block whose first character was followed by a space is left with a **leading space**,
 * which `stripUnparsableWhitespace` drops — so the live document holds a character the bytes do
 * not, and every position after it is one the correspondence has to place through the
 * kept-character map rather than through the normalised tree's widths.
 *
 * One character is one code point (`typing-legs.ts`'s rule for the whole family), so an astral
 * lead is deleted whole and never split between its two UTF-16 units.
 */
function deleteAtEveryBlockStart(doc: PMNode): { doc: PMNode; blocks: number } {
  const ranges: [number, number][] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type === schema.nodes.code_block) return false;
    const first = node.firstChild;
    if (first !== null && first.isText) {
      const character = [...(first.text as string)][0] as string;
      ranges.push([pos + 1, pos + 1 + character.length]);
    }
    return false;
  });
  let tr = EditorState.create({ doc }).tr;
  for (const [from, to] of [...ranges].reverse()) tr = tr.delete(from, to);
  return { doc: tr.doc, blocks: ranges.length };
}

/**
 * The bytes the **rendered** view writes when `X` is typed at `pos`. `insertText` with no stored
 * marks is the click route's own call — prosemirror-state 1.4.4 gives the text
 * `storedMarks ?? $from.marks()` — so the letter takes exactly the marks a click there leaves.
 */
function typedInRendered(doc: PMNode, pos: number, frontMatter: Yaml | null): string {
  const typed = EditorState.create({ doc }).tr.insertText("X", pos).doc;
  return format(pmToMdast({ doc: typed, frontMatter }));
}

/** The bytes the **source** view writes when `X` is typed at `at`: a raw keystroke in the pane. */
function typedInSource(text: string, at: { line: number; ch: number }): string {
  const lines = text.split("\n");
  const line = lines[at.line - 1];
  lines[at.line - 1] = `${line.slice(0, at.ch)}X${line.slice(at.ch)}`;
  return format(parse(lines.join("\n")));
}

/** Where one line of a block alone sits in the whole document: its line, and its column shift. */
interface LineShift {
  line: number;
  ch: number;
}

/**
 * The third destructive corpus leg (task 1.64, DECISIONS #review-1-r8 N2). The two legs above
 * assert the inverse; this one asserts **both views' bytes** as well, because N2's defect held
 * the inverse while both directions were wrong — a leg that only asks whether a position comes
 * back cannot see a correspondence that is uniformly one place off.
 *
 * For every fixture: {@link deleteAtEveryBlockStart}, then at every caret position of every
 * textblock outside a fenced code block, `X` typed in the rendered view and `X` typed into the
 * source at the column `toSource` answers write the same bytes, and `toRendered ∘ toSource`
 * settles the position — onto itself where the conversion kept the character before it, and onto
 * the next kept character where it did not (the ownership rule of `keptCharacters`, stated once
 * there and asserted here over the corpus).
 *
 * The bytes are compared on the block alone ({@link blockAlone}, which states why), the inverse
 * and the settling rule on the whole document, and the two are bridged at every swept position:
 * the whole document's `(line, ch)` for a position is the block's own `(line, ch)` shifted by a
 * constant per line of the block. **Every** caret position of **every** textblock of **every**
 * fixture is swept: nothing here is bounded, sampled or narrowed.
 *
 * **One test per swept block**, which is the granularity of the oracle itself — a correspondence
 * is block-local, every branch this task changes reads one textblock's own children, and the
 * bytes are the block's. It is also what keeps the 30_000 ms budget this family takes (DECISIONS
 * #review-1-r7 M6) honest on any machine: one byte comparison is a `parse` of the block (0.38 ms
 * measured here, nearly all of it micromark's per-call setup — hoisting `createParser` out of the
 * sweep changes nothing), so the corpus's long-form fixture is 11 s of comparisons on an idle
 * container and over 30 s when the suite's other workers run beside it (measured: a per-fixture
 * test timed out in `pnpm test` while passing in 12.2 s on its own). Per block, the largest test
 * of the corpus is under a second, and no position is left out to get there.
 *
 * **Both sides of the leg's own clause**, counted from the run and never written as a literal:
 * the transaction leaves some blocks with a lead the conversion drops (the deleted character was
 * followed by a space) and leaves others whole (it was followed by a letter, or the block begins
 * with a link, whose leading whitespace lives inside its brackets), and the leg asserts both sets
 * are non-empty — a run in which every block lost its lead would never exercise the identity half,
 * which is the half that says the change is a no-op where nothing is dropped.
 *
 * **The exclusions, positively bounded (DECISIONS #032)** — three recorded classes, each position
 * asserted to be a member of its class rather than merely skipped, and none narrowed:
 *
 * - `[1.53, a raw source keystroke before or after a punctuation-edged run]`: the rendered view
 *   keeps the run by writing the letter as a character reference, the raw keystroke in the source
 *   view does not and the reparse dissolves the run. Asserted: the rendered bytes hold `&#x58;`
 *   where the source bytes hold a raw `X`.
 * - `[review-1-r6 L9, URL-shaped text]`: a character typed inside an autolink literal's text
 *   leaves the editor holding a `link` whose text is no longer its destination, so the rendered
 *   bytes are a `[text](url)` link while the source keystroke edits the `<…>` autolink in place.
 *   Asserted: the rendered bytes hold the resource form and the source bytes the autolink form.
 * - `[1.64, a block-final mark whose last child is a link]` — found by this leg, outside this
 *   task's scope (it reproduces unchanged at the branch base, in blocks where the conversion
 *   drops nothing), filed in `docs/V1.1-BACKLOG.md` with its revisit trigger and hard stop: at
 *   the end of a block ending in `*…[text](url)*`, the rendered caret takes `[emphasis]` (the
 *   `link` mark is not inclusive, the `emphasis` is) and types **inside** the run, while
 *   `toSource` answers the column **after** the run's closing delimiter, where the raw keystroke
 *   dissolves the run. Asserted: the source bytes escape the run's delimiters where the rendered
 *   bytes keep them.
 */
describe("cursor map: the two views write the same bytes, and toRendered ∘ toSource settles by the kept-character rule, at every text position of the editor's own output after a third destructive transaction (deleteAtEveryBlockStart, task 1.64)", () => {
  const names = Object.keys(fixtureIndex());
  const reached = new Set<string>();
  let fixturesChanged = 0;
  let fixturesUnchanged = 0;
  let blocksSwept = 0;
  let blocksLosingTheirLead = 0;
  let blocksKeepingTheirLead = 0;
  let positionsAgreeing = 0;
  let positionsInsideDropped = 0;
  /** How many swept positions were bridged from the block alone to the whole document. */
  let positionsBridged = 0;
  const excluded: { name: string; pos: number; klass: string }[] = [];

  /**
   * DECISIONS #review-1-r7 M6, the same budget the two legs above take and for the same reason:
   * vitest's default per-test timeout is 5,000 ms, and a leg that runs a `format ∘ pmToMdast` and
   * a `format ∘ parse` per caret position is well over it on the larger blocks. 30_000 ms gives
   * headroom without masking a stall, and it narrows no position this leg asserts.
   */
  const START_LEG_TIMEOUT_MS = 30_000;

  const PUNCTUATION_EDGED = "[1.53] a raw source keystroke beside a punctuation-edged run";
  const AUTOLINK_LITERAL = "[review-1-r6 L9] a character typed inside an autolink literal's text";
  const MARK_ENDING_IN_A_LINK = "[1.64] a block-final mark whose last child is a link";

  /** Which recorded class a disagreement belongs to, or `null` when it belongs to none. */
  function classify(rendered: string, written: string): string | null {
    if (rendered.includes("&#x58;") && !written.includes("&#x58;")) return PUNCTUATION_EDGED;
    // The resource form on one side and the autolink form on the other, of the same URL: the
    // source keystroke edits the `<…>` destination in place, the rendered one splits text from it.
    if (/\]\(/.test(rendered) && !/\]\(/.test(written) && /<[^\s>]+>/.test(written))
      return AUTOLINK_LITERAL;
    // The source keystroke landed outside the run and its delimiters are escaped there.
    if (/\\[*~_]/.test(written) && !/\\[*~_]/.test(rendered) && /\]\(/.test(rendered))
      return MARK_ENDING_IN_A_LINK;
    return null;
  }

  /** One fixture after the transaction: the live document and the whole document's cursor map. */
  interface Prepared {
    changed: PMNode;
    map: CursorMap;
    /** The position of every textblock this leg sweeps, in document order. */
    blocks: { pos: number; type: string }[];
  }

  /**
   * The fixture whose blocks are being swept, kept ready. The tests are declared and run in
   * document order, so one entry serves the whole of a fixture; the fixture-level counters are
   * taken once per fixture however often it is prepared ({@link counted}).
   */
  let ready: { name: string; prepared: Prepared } | null = null;
  const counted = new Set<string>();

  function prepare(name: string): Prepared {
    if (ready !== null && ready.name === name) return ready.prepared;
    const editor = mdastToPM(parse(read(name)));
    const { doc: changed, blocks } = deleteAtEveryBlockStart(editor.doc);
    const root = pmToMdast({ doc: changed, frontMatter: editor.frontMatter });
    const swept: { pos: number; type: string }[] = [];
    changed.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      if (node.type !== schema.nodes.code_block) swept.push({ pos, type: node.type.name });
      return false;
    });
    if (!counted.has(name)) {
      counted.add(name);
      if (blocks === 0) fixturesUnchanged += 1;
      else fixturesChanged += 1;
    }
    const prepared: Prepared = { changed, map: cursorMap(root, changed), blocks: swept };
    ready = { name, prepared };
    return prepared;
  }

  /** Every position of one textblock: the settling rule, the bridge, and the two views' bytes. */
  function sweepBlock(name: string, prepared: Prepared, pos: number): void {
    const { changed, map } = prepared;
    const node = changed.nodeAt(pos);
    expect(node, `${name}: the textblock planned at ${pos}`).not.toBeNull();
    const block = node as PMNode;
    const start = pos + 1;
    const end = start + block.content.size;
    const chars = keptIn(block);
    blocksSwept += 1;
    if (chars.width > 0 && chars.liveOf(0) > 0) blocksLosingTheirLead += 1;
    else blocksKeepingTheirLead += 1;
    const alone = blockAlone(changed, pos, block);
    /** Each line of the block alone, and where the whole document writes it. */
    const shifts = new Map<number, LineShift>();
    for (let at = start; at <= end; at += 1) {
      if (insideSurrogatePair(changed, at)) continue;
      const settled = start + chars.liveOf(chars.offsetOf(at - start));
      const source = map.toSource(at);
      expect(
        map.toRendered(source),
        `${name}: position ${at} settles to ${settled} (${source.line}:${source.ch})`,
      ).toBe(settled);
      if (settled !== at) {
        positionsInsideDropped += 1;
        continue;
      }
      const inBlock = alone.map.toSource(at + alone.offset);
      const shift = { line: source.line, ch: source.ch - inBlock.ch };
      const first = shifts.get(inBlock.line);
      if (first === undefined) shifts.set(inBlock.line, shift);
      else
        expect(
          shift,
          `${name}: position ${at} sits on line ${inBlock.line} of its block, which the document writes at one line and one column shift`,
        ).toEqual(first);
      positionsBridged += 1;
      const rendered = typedInRendered(alone.doc, at + alone.offset, null);
      const written = typedInSource(alone.text, inBlock);
      if (rendered !== written) {
        const klass = classify(rendered, written);
        expect(
          klass,
          `${name}: position ${at} (${source.line}:${source.ch}) is a member of a recorded class\n  rendered: ${JSON.stringify(rendered)}\n  source:   ${JSON.stringify(written)}`,
        ).not.toBeNull();
        excluded.push({ name, pos: at, klass: klass as string });
        continue;
      }
      expect(written, `${name}: the two views at ${at} (${source.line}:${source.ch})`).toBe(
        rendered,
      );
      positionsAgreeing += 1;
    }
    reached.add(name);
  }

  /** Every fixture's swept blocks, enumerated once so each is a test of its own. */
  const planned = names.map((name) => ({ name, blocks: prepare(name).blocks }));

  for (const fixture of planned) {
    fixture.blocks.forEach((block, index) => {
      it(`${fixture.name} after deleteAtEveryBlockStart, ${block.type} ${index + 1} of ${fixture.blocks.length}: the two views write the same bytes at every text position of the block, every position settles by the kept-character rule, and the block's columns are the document's`, () => {
        sweepBlock(fixture.name, prepare(fixture.name), block.pos);
      }, START_LEG_TIMEOUT_MS);
    });
  }

  it("ran deleteAtEveryBlockStart over every fixture in the index, swept every block of every one of them, reached both sides of the lead clause, and bounded every excluded position positively", () => {
    // Every fixture of the index is planned, and every planned block was swept by its own test.
    expect(planned.map((fixture) => fixture.name).sort()).toEqual([...names].sort());
    expect(blocksSwept).toBe(planned.reduce((total, fixture) => total + fixture.blocks.length, 0));
    expect([...reached].sort()).toEqual(
      planned
        .filter((fixture) => fixture.blocks.length > 0)
        .map((fixture) => fixture.name)
        .sort(),
    );
    // A fixture whose every textblock is a fence or starts with an atom has nothing to delete.
    expect(fixturesChanged).toBeGreaterThan(0);
    expect(fixturesUnchanged).toBeGreaterThan(0);
    expect(blocksSwept).toBeGreaterThan(0);
    // Both sides of the clause: the transaction strips some blocks' leads and leaves others whole.
    expect(blocksLosingTheirLead).toBeGreaterThan(0);
    expect(blocksKeepingTheirLead).toBeGreaterThan(0);
    expect(blocksLosingTheirLead + blocksKeepingTheirLead).toBe(blocksSwept);
    // The dropped-whitespace half of the ownership rule is reached, and the bytes half dominates.
    expect(positionsInsideDropped).toBeGreaterThan(0);
    expect(positionsAgreeing).toBeGreaterThan(positionsInsideDropped);
    // Every position whose bytes were compared was compared on a block bridged to the document.
    expect(positionsBridged).toBe(positionsAgreeing + excluded.length);
    // The exclusions are exactly the three recorded classes, each reached and each a minority.
    expect(new Set(excluded.map((member) => member.klass))).toEqual(
      new Set([PUNCTUATION_EDGED, AUTOLINK_LITERAL, MARK_ENDING_IN_A_LINK]),
    );
    expect(excluded.length).toBeLessThan(positionsAgreeing);
  }, START_LEG_TIMEOUT_MS);
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
