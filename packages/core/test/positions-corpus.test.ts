import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import {
  formatWithMap,
  nodeAt,
  rangeContains,
  ROOT_PATH,
  type PositionMap,
} from "../src/positions.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

interface IndexEntry {
  paragraphStartLines: number[];
}

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<
  string,
  IndexEntry
>;
// The matrix is index.json's own length, never a literal (task 1.2 acceptance). The test below
// asserts the index against the sources on disk, so the index cannot both define and certify the
// coverage claim (docs/lessons.md [0.12.r2d]).
const names = Object.keys(index).sort();

/** Seeded so the 200 sampled positions are the same on every run and in CI. */
const SEED = 0x1a2b3c4d;
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

interface Node {
  type: string;
  children?: Node[];
}

function countNodes(node: Node): number {
  let total = 1;
  for (const child of node.children ?? []) total += countNodes(child);
  return total;
}

function paragraphStartLines(map: PositionMap): number[] {
  return map.entries.filter((e) => e.node.type === "paragraph").map((e) => e.startLine);
}

function sourceOf(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

describe("formatWithMap over fixtures/markdown (task 1.2)", () => {
  it("has index.json listing exactly the .md sources on disk", () => {
    const onDisk = readdirSync(FIXTURES)
      .filter((n) => n.endsWith(".md") && !n.endsWith(".canonical.md"))
      .sort();
    expect(names).toEqual(onDisk);
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)("%s: text is the canonical string format() produces", (name) => {
    const root = parse(sourceOf(name));
    expect(formatWithMap(root).text).toBe(format(root));
  });

  it.each(names)("%s: every paragraph's mapped startLine is index.json's recorded line", (name) => {
    const { map } = formatWithMap(parse(sourceOf(name)));
    expect(paragraphStartLines(map)).toEqual(index[name].paragraphStartLines);
  });

  it("has at least one paragraph line asserted, so the clause above is not vacuous", () => {
    const total = names.reduce((sum, name) => sum + index[name].paragraphStartLines.length, 0);
    expect(total).toBeGreaterThan(0);
    const withNone = names.filter((name) => index[name].paragraphStartLines.length === 0);
    expect(withNone.length).toBeGreaterThan(0);
  });

  it.each(names)("%s: maps every node of the tree, and nothing is unresolved", (name) => {
    const root = parse(sourceOf(name));
    const { map } = formatWithMap(root);
    expect(map.unresolved).toEqual([]);
    expect(Object.keys(map.ranges)).toHaveLength(countNodes(root as unknown as Node));
    expect(map.entries).toHaveLength(Object.keys(map.ranges).length);
    expect(map.ranges[ROOT_PATH]).toEqual({
      startLine: 1,
      startCol: 1,
      endLine: formatWithMap(root).text.split("\n").length,
      endCol: 1,
    });
  });

  it.each(names)("%s: every node's range sits inside its parent's, siblings apart", (name) => {
    const { map } = formatWithMap(parse(sourceOf(name)));
    const byPath = map.ranges;
    for (const entry of map.entries) {
      if (entry.path === ROOT_PATH) continue;
      const parts = entry.path.split(".");
      const parent = byPath[parts.slice(0, -1).join(".")];
      expect(parent).toBeDefined();
      expect(before(parent.startLine, parent.startCol, entry.startLine, entry.startCol)).toBe(true);
      expect(before(entry.endLine, entry.endCol, parent.endLine, parent.endCol)).toBe(true);
      const index_ = Number(parts[parts.length - 1]);
      const previous = byPath[[...parts.slice(0, -1), String(index_ - 1)].join(".")];
      if (index_ > 0 && previous)
        expect(before(previous.endLine, previous.endCol, entry.startLine, entry.startCol)).toBe(
          true,
        );
    }
  });

  it.each(names)(
    `%s: nodeAt over ${SAMPLES} seeded random positions contains the point, or is null on a blank line`,
    (name) => {
      const { text, map } = formatWithMap(parse(sourceOf(name)));
      const lines = text.split("\n");
      const random = seededRandom(SEED + names.indexOf(name));
      let hits = 0;
      for (let sample = 0; sample < SAMPLES; sample++) {
        const line = 1 + Math.floor(random() * lines.length);
        const text_ = lines[line - 1];
        // Columns are character positions: 1..length. Column length + 1 is the line terminator,
        // which the half-open ranges deliberately leave to no node, exactly like a blank line.
        const column = 1 + Math.floor(random() * Math.max(1, text_.length));
        const hit = nodeAt(map, line, column);
        if (hit === null) {
          expect(text_.trim()).toBe("");
          continue;
        }
        hits++;
        expect(rangeContains(hit, line, column)).toBe(true);
        expect(hit.path).not.toBe(ROOT_PATH);
      }
      expect(hits).toBeGreaterThan(0);
    },
  );

  it("has the null case actually occur somewhere in the sample, so it is not vacuous", () => {
    let nulls = 0;
    for (const name of names) {
      const { text, map } = formatWithMap(parse(sourceOf(name)));
      const lines = text.split("\n");
      const random = seededRandom(SEED + names.indexOf(name));
      for (let sample = 0; sample < SAMPLES; sample++) {
        const line = 1 + Math.floor(random() * lines.length);
        const column = 1 + Math.floor(random() * Math.max(1, lines[line - 1].length));
        if (nodeAt(map, line, column) === null) nulls++;
      }
    }
    expect(nulls).toBeGreaterThan(0);
  });

  it.each(names)("%s: every character position of a non-blank line has a node", (name) => {
    const { text, map } = formatWithMap(parse(sourceOf(name)));
    const lines = text.split("\n");
    const missing: string[] = [];
    for (let line = 1; line <= lines.length; line++) {
      const text_ = lines[line - 1];
      if (text_.trim() === "") continue;
      for (let column = 1; column <= text_.length; column++) {
        const hit = nodeAt(map, line, column);
        if (hit === null) missing.push(`${line}:${column}`);
        else expect(rangeContains(hit, line, column)).toBe(true);
      }
    }
    expect(missing).toEqual([]);
  });

  it.each(names)("%s: the map is a pure function of root, which is not mutated", (name) => {
    const root = parse(sourceOf(name));
    const snapshot = JSON.stringify(root);
    const first = formatWithMap(root);
    const second = formatWithMap(root);
    expect(second).toEqual(first);
    expect(JSON.stringify(root)).toBe(snapshot);
  });
});

/** Whether point (`aLine`, `aCol`) is at or before (`bLine`, `bCol`). */
function before(aLine: number, aCol: number, bLine: number, bCol: number): boolean {
  return aLine < bLine || (aLine === bLine && aCol <= bCol);
}
