import { describe, expect, it } from "vitest";
import { parse } from "../src/parse.js";
import {
  formatWithMap,
  nodeAt,
  spellingIndex,
  spellingOffsets,
  spellingPoint,
  type SpellingTable,
} from "../src/positions.js";

/**
 * **The encoded neighbour of an attention run in the position map** (task 1.46, DECISIONS
 * #review-1-r5 K2 — Claude finding 2, Sol finding 2, Grok finding 1; the `[1.40, found outside
 * scope]` backlog line's trigger).
 *
 * `mdast-util-to-markdown/lib/util/container-phrasing.js` encodes the character beside an
 * attention run *after* the neighbouring text child's handler returned, and task 1.45's wrapper
 * widens that encoding to a whole scalar; `placeChildren` (`positions.ts`) looked the child's
 * emission up by `indexOf` and could not find it, so the node was `unresolved`, `cursorMap` had no
 * range and no spelling table for it, and the toggle put a typed character inside the run. The
 * guards below are enumerated from the fix's diff: `rewrittenEmissions`' three forms (first code
 * point, last, both — the one-code-point value collapsing to the whole reference), the
 * earliest-match rule of `locateEmission`, and `spellingOffsets`' surrogate-pair rule at the
 * first, middle and last position of a text node.
 *
 * The seven source strings are the task's own list — both sides, three marks, one BMP and two
 * astral neighbours, a one-character neighbour and a longer one — each asserted in the journal
 * against its string. Every expected offset is computed from where the reference sits in the
 * bytes, never copied from one run.
 */

/** The node types whose closing and opening delimiters `encodeInfo` decides about. */
type Mark = "emphasis" | "strong" | "delete";

/** One neighbour of one run: where its text node is, what it holds, and the reference it carries. */
interface Neighbour {
  /** The text node's path in the parsed tree. */
  path: string;
  /** The text node's `value` — the decoded characters. */
  value: string;
  /** The character reference the bytes hold for the encoded code point. */
  reference: string;
  /** Which occurrence of `reference` in the bytes is this neighbour's (a string can hold two). */
  occurrence: "first" | "last";
}

interface Case {
  source: string;
  mark: Mark;
  side: "closing" | "opening" | "both";
  neighbours: Neighbour[];
}

const CASES: Case[] = [
  {
    source: "x *a.*&#x62;\n",
    mark: "emphasis",
    side: "closing",
    neighbours: [{ path: "0.2", value: "b", reference: "&#x62;", occurrence: "first" }],
  },
  {
    source: "x **a.**&#x62;\n",
    mark: "strong",
    side: "closing",
    neighbours: [{ path: "0.2", value: "b", reference: "&#x62;", occurrence: "first" }],
  },
  {
    source: "~~a.~~&#x62;\n",
    mark: "delete",
    side: "closing",
    neighbours: [{ path: "0.1", value: "b", reference: "&#x62;", occurrence: "first" }],
  },
  {
    source: "&#x62;*.a* x\n",
    mark: "emphasis",
    side: "opening",
    neighbours: [{ path: "0.0", value: "b", reference: "&#x62;", occurrence: "first" }],
  },
  {
    source: "~~a.~~&#x1F600;\n",
    mark: "delete",
    side: "closing",
    neighbours: [{ path: "0.1", value: "😀", reference: "&#x1F600;", occurrence: "first" }],
  },
  {
    source: "x &#x10400;*(a)*\n",
    mark: "emphasis",
    side: "opening",
    neighbours: [{ path: "0.0", value: "x 𐐀", reference: "&#x10400;", occurrence: "first" }],
  },
  {
    source: "&#x1F600;~~(a.)~~&#x1F600;\n",
    mark: "delete",
    side: "both",
    neighbours: [
      { path: "0.0", value: "😀", reference: "&#x1F600;", occurrence: "first" },
      { path: "0.2", value: "😀", reference: "&#x1F600;", occurrence: "last" },
    ],
  },
];

/** How many nodes of `type` the tree holds, anywhere. */
function countType(node: { type: string; children?: unknown[] }, type: string): number {
  return (
    (node.type === type ? 1 : 0) +
    ((node.children ?? []) as (typeof node)[]).reduce((sum, child) => sum + countType(child, type), 0)
  );
}

