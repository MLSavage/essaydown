import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Nodes, Root } from "mdast";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import {
  childPath,
  formatWithMap,
  nodeAt,
  rangeContains,
  ROOT_PATH,
  type PositionEntry,
  type PositionMap,
} from "../../core/src/positions.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";
import { cursorMap } from "../src/toggle.js";
import {
  deleteAtEveryBlockEnd,
  deleteBesideEveryMarkedRun,
  letterFor,
  splitEveryListItemParagraph,
  typeInsideEveryBlock,
  typeSpaceAtEveryBlockEnd,
} from "./typing-legs.js";

/**
 * **The position-map family's editor-output leg** (task 1.27, DECISIONS #review-1-r1 G6, Sol
 * finding 4).
 *
 * The rule task 1.verify.r1 promoted into CLAUDE.md names three round-trip families — parser ↔
 * serializer, mdast ↔ ProseMirror, and the position map — and asks each of them for one leg
 * seeded from the writing surface's own output. Its journal discharged the whole rule with 1.13's
 * `editor fixed point` leg, which exercises the first two families and never calls `formatWithMap`,
 * `nodeAt` or `cursorMap`; `packages/core/test/positions-corpus.test.ts` seeds every one of its
 * cases from `parse(sourceOf(name))`, so the position map has only ever been asked about trees the
 * parser built. This file is the missing leg: the same corpus, the same two typing-shaped
 * transactions (imported from `typing-legs.ts`, shared with 1.13's and 1.25's legs so that all
 * three families type the same thing), and the position map's own three entry points asked about
 * the tree the *editor* hands back.
 *
 * It lives in `packages/editor/test` because it needs `mdastToPM`/`pmToMdast` and `cursorMap`:
 * the editor package depends on core and never the reverse.
 *
 * This is a test-only task. Its assertions are written to fail loudly rather than to be repaired:
 * a defect found here is recorded and handed to the reconciliation, not fixed in this file.
 *
 * Task 1.37 (DECISIONS #review-1-r3 I5, Sol finding 2) adds the family's **deletion** leg, in the
 * second `describe` at the bottom: both legs above seed from `insertText`, and the rule
 * 1.verify.r3 promoted asks every family's editor-seeded leg for at least one destructive
 * transaction. The leg applies 1.36's list split and 1.29's deletion to the live document, and
 * asks the same three entry points about the tree that comes back — this time against the output
 * bytes themselves (micromark's positions on the reparse), because a deletion can move a block
 * and `index.json`'s recorded lines no longer say where the blocks are.
 *
 * Task 1.46 (DECISIONS #review-1-r5 K2) adds the deletion leg's **mark's-neighbour clause**: the
 * corpus seeded by 1.41's `deleteBesideEveryMarkedRun` (the Backspace over the whitespace beside a
 * flanking run, which leaves a letter flush against the run's delimiter and makes the serializer
 * write it as a character reference), plus one hand-seeded astral document, asking `cursorMap`
 * about every position of every text node the deletion left directly against a flanking mark —
 * the node `placeChildren` could not place before 1.46, so `toSource` fell to the end of the run
 * before it and the toggle put a typed character inside the marked run.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

interface IndexEntry {
  paragraphStartLines: number[];
}

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<
  string,
  IndexEntry
>;
// The matrix is index.json's own length, never a literal (task 1.2's convention, kept here).
const names = Object.keys(index).sort();

function read(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

/** Seeded so the sampled positions are the same on every run and in CI (task 1.2's sampler). */
const SEED = 0x5f3a91c7;
const SAMPLES = 200;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mappedParagraphStartLines(map: PositionMap): number[] {
  return map.entries.filter((entry) => entry.node.type === "paragraph").map((e) => e.startLine);
}

/**
 * The 1.2 `nodeAt` clause, now over an editor-seeded root: every sampled position of `text` is
 * either inside the range of the node `nodeAt` answers with, or unowned — and unowned only on a
 * blank line. `hits > 0` keeps it from passing on a map that answers `null` to everything.
 */
function sampleNodeAt(label: string, text: string, map: PositionMap, seed: number): number {
  const lines = text.split("\n");
  const random = seededRandom(seed);
  let hits = 0;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const line = 1 + Math.floor(random() * lines.length);
    const lineText = lines[line - 1];
    // Columns are character positions: 1..length. Column length + 1 is the line terminator, which
    // the half-open ranges deliberately leave to no node, exactly like a blank line.
    const column = 1 + Math.floor(random() * Math.max(1, lineText.length));
    const hit = nodeAt(map, line, column);
    if (hit === null) {
      expect(lineText.trim(), `${label} ${line}:${column} is unowned but not blank`).toBe("");
      continue;
    }
    hits++;
    expect(rangeContains(hit, line, column), `${label} ${line}:${column}`).toBe(true);
    expect(hit.path, label).not.toBe(ROOT_PATH);
  }
  expect(hits, `${label}: every sampled position was unowned`).toBeGreaterThan(0);
  return hits;
}

