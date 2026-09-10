import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import type { Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import {
  formatWithMap,
  nodeAt,
  rangeContains,
  ROOT_PATH,
  type PositionMap,
} from "../../core/src/positions.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";
import { cursorMap } from "../src/toggle.js";
import { letterFor, typeInsideEveryBlock, typeSpaceAtEveryBlockEnd } from "./typing-legs.js";

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
    // The count is the index's own length, never a literal (schema-roundtrip.test.ts's rule).
    expect(names.length).toBe(Object.keys(index).length);
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