/** Where the neighbour's reference starts and ends in `text` (offsets, one line). */
function referenceSpan(text: string, neighbour: Neighbour): { start: number; end: number } {
  const start =
    neighbour.occurrence === "first"
      ? text.indexOf(neighbour.reference)
      : text.lastIndexOf(neighbour.reference);
  expect(start, `${neighbour.reference} in ${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
  return { start, end: start + neighbour.reference.length };
}

/** The index in `value` of the code point the reference spells, and how many units it takes. */
function encodedIndex(value: string, reference: string): { index: number; units: number } {
  const code = Number.parseInt(reference.slice(3, -1), 16);
  const spelled = String.fromCodePoint(code);
  const points = [...value];
  const first = points[0] === spelled;
  const index = first ? 0 : value.length - spelled.length;
  expect(first || points[points.length - 1] === spelled, `${reference} is an edge of ${value}`).toBe(
    true,
  );
  return { index, units: spelled.length };
}

function expectMonotone(table: SpellingTable): void {
  for (let i = 0; i < table.ends.length; i += 1) {
    expect(table.ends[i]).toBeGreaterThanOrEqual(table.starts[i]);
    expect(table.starts[i + 1]).toBeGreaterThanOrEqual(table.ends[i]);
  }
}

describe("an attention run's encoded neighbour is placed (task 1.46, K2)", () => {
  for (const { source, mark, side, neighbours } of CASES) {
    const title = `${JSON.stringify(source.trimEnd())} (${mark}, ${side})`;

    it(`${title}: the bytes are a fixed point holding one ${mark}, and nothing is unresolved`, () => {
      const root = parse(source);
      const { text, map } = formatWithMap(root);
      expect(text).toBe(source);
      expect(countType(root, mark)).toBe(1);
      expect(map.unresolved).toEqual([]);
    });

    for (const neighbour of neighbours) {
      const where = `${title}, the neighbour at ${neighbour.path}`;

      it(`${where}: its range covers the reference, and nodeAt inside the reference answers it`, () => {
        const { text, map } = formatWithMap(parse(source));
        const entry = map.entries.find((candidate) => candidate.path === neighbour.path);
        expect(entry).toBeDefined();
        if (entry === undefined) return;
        expect(entry.node.type).toBe("text");
        expect((entry.node as { value: string }).value).toBe(neighbour.value);
        const { start, end } = referenceSpan(text, neighbour);
        // The found emission's length is the rewritten string's: the range reaches over `&…;`.
        expect(entry.startLine).toBe(1);
        expect(entry.endLine).toBe(1);
        expect(entry.startCol - 1).toBeLessThanOrEqual(start);
        expect(entry.endCol - 1).toBeGreaterThanOrEqual(end);
        // The first, a middle and the last column of the reference all belong to the text node.
        for (const offset of [start, start + 3, end - 1]) {
          const hit = nodeAt(map, 1, offset + 1);
          expect(hit?.path, `column ${offset + 1}`).toBe(neighbour.path);
        }
      });

      it(`${where}: the spelling table places the encoded character over the reference, its neighbours flush against it`, () => {
        const { text, spellings } = formatWithMap(parse(source));
        const table = spellings[neighbour.path];
        expect(table).toBeDefined();
        if (table === undefined) return;
        const { start, end } = referenceSpan(text, neighbour);
        const { index, units } = encodedIndex(neighbour.value, neighbour.reference);
        expect(table.starts).toHaveLength(neighbour.value.length + 1);
        expect(table.ends).toHaveLength(neighbour.value.length);
        // The encoded character (its leading unit, for a pair) owns the whole reference.
        expect(table.starts[index]).toBe(start);
        expect(table.ends[index]).toBe(end);
        // A pair's trailing unit is the zero-width item at the reference's end.
        if (units === 2) {
          expect(table.starts[index + 1]).toBe(end);
          expect(table.ends[index + 1]).toBe(end);
        }
        // The character before it ends where the reference starts; the character after it (or
        // the end sentinel) starts where the reference ends.
        if (index > 0) expect(table.ends[index - 1]).toBe(start);
        expect(table.starts[index + units]).toBe(end);
        expectMonotone(table);
      });
    }
  }

  it("the inner edge a handler encoded is placed the same way (`x *a&#x20;*&#x62;`: both rewrites on one run)", () => {
    const source = "x *a&#x20;*&#x62;\n";
    const { text, map, spellings } = formatWithMap(parse(source));
    expect(text).toBe(source);
    expect(map.unresolved).toEqual([]);
    // The run's text `a ` has its last code point (the space) written as a reference by the
    // emphasis handler itself — the same rewrite shape, caught by the same retry.
    const inner = spellings["0.1.0"];
    expect(inner).toBeDefined();
    const space = text.indexOf("&#x20;");
    expect(inner?.starts).toEqual([space - 1, space, space + "&#x20;".length]);
    expect(inner?.ends).toEqual([space, space + "&#x20;".length]);
  });

  it("the earliest match wins: a later repeated literal is never mistaken for the encoded child (`x *a.*&#x62;c[bc](u)`)", () => {
    const source = "x *a.*&#x62;c[bc](u)\n";
    const { text, map } = formatWithMap(parse(source));
    expect(text).toBe(source);
    expect(map.unresolved).toEqual([]);
    // The neighbour `bc` is written `&#x62;c` right after the run; the literal `bc` later in the
    // string is the link's text, and belongs to the link's child, not to the neighbour.
    const neighbour = map.ranges["0.2"];
    const linkText = map.ranges["0.3.0"];
    expect(neighbour.startCol - 1).toBe(text.indexOf("&#x62;c"));
    expect(neighbour.endCol - 1).toBe(text.indexOf("&#x62;c") + "&#x62;c".length);
    expect(linkText.startCol - 1).toBe(text.indexOf("[bc]") + 1);
    expect(linkText.endCol - 1).toBe(text.indexOf("[bc]") + 3);
  });

  it("a neighbour the parent did not rewrite is placed as before, without a reference (`x *a.* b`)", () => {
    const source = "x *a.* b\n";
    const { text, map, spellings } = formatWithMap(parse(source));
    expect(text).toBe(source);
    expect(map.unresolved).toEqual([]);
    expect(text).not.toContain("&#");
    expect(spellings["0.2"]).toEqual({ starts: [6, 7, 8], ends: [7, 8] });
  });
});