/**
 * The clauses both legs answer, in one place so that the negative case at the bottom of this file
 * runs the same code the corpus runs: the map is of the string the editor's tree serialises to,
 * that string is a fixed point of `parse`∘`format`, the paragraphs are mapped to the lines
 * `index.json` records (a typed space at a block end is stripped and a typed letter adds no line,
 * so neither leg moves a paragraph), and `nodeAt` places the sample.
 */
function assertPositionMapLeg(
  label: string,
  root: Root,
  text: string,
  map: PositionMap,
  paragraphStartLines: number[],
  seed: number,
): void {
  expect(text, label).toBe(format(root));
  expect(format(parse(text)), label).toBe(text);
  expect(mappedParagraphStartLines(map), label).toEqual(paragraphStartLines);
  sampleNodeAt(label, text, map, seed);
}

/**
 * A map with every line moved down by `by`, keeping the node payloads and the paths.
 *
 * What the negative case at the bottom checks the leg against: the shape of a position map that is
 * internally consistent — `nodeAt` still answers, and its answer still contains the query — and
 * wrong about where the string's lines are, which is the failure the whole leg exists to catch.
 */
function shiftLines(map: PositionMap, by: number): PositionMap {
  const move = <T extends { startLine: number; endLine: number }>(range: T): T => ({
    ...range,
    startLine: range.startLine + by,
    endLine: range.endLine + by,
  });
  return {
    ranges: Object.fromEntries(Object.entries(map.ranges).map(([path, r]) => [path, move(r)])),
    entries: map.entries.map(move),
    unresolved: [...map.unresolved],
  };
}

/**
 * An mdast tree with the source positions `parse` records stripped off.
 *
 * `formatWithMap`'s entries carry the node itself, and the two sides of the block-end comparison
 * below build their trees differently: micromark stamps every node it parses with a `position`
 * (where it was in the *user's* bytes), and a tree that came back from the editor has none, because
 * ProseMirror has nowhere to keep one. Those stamps are not part of the position map — the map's
 * own answer about where a node is, is its range — so they are dropped from both sides before the
 * maps are compared, and everything else about the entries (order, path, range, and the node's own
 * content) is compared exactly.
 */
function withoutSourcePositions<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, inner: unknown) => (key === "position" ? undefined : inner)),
  ) as T;
}

/** `formatWithMap` over the tree the editor hands back for `doc`. */
function mapOfEditorOutput(
  doc: PMNode,
  frontMatter: ReturnType<typeof mdastToPM>["frontMatter"],
): { root: Root; text: string; map: PositionMap } {
  const root = pmToMdast({ doc, frontMatter });
  const { text, map } = formatWithMap(root);
  return { root, text, map };
}

describe("the position-map round-trip family, seeded from the editor's own output", () => {
  const blockEndChecked: string[] = [];
  const inBlockChecked: string[] = [];
  let lettersTyped = 0;

  it("asserts one editor-seeded position map per fixture listed in the index", () => {
    // Only non-emptiness here: `names` *is* `Object.keys(index)`, so comparing the two lengths
    // was `x === x` (task 1.21 F9c, 1.26 G8, and Grok's r2 finding for this file — task 1.32).
    // The coverage claim is the two collectors below, which are what the loop actually checked.
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(`${name}: the position map of the editor's output after a space is typed at every block end`, () => {
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const leg = typeSpaceAtEveryBlockEnd(doc);
      expect(leg.doc.eq(doc), name).toBe(leg.blocks === 0);
      const { root, text, map } = mapOfEditorOutput(leg.doc, frontMatter);

      assertPositionMapLeg(
        `${name} (block end)`,
        root,
        text,
        map,
        index[name].paragraphStartLines,
        SEED + names.indexOf(name),
      );

      // The typed space is stripped at the block's end, so this leg's string is the fixture's own
      // canonical form — and then the whole map has to be the one `formatWithMap` builds from the
      // parser's tree, entry for entry, not merely a map with the same paragraph lines.
      const base = formatWithMap(parse(read(name)));
      expect(text, name).toBe(base.text);
      expect(map.ranges, name).toEqual(base.map.ranges);
      expect(map.unresolved, name).toEqual(base.map.unresolved);
      expect(withoutSourcePositions(map), name).toEqual(withoutSourcePositions(base.map));
      blockEndChecked.push(name);
    });

    it(`${name}: the position map of the editor's output after a letter is typed inside every block`, () => {
      const letter = letterFor(format(parse(read(name))));
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const leg = typeInsideEveryBlock(doc, letter);
      expect(leg.doc.eq(doc), name).toBe(leg.typed === 0);
      const { root, text, map } = mapOfEditorOutput(leg.doc, frontMatter);

      // A letter typed inside a block adds no line, so the recorded paragraph lines still hold —
      // this leg's tree is one no parser in this repo can produce, and the map still places it.
      assertPositionMapLeg(
        `${name} (in block)`,
        root,
        text,
        map,
        index[name].paragraphStartLines,
        SEED + names.indexOf(name),
      );

      // The map's consumer, seeded from the editor: the cursor sitting after a letter the user
      // just typed names the place in the canonical string where that letter is.
      const lines = text.split("\n");
      const cursors = cursorMap(root, leg.doc);
      for (const position of leg.positions) {
        const after = cursors.toSource(position + 1);
        const at = `${name} letter at pm ${position} → ${after.line}:${after.ch}`;
        expect(lines[after.line - 1], at).toBeDefined();
        // `ch` is CodeMirror's 0-based offset, so the cursor after the letter sits at the offset
        // one past it: the letter is the character `ch - 1` of its line.
        expect(lines[after.line - 1][after.ch - 1], at).toBe(letter);
      }
      lettersTyped += leg.typed;
      inBlockChecked.push(name);
    });
  }

  it("ran both legs over every fixture in the index, and typed something in the corpus", () => {
    // Collected by the `it` bodies as they run, so this holds only if each of them reached its
    // assertions — a skipped or silently absent case fails here (task 1.21 F9c's pattern).
    expect(blockEndChecked.sort()).toEqual(names);
    expect(inBlockChecked.sort()).toEqual(names);
    // …and the `cursorMap` clause above is not vacuous: the corpus really was typed into.
    expect(lettersTyped).toBeGreaterThan(0);
  });

  it("the leg can fail: a map whose lines are shifted by one is caught", () => {
    // A hand-built document, not a fixture: two paragraphs, so the second one's line is a fact
    // about the map and not about the string's length. The positive control runs first, so a
    // negative case that throws for some unrelated reason cannot pass as the shift being caught.
    const paragraph = (text: string): PMNode => schema.node("paragraph", null, [schema.text(text)]);
    const doc = schema.node("doc", null, [paragraph("one"), paragraph("two")]);
    const { root, text, map } = mapOfEditorOutput(doc, null);
    expect(text).toBe("one\n\ntwo\n");
    assertPositionMapLeg("negative control", root, text, map, [1, 3], SEED);

    const shifted = shiftLines(map, 1);
    expect(mappedParagraphStartLines(shifted)).toEqual([2, 4]);
    // Both halves of the leg see it: the recorded paragraph lines, and `nodeAt` — which now
    // answers `null` on the document's first line, a line that is not blank.
    expect(() =>
      assertPositionMapLeg("negative case", root, text, shifted, [1, 3], SEED),
    ).toThrowError();
    expect(() => sampleNodeAt("negative case", text, shifted, SEED)).toThrowError();
  });
});

/* ------------------------------------------------------------ the deletion leg (task 1.37) --- */

/**
 * The mdast node types the serializer writes as blocks, on their own lines: the entries whose
 * lines the deletion leg checks against the output bytes. Inline nodes are left to `nodeAt` and
 * the cursor clauses — micromark's text nodes need not split where the editor's did.
 */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "thematicBreak",
  "blockquote",
  "list",
  "listItem",
  "code",
  "html",
  "table",
  "tableRow",
  "tableCell",
  "yaml",
  "definition",
]);

/** The three ProseMirror block types whose content is inline text: the blocks the deletion edits. */
const INLINE_CONTENT = new Set([
  schema.nodes.paragraph,
  schema.nodes.heading,
  schema.nodes.table_cell,
]);

/** The mdast counterparts of {@link INLINE_CONTENT}, in the order `pmToMdast` emits them. */
const INLINE_CONTENT_TYPES = new Set(["paragraph", "heading", "tableCell"]);

/**
 * Every node of `parse(text)` by its path from the root. micromark stamps each node it parses
 * with a `position` — where it sat in the bytes it read — so over the leg's own output this is an
 * independent record of where the output bytes put every block, built without the position map.
 */
function reparsedByPath(text: string): Map<string, Nodes> {
  const out = new Map<string, Nodes>();
  const walk = (node: Nodes, path: string): void => {
    out.set(path, node);
    if ("children" in node)
      node.children.forEach((child, i) => walk(child as Nodes, childPath(path, i)));
  };
  walk(parse(text), ROOT_PATH);
  return out;
}

/** micromark's position of a reparsed node, as the leg's assertions need it defined. */
function positionOf(node: Nodes, at: string): NonNullable<Nodes["position"]> {
  expect(node.position, `${at}: the reparsed node has no position`).toBeDefined();
  return node.position as NonNullable<Nodes["position"]>;
}

/** The last leaf of a reparsed node, or the node itself when it has no children. */
function lastLeaf(node: Nodes): Nodes {
  let current: Nodes = node;
  while ("children" in current && current.children.length > 0)
    current = current.children[current.children.length - 1] as Nodes;
  return current;
}