describe("spellingOffsets: a surrogate pair written as one reference (task 1.46)", () => {
  // The ownership rule `SpellingTable`'s doc comment states, at the three positions of a node:
  // the leading unit owns the whole reference, the trailing unit is zero width at its end.
  const REFERENCE = "&#x1F600;";
  const n = REFERENCE.length;

  it("at the first position of the node", () => {
    expect(spellingOffsets("😀ab", `${REFERENCE}ab`)).toEqual({
      starts: [0, n, n, n + 1, n + 2],
      ends: [n, n, n + 1, n + 2],
    });
  });

  it("at a middle position of the node", () => {
    expect(spellingOffsets("a😀b", `a${REFERENCE}b`)).toEqual({
      starts: [0, 1, 1 + n, 1 + n, 2 + n],
      ends: [1, 1 + n, 1 + n, 2 + n],
    });
  });

  it("at the last position of the node", () => {
    expect(spellingOffsets("ab😀", `ab${REFERENCE}`)).toEqual({
      starts: [0, 1, 2, 2 + n, 2 + n],
      ends: [1, 2, 2 + n, 2 + n],
    });
  });

  it("a raw surrogate pair in plain text keeps its two one-unit spellings", () => {
    expect(spellingOffsets("a😀b", "a😀b")).toEqual({ starts: [0, 1, 2, 3, 4], ends: [1, 2, 3, 4] });
  });

  it("a BMP character's reference is still one spelling of one unit", () => {
    expect(spellingOffsets("b", "&#x62;")).toEqual({ starts: [0, 6], ends: [6] });
  });

  it("refuses a reference that spells a different code point than the pair", () => {
    expect(spellingOffsets("😀", "&#x1F601;")).toBeUndefined();
  });

  it("the position between the two units answers the reference's end, and every other position is monotone", () => {
    const lineStarts = [0];
    const table = spellingOffsets("a😀b", `a${REFERENCE}b`) as SpellingTable;
    // `spellingPoint` of index 2 — the position between the units, which ProseMirror can name
    // (it counts units) and the editor never offers — is the reference's end, the same place
    // index 3 (after the pair) names; the points are non-decreasing over every index.
    const columns = [0, 1, 2, 3, 4].map((index) => spellingPoint(lineStarts, table, index).column);
    expect(columns).toEqual([1, 2, 2 + n, 2 + n, 3 + n]);
    // `spellingIndex` never answers the trailing unit: every column inside the reference is the
    // leading unit's (1), and the reference's end belongs to the character after the pair (3).
    for (let column = 2; column <= 1 + n; column += 1) {
      expect(spellingIndex(lineStarts, table, 1, column), `column ${column}`).toBe(1);
    }
    expect(spellingIndex(lineStarts, table, 1, 2 + n)).toBe(3);
  });
});