/** Whether `path` is `ancestor` itself or lies below it. */
function isAncestorOrSelf(ancestor: string, path: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}.`);
}

/**
 * **Clause 1 of the deletion leg: the map's line for every block agrees with the block's position
 * in the output bytes.** For every block entry of `map`, the node `parse(text)` has at the same
 * path is of the same type and micromark places it on the same first and last line. Columns are
 * not compared: micromark's `tableCell` spans the cell's delimiters where the map places the cell
 * inside them (`positions-corpus.test.ts`, "inside its own delimiters"), and the clause is about
 * where the blocks *are*, which a deletion can move. Returns how many blocks it compared.
 */
function assertBlockLinesAgree(label: string, map: PositionMap, text: string): number {
  const reparsed = reparsedByPath(text);
  let blocks = 0;
  for (const entry of map.entries) {
    if (entry.path === ROOT_PATH || !BLOCK_TYPES.has(entry.node.type)) continue;
    const at = `${label}: ${entry.node.type} at ${entry.path}`;
    const node = reparsed.get(entry.path);
    expect(node?.type, at).toBe(entry.node.type);
    const position = positionOf(node as Nodes, at);
    expect([position.start.line, position.end.line], at).toEqual([entry.startLine, entry.endLine]);
    blocks += 1;
  }
  return blocks;
}

/**
 * **Clause 2 of the deletion leg: `nodeAt` of every mapped position returns the block that owns
 * it.** For every entry of `map`, the answer at the entry's first and at its last position is the
 * entry itself or a node inside it — the innermost owner, whose ancestors include the block. A
 * zero-width entry (a childless table cell, the one node the map places at a point) contains
 * nothing, so its point is asked to belong to an ancestor — the row — and not to nothing. Returns
 * both counts, so the caller can say which shapes the corpus reached.
 */
function assertNodeAtOwnership(
  label: string,
  map: PositionMap,
): { owned: number; zeroWidth: number } {
  let owned = 0;
  let zeroWidth = 0;
  for (const entry of map.entries) {
    if (entry.path === ROOT_PATH) continue;
    const at = `${label}: ${entry.node.type} at ${entry.path}`;
    if (!rangeContains(entry, entry.startLine, entry.startCol)) {
      const hit = nodeAt(map, entry.startLine, entry.startCol);
      expect(hit, `${at} (zero-width)`).not.toBeNull();
      const owner = (hit as PositionEntry).path;
      expect(owner !== entry.path && isAncestorOrSelf(owner, entry.path), `${at} → ${owner}`).toBe(
        true,
      );
      zeroWidth += 1;
      continue;
    }
    const points: [number, number][] = [
      [entry.startLine, entry.startCol],
      [entry.endLine, entry.endCol - 1],
    ];
    for (const [line, column] of points) {
      const hit = nodeAt(map, line, column);
      expect(hit, `${at} ${line}:${column}`).not.toBeNull();
      const owner = (hit as PositionEntry).path;
      expect(isAncestorOrSelf(entry.path, owner), `${at} ${line}:${column} → ${owner}`).toBe(true);
    }
    owned += 1;
  }
  return { owned, zeroWidth };
}

/** One inline-content block of a ProseMirror document: the node and the position before it. */
interface InlineBlock {
  node: PMNode;
  pos: number;
}

/** The paragraphs, headings and table cells of `doc`, in document order, empty ones included. */
function inlineBlocks(doc: PMNode): InlineBlock[] {
  const out: InlineBlock[] = [];
  doc.descendants((node, pos) => {
    if (!INLINE_CONTENT.has(node.type)) return true;
    out.push({ node, pos });
    return false;
  });
  return out;
}

/**
 * The inline-content blocks of the editor's document paired with the map entries of their mdast
 * counterparts, in order. The pairing rule is `toggle.ts`'s own (`isPlaceholder`): an empty
 * paragraph is the one ProseMirror block `pmToMdast` drops, so it is skipped without consuming
 * an entry; every other block is paired with the next paragraph, heading or cell entry, and the
 * two sequences are asserted to be the same length with matching types, so a block the
 * conversion lost or invented fails here rather than shifting every later pair.
 */
function pairWithEntries(
  label: string,
  blocks: readonly InlineBlock[],
  map: PositionMap,
): Map<number, PositionEntry> {
  const entries = map.entries.filter((entry) => INLINE_CONTENT_TYPES.has(entry.node.type));
  const kept = blocks
    .map((block, index) => ({ block, index }))
    .filter(
      ({ block }) => !(block.node.type === schema.nodes.paragraph && block.node.content.size === 0),
    );
  expect(kept.length, `${label}: inline blocks kept by the conversion`).toBe(entries.length);
  const pairs = new Map<number, PositionEntry>();
  kept.forEach(({ block, index }, i) => {
    const entry = entries[i];
    const expected =
      block.node.type === schema.nodes.paragraph
        ? "paragraph"
        : block.node.type === schema.nodes.heading
          ? "heading"
          : "tableCell";
    expect(
      entry.node.type,
      `${label}: block ${index} (${block.node.type.name}) ↔ ${entry.path}`,
    ).toBe(expected);
    pairs.set(index, entry);
  });
  return pairs;
}

/**
 * **Clause 3's oracle: where the output bytes put the end of one block.** The cursor at the end of
 * a block's content in the editor is, in the bytes, one past the last byte of the block's last
 * leaf — micromark's `position.end` of that leaf on the reparse. For a text node that is one past
 * its last character, which is *before* a closing delimiter (`*`, `~~`, a link's `](url)`) and
 * before a cell's padding, as `cursorMap`'s spelling tables place it. For an inline atom (an
 * image, an inline tag) and for an inline-code run it is the leaf's own end — after `)`, after
 * `</i>`, after the closing backtick fence: `cursorMap`'s third clause answers the caret after a
 * trailing leaf with the leaf's end (task 1.52, DECISIONS #030 Decision 2 and #031, the deletion
 * side: a paragraph left ending in an atom by the deletion of the text after it). A block with no
 * content (a cell emptied by the deletion) has no bytes of its own, and its place is the point
 * the map keeps for it.
 */
function byteEndOf(
  entry: PositionEntry,
  reparsed: Nodes,
  at: string,
): { line: number; ch: number } {
  if (!("children" in reparsed) || reparsed.children.length === 0)
    return { line: entry.startLine, ch: entry.startCol - 1 };
  const position = positionOf(lastLeaf(reparsed), at);
  return { line: position.end.line, ch: position.end.column - 1 };
}

/** The last code point of a block's last text node, or `null` when the block does not end in text. */
function lastCharacterOf(block: PMNode): string | null {
  const last = block.lastChild;
  if (last === null || !last.isText) return null;
  return [...(last.text as string)].pop() ?? null;
}

/**
 * How many editor positions an mdast inline block's children would occupy — `toggle.ts`'s
 * `inlineWidth` rule, restated here so the leg can tell a block whose end the conversion moved
 * (the editor holds more than the tree) from one it carried whole: text and inline code are as
 * wide as their value, a mark as wide as its children, every other leaf one position.
 */
function mdastInlineWidth(node: Nodes): number {
  if (node.type === "text" || node.type === "inlineCode") return node.value.length;
  if (!("children" in node)) return 1;
  return node.children.reduce((total, child) => total + mdastInlineWidth(child as Nodes), 0);
}

/**
 * The document the deletion leg hands to the map: 1.36's list split first (every list item's
 * first paragraph split at its end, which leaves the item an empty second paragraph), then 1.29's
 * deletion (the continuation after every hard break, then the last character of every block's
 * last text run) over the split document. Two destructive transactions of different kinds — a
 * split and a deletion — in one live document; the split runs first so that the deletion's
 * block-by-block pairing (it never adds or removes a block) is made against the document it ran
 * on.
 */
function deletionLegDocument(doc: PMNode): {
  split: ReturnType<typeof splitEveryListItemParagraph>;
  deleted: ReturnType<typeof deleteAtEveryBlockEnd>;
} {
  const split = splitEveryListItemParagraph(doc);
  const deleted = deleteAtEveryBlockEnd(split.doc);
  return { split, deleted };
}

/** The marks whose runs `encodeInfo` decides about — `typing-legs.ts`'s own list, restated. */
const FLANKING_MARKS = [schema.marks.emphasis, schema.marks.strong, schema.marks.delete];

/** One text node of the editor's document that sits directly against a flanking-marked run. */
interface MarkNeighbour {
  /** The node's text, byte for byte. */
  text: string;
  /** The ProseMirror position before its first character. */
  start: number;
}

/**
 * The text nodes of `doc`'s inline-content blocks that are directly against a flanking mark: an
 * unmarked (for that mark) text child whose next or previous sibling carries the mark — the
 * neighbour `containerPhrasing` encodes when the run's inner edge is punctuation or whitespace.
 * Found from the editor's own tree, not from the bytes, so a neighbour the map lost is still
 * asked about.
 */
function markNeighbours(doc: PMNode): MarkNeighbour[] {
  const out = new Map<number, MarkNeighbour>();
  doc.descendants((node, pos) => {
    if (!INLINE_CONTENT.has(node.type)) return true;
    const children: PMNode[] = [];
    const starts: number[] = [];
    node.forEach((child, offset) => {
      children.push(child);
      starts.push(pos + 1 + offset);
    });
    children.forEach((child, index) => {
      if (!child.isText) return;
      const beside = [children[index - 1], children[index + 1]].filter(
        (sibling): sibling is PMNode => sibling !== undefined,
      );
      const against = FLANKING_MARKS.some(
        (mark) =>
          mark.isInSet(child.marks) === undefined &&
          beside.some((sibling) => mark.isInSet(sibling.marks) !== undefined),
      );
      if (against) out.set(starts[index], { text: child.text as string, start: starts[index] });
    });
    return false;
  });
  return [...out.values()];
}

/** Whether the position `offset` units into `text` falls between the two units of a surrogate pair. */
function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Whether `a` is at or before `b` in the source. */
function sourceLE(a: { line: number; ch: number }, b: { line: number; ch: number }): boolean {
  return a.line < b.line || (a.line === b.line && a.ch <= b.ch);
}

/**
 * **The mark's-neighbour clause** (task 1.46): for every text node the deletion left directly
 * against a flanking mark, `toSource` is monotone over the node's positions (its start, after
 * each unit, its end — the position between a pair's two units excluded, as the editor never
 * offers it) and `toRendered` takes each answer back to the position it came from. Returns how
 * many neighbours were asked about and how many of them the bytes hold as a character reference,
 * so the caller can assert the corpus reached both.
 */
function assertMarkNeighbourCursors(
  label: string,
  doc: PMNode,
  root: Root,
  text: string,
): { neighbours: number; encoded: number } {
  const cursors = cursorMap(root, doc);
  const lines = text.split("\n");
  let encoded = 0;
  const neighbours = markNeighbours(doc);
  for (const { text: nodeText, start } of neighbours) {
    const at = `${label}: the neighbour ${JSON.stringify(nodeText)} at ${start}`;
    let previous: { line: number; ch: number } | null = null;
    let sawReference = false;
    for (let offset = 0; offset <= nodeText.length; offset += 1) {
      if (splitsPair(nodeText, offset)) continue;
      const pos = start + offset;
      const source = cursors.toSource(pos);
      if (previous !== null) expect(sourceLE(previous, source), `${at}, ${pos}`).toBe(true);
      previous = source;
      expect(cursors.toRendered(source), `${at}, ${pos} → ${source.line}:${source.ch}`).toBe(pos);
      // The bytes at the answer: a position after a character the serializer encoded sits right
      // after its `;`, a reference this node's own text does not hold.
      if (offset > 0 && lines[source.line - 1].slice(0, source.ch).endsWith(";")) {
        const before = lines[source.line - 1].slice(0, source.ch);
        if (/&#x[0-9A-F]+;$/.test(before)) sawReference = true;
      }
    }
    if (sawReference) encoded += 1;
  }
  return { neighbours: neighbours.length, encoded };
}

describe("the position-map round-trip family, seeded from the editor's own output after deletion (task 1.37)", () => {
  const deletionChecked: string[] = [];
  let fixturesTheDeletionChanged = 0;
  let fixturesLeftUnchanged = 0;
  let itemsSplit = 0;
  let blocksCompared = 0;
  let zeroWidthEntries = 0;
  let cursorsChecked = 0;
  /**
   * The two shapes of clause 3 where the cursor sits **past every node the correspondence
   * knows**, counted so that the reach assertion after the loop can say the corpus held both.
   * `cursorMap` pairs the editor's inline nodes with the mdast block's children by their widths,
   * so a block whose end the conversion moved (a `hard_break` left last, the tree 1.29 is about;
   * trailing whitespace the strip drops) has editor positions no inline correspondence covers,
   * and the empty paragraph the split opens inside a list item is a placeholder no
   * correspondence covers at all; both are answered by `toSource`'s second clause (task 1.43)
   * with the byte end of what precedes them, as the ordinary assertions below check.
   */
  let blocksEndingPastCorrespondence = 0;
  let splitParagraphsPastCorrespondence = 0;
  /** The mark's-neighbour clause's reach: fixtures with a neighbour, and encoded neighbours. */
  const fixturesWithMarkNeighbours: string[] = [];
  let markNeighboursChecked = 0;
  let encodedNeighboursChecked = 0;
  const neighbourChecked: string[] = [];

  for (const name of names) {
    it(`${name}: the cursor map over every text node the deletion beside every marked run left against a flanking mark (task 1.46)`, () => {
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const deleted = deleteBesideEveryMarkedRun(doc);
      // Presence: the transaction changed the document exactly where it had a space to take.
      expect(deleted.doc.eq(doc), name).toBe(deleted.deleted === 0);
      const { root, text, map } = mapOfEditorOutput(deleted.doc, frontMatter);
      const label = `${name} (mark's neighbour)`;
      expect(text, label).toBe(format(root));
      expect(format(parse(text)), label).toBe(text);
      // The whole map, first: the neighbour is placed, like every other node.
      expect(map.unresolved, label).toEqual([]);
      const { neighbours, encoded } = assertMarkNeighbourCursors(label, deleted.doc, root, text);
      if (neighbours > 0) fixturesWithMarkNeighbours.push(name);
      markNeighboursChecked += neighbours;
      encodedNeighboursChecked += encoded;
      neighbourChecked.push(name);
    });
  }

  it("the hand-seeded astral document `~~a.~~&#x1F600;`: the neighbour is one surrogate pair written as one reference (task 1.46)", () => {
    // Asserted here by hand until 1.47's `astral-neighbour.md` joins the index: the same clause,
    // over the document the editor builds for the parser's tree of the astral shape.
    const { doc, frontMatter } = mdastToPM(parse("~~a.~~&#x1F600;\n"));
    const deleted = deleteBesideEveryMarkedRun(doc);
    expect(deleted.deleted).toBe(0);
    const { root, text, map } = mapOfEditorOutput(deleted.doc, frontMatter);
    expect(text).toBe("~~a.~~&#x1F600;\n");
    expect(map.unresolved).toEqual([]);
    const { neighbours, encoded } = assertMarkNeighbourCursors("astral", deleted.doc, root, text);
    expect(neighbours).toBe(1);
    expect(encoded).toBe(1);
    // The pair's two units are one ProseMirror node of two positions; the position between them
    // is the one the clause skips, and its answer is the reference's end all the same.
    const cursors = cursorMap(root, deleted.doc);
    const start = markNeighbours(deleted.doc)[0].start;
    // The boundary after `a.` belongs to the run per `$pos.marks()` (`delete` is inclusive), so the
    // source caret lands inside the closing `~~` (DECISIONS #review-1-r6 L6, #033).
    expect(cursors.toSource(start)).toEqual({ line: 1, ch: "~~a.".length });
    expect(cursors.toSource(start + 1)).toEqual({ line: 1, ch: "~~a.~~&#x1F600;".length });
    expect(cursors.toSource(start + 2)).toEqual({ line: 1, ch: "~~a.~~&#x1F600;".length });
  });

  it("the hand-seeded documents `alpha <i>beta</i> y` and `a `+\"`cd`\"+``: a block the deletion leaves ending in an inline atom, or in an inline-code run, is answered with that leaf's end in the bytes (task 1.52, DECISIONS #031's deletion-side member of L5)", () => {
    // The corpus reaches neither shape (no fixture's last text run follows an atom or is an
    // inline-code run), so the oracle's non-text leaves are pinned here by hand: the deletion
    // takes `y` and the conversion strips the space, leaving the paragraph ending in `</i>`;
    // and it takes `d`, leaving the run `c`, whose caret is after the closing fence.
    const cases = [
      { source: "alpha <i>beta</i> y\n", text: "alpha <i>beta</i>\n", ch: "alpha <i>beta</i>".length },
      { source: "a `cd`\n", text: "a `c`\n", ch: "a `c`".length },
    ];
    for (const { source, text: expectedText, ch } of cases) {
      const { doc, frontMatter } = mdastToPM(parse(source));
      const deleted = deleteAtEveryBlockEnd(doc);
      expect(deleted.lastChars, source).toBe(1);
      const { root, text, map } = mapOfEditorOutput(deleted.doc, frontMatter);
      expect(text, source).toBe(expectedText);
      const entry = map.entries.find((candidate) => candidate.path === "0") as PositionEntry;
      const reparsed = reparsedByPath(text).get("0") as Nodes;
      expect(lastLeaf(reparsed).type, source).not.toBe("text");
      const expected = byteEndOf(entry, reparsed, source);
      expect(expected, source).toEqual({ line: 1, ch });
      const paragraph = deleted.doc.firstChild as PMNode;
      const end = 1 + paragraph.content.size;
      expect(cursorMap(root, deleted.doc).toSource(end), source).toEqual(expected);
    }
  });

  for (const name of names) {
    it(`${name}: the position map of the editor's output after deletion — every list item's first paragraph split, then the continuation after every hard break and the last character of every block's last run deleted`, () => {
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const { split, deleted } = deletionLegDocument(doc);
      // Presence: each transaction changed the document exactly where it had something to do.
      expect(split.doc.eq(doc), name).toBe(split.items === 0);
      expect(deleted.doc.eq(split.doc), name).toBe(deleted.afterBreaks + deleted.lastChars === 0);
      if (!deleted.doc.eq(split.doc)) fixturesTheDeletionChanged += 1;
      itemsSplit += split.items;

      const { root, text, map } = mapOfEditorOutput(deleted.doc, frontMatter);
      const label = `${name} (deletion)`;
      // `format(root)` is a parse∘format fixed point, and the map is of that string.
      expect(text, label).toBe(format(root));
      expect(format(parse(text)), label).toBe(text);

      // Clause 1 and clause 2, over every block and every entry of this fixture's map.
      blocksCompared += assertBlockLinesAgree(label, map, text);
      zeroWidthEntries += assertNodeAtOwnership(label, map).zeroWidth;

      // The absence case: a fixture neither transaction touched yields the very map the
      // insertion-free conversion does — text and map alike, entry for entry (both trees came
      // through the editor, so neither carries micromark's source stamps and the comparison is
      // exact).
      if (deleted.doc.eq(doc)) {
        fixturesLeftUnchanged += 1;
        const base = formatWithMap(pmToMdast(mdastToPM(parse(read(name)))));
        expect(text, label).toBe(base.text);
        expect(map, label).toEqual(base.map);
      }

      // Clause 3: the cursor at the end of every changed block maps to the position the output
      // bytes put it at. "Changed" is decided block by block against the document the deletion
      // ran on (it neither adds nor removes a block); the split's first paragraphs are among
      // them wherever they end in text, because the deletion takes their last character too.
      // Shape (a) of the past-correspondence case is in here: a block the conversion narrowed
      // (a dropped trailing `hard_break`, stripped whitespace) has its cursor past every inline
      // node the map knows, and the answer is still the byte end of what precedes it.
      const before = inlineBlocks(split.doc);
      const after = inlineBlocks(deleted.doc);
      expect(after.length, label).toBe(before.length);
      const pairs = pairWithEntries(label, after, map);
      const reparsed = reparsedByPath(text);
      const cursors = cursorMap(root, deleted.doc);
      const lines = text.split("\n");
      after.forEach(({ node, pos }, index) => {
        const changed = !node.eq(before[index].node);
        const entry = pairs.get(index);
        if (!changed || entry === undefined) return;
        const at = `${label}: cursor at the end of ${node.type.name} ${index} (${entry.path})`;
        const end = pos + 1 + node.content.size;
        const expected = byteEndOf(entry, reparsed.get(entry.path) as Nodes, at);
        // The conversion only ever drops or moves what the editor holds, never adds to it.
        const width = mdastInlineWidth(entry.node);
        expect(width, at).toBeLessThanOrEqual(node.content.size);
        if (width < node.content.size) blocksEndingPastCorrespondence += 1;
        else {
          // The bytes themselves: the character before the cursor is the block's last character
          // (nothing was dropped, so the editor's last character is the one the bytes end in).
          const last = lastCharacterOf(node);
          if (last !== null) {
            const line = lines[expected.line - 1];
            expect(line.slice(expected.ch - last.length, expected.ch), at).toBe(last);
          }
        }
        expect(cursors.toSource(end), at).toEqual(expected);
        cursorsChecked += 1;
      });

      // Shape (b), the split's own cursor: inside the empty paragraph the split opened, the bytes
      // put the cursor at the end of the paragraph before it — `toggle.test.ts`'s "a position no
      // node owns" rule — and `toSource` answers so through the item's correspondence, which
      // covers the placeholder no correspondence of its own does.
      deleted.doc.descendants((node, pos) => {
        if (node.type !== schema.nodes.list_item) return true;
        const first = node.firstChild;
        const second = node.maybeChild(1);
        if (
          first === null ||
          second === null ||
          second === undefined ||
          first.type !== schema.nodes.paragraph ||
          second.type !== schema.nodes.paragraph ||
          second.content.size !== 0
        )
          return true;
        const firstIndex = after.findIndex((block) => block.pos === pos + 1);
        const entry = pairs.get(firstIndex);
        expect(
          entry,
          `${label}: the split item at ${pos} has a paired first paragraph`,
        ).toBeDefined();
        const path = (entry as PositionEntry).path;
        const at = `${label}: cursor inside the empty paragraph split off ${path}`;
        const position = positionOf(reparsed.get(path) as Nodes, at);
        splitParagraphsPastCorrespondence += 1;
        expect(cursors.toSource(pos + 1 + first.nodeSize + 1), at).toEqual({
          line: position.end.line,
          ch: position.end.column - 1,
        });
        return true;
      });

      deletionChecked.push(name);
    });
  }

  it("ran the deletion leg over every fixture in the index, and the corpus reached both sides of every clause", () => {
    expect(deletionChecked.sort()).toEqual(names);
    // Non-vacuous reach, from the loop and never a literal: the deletion changed some fixture,
    // left some fixture unchanged (the presence/absence pair), and the split reached some item.
    expect(fixturesTheDeletionChanged).toBeGreaterThan(0);
    expect(fixturesLeftUnchanged).toBeGreaterThan(0);
    expect(itemsSplit).toBeGreaterThan(0);
    // …and each clause was asked something: blocks were compared against micromark, a zero-width
    // entry (a childless cell) was met, and cursors were placed at changed blocks and inside a
    // split item's empty paragraph.
    expect(blocksCompared).toBeGreaterThan(0);
    expect(zeroWidthEntries).toBeGreaterThan(0);
    expect(cursorsChecked).toBeGreaterThan(0);
    // Both past-correspondence shapes of clause 3 are in the corpus, so the clause is not
    // vacuous there: a block the deletion left ending past its correspondence (the tree 1.29's
    // deletion exists to build), and an item the split gave an empty second paragraph.
    expect(blocksEndingPastCorrespondence).toBeGreaterThan(0);
    expect(splitParagraphsPastCorrespondence).toBeGreaterThan(0);
  });

  it("ran the mark's-neighbour clause over every fixture in the index, and the corpus reached an encoded neighbour — strikethrough-punctuation.md among the fixtures with one", () => {
    expect(neighbourChecked.sort()).toEqual(names);
    // Non-vacuous reach, from the loop and never a literal: some text node sat against a flanking
    // mark, some of them were written as a character reference, and the fixture 1.40 built for
    // this shape (`~~a.~~&#x62;`) is one of the fixtures reached.
    expect(markNeighboursChecked).toBeGreaterThan(0);
    expect(encodedNeighboursChecked).toBeGreaterThan(0);
    expect(fixturesWithMarkNeighbours).toContain("strikethrough-punctuation.md");
  });

  it("the deletion leg can fail: a map whose lines are shifted by one is caught by the byte clause", () => {
    // The shape of the case above it: a hand-built two-paragraph document, the positive control
    // first, then the same clause against a map that is internally consistent and wrong about
    // where the lines are. Clause 1 is the byte anchor and goes red; clause 2 does not, by design
    // (`nodeAt` still answers, and its answer still contains the query — the shifted map is
    // consistent with itself), which is why clause 1 exists beside it.
    const paragraph = (text: string): PMNode => schema.node("paragraph", null, [schema.text(text)]);
    const doc = schema.node("doc", null, [paragraph("one"), paragraph("two")]);
    const { text, map } = mapOfEditorOutput(doc, null);
    expect(assertBlockLinesAgree("positive control", map, text)).toBe(2);
    expect(assertNodeAtOwnership("positive control", map).owned).toBeGreaterThan(0);

    const shifted = shiftLines(map, 1);
    expect(() => assertBlockLinesAgree("negative case", shifted, text)).toThrowError();
  });
});
