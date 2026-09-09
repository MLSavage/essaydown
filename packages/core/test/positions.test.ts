import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import {
  childPath,
  formatWithMap,
  indentOffsetMap,
  nodeAt,
  pathDepth,
  rangeContains,
  ROOT_PATH,
  type NodeRange,
  type PositionMap,
} from "../src/positions.js";

/** `[path, type, "startLine:startCol-endLine:endCol"]` for every mapped node, in document order. */
function layout(map: PositionMap): string[] {
  return map.entries.map(
    (e) =>
      `${e.path || "(root)"} ${e.node.type} ${e.startLine}:${e.startCol}-${e.endLine}:${e.endCol}`,
  );
}

function rangeOf(map: PositionMap, path: string): NodeRange {
  const range = map.ranges[path];
  expect(range).toBeDefined();
  return range;
}

/** A root holding one paragraph with the given phrasing children, built by hand. */
function paragraphOf(children: { type: "text"; value: string }[]): Root {
  return { type: "root", children: [{ type: "paragraph", children }] };
}

const EMPTY_TEXT = { type: "text", value: "" } as const;

describe("formatWithMap: the shape of the map", () => {
  it("gives the root the whole string, trailing newline included", () => {
    const { text, map } = formatWithMap(parse("# H\n\nBody.\n"));
    expect(text).toBe("# H\n\nBody.\n");
    expect(map.ranges[ROOT_PATH]).toEqual({ startLine: 1, startCol: 1, endLine: 4, endCol: 1 });
  });

  it("maps an empty root to an empty string and nothing else", () => {
    const root: Root = { type: "root", children: [] };
    const { text, map } = formatWithMap(root);
    expect(text).toBe(format(root));
    expect(text).toBe("");
    expect(map.entries).toHaveLength(1);
    expect(map.ranges[ROOT_PATH]).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 1 });
    expect(map.unresolved).toEqual([]);
    expect(nodeAt(map, 1, 1)).toBeNull();
  });

  it("maps each node of a marked paragraph to the bytes it produced, delimiters included", () => {
    const { text, map } = formatWithMap(parse("A *b* C.\n"));
    expect(text).toBe("A *b* C.\n");
    expect(layout(map)).toEqual([
      "(root) root 1:1-2:1",
      "0 paragraph 1:1-1:9",
      "0.0 text 1:1-1:3",
      "0.1 emphasis 1:3-1:6",
      "0.1.0 text 1:4-1:5",
      "0.2 text 1:6-1:9",
    ]);
  });

  it("maps the opaque nodes to their own bytes", () => {
    const { map } = formatWithMap(
      parse("---\ntitle: T\n---\n\n<div>\nx\n</div>\n\n```js\nlet a = 1;\n```\n"),
    );
    expect(layout(map)).toEqual([
      "(root) root 1:1-12:1",
      "0 yaml 1:1-3:4",
      "1 html 5:1-7:7",
      "2 code 9:1-11:4",
    ]);
  });

  it("maps a blockquote's children through the `> ` its lines gained", () => {
    const { text, map } = formatWithMap(parse("> A quote.\n>\n> - One\n> - Two\n"));
    expect(text).toBe("> A quote.\n>\n> - One\n> - Two\n");
    expect(layout(map)).toEqual([
      "(root) root 1:1-5:1",
      "0 blockquote 1:1-4:8",
      "0.0 paragraph 1:3-1:11",
      "0.0.0 text 1:3-1:11",
      "0.1 list 3:3-4:8",
      "0.1.0 listItem 3:3-3:8",
      "0.1.0.0 paragraph 3:5-3:8",
      "0.1.0.0.0 text 3:5-3:8",
      "0.1.1 listItem 4:3-4:8",
      "0.1.1.0 paragraph 4:5-4:8",
      "0.1.1.0.0 text 4:5-4:8",
    ]);
  });

  it("maps a nested list's children through the bullet and the indent its lines gained", () => {
    const { text, map } = formatWithMap(parse("- One\n  - Two\n- Three\n"));
    expect(text).toBe("- One\n  - Two\n- Three\n");
    expect(layout(map)).toEqual([
      "(root) root 1:1-4:1",
      "0 list 1:1-3:8",
      "0.0 listItem 1:1-2:8",
      "0.0.0 paragraph 1:3-1:6",
      "0.0.0.0 text 1:3-1:6",
      "0.0.1 list 2:3-2:8",
      "0.0.1.0 listItem 2:3-2:8",
      "0.0.1.0.0 paragraph 2:5-2:8",
      "0.0.1.0.0.0 text 2:5-2:8",
      "0.1 listItem 3:1-3:8",
      "0.1.0 paragraph 3:3-3:8",
      "0.1.0.0 text 3:3-3:8",
    ]);
  });

  it("gives a table's rows their whole line and its cells the content between the delimiters", () => {
    const { text, map } = formatWithMap(parse("| a | b |\n| - | - |\n| c | d |\n"));
    expect(text).toBe("| a | b |\n| - | - |\n| c | d |\n");
    expect(layout(map)).toEqual([
      "(root) root 1:1-4:1",
      "0 table 1:1-3:10",
      "0.0 tableRow 1:1-1:10",
      "0.0.0 tableCell 1:3-1:4",
      "0.0.0.0 text 1:3-1:4",
      "0.0.1 tableCell 1:7-1:8",
      "0.0.1.0 text 1:7-1:8",
      "0.1 tableRow 3:1-3:10",
      "0.1.0 tableCell 3:3-3:4",
      "0.1.0.0 text 3:3-3:4",
      "0.1.1 tableCell 3:7-3:8",
      "0.1.1.0 text 3:7-3:8",
    ]);
  });

  it("resolves an empty table cell to a point, and a filled one beside it to its content", () => {
    const { text, map } = formatWithMap(parse("| a | b |\n| - | - |\n|  | c |\n"));
    expect(text).toBe("| a | b |\n| - | - |\n|   | c |\n");
    expect(map.unresolved).toEqual([]);
    expect(rangeOf(map, "0.1.0")).toEqual({ startLine: 3, startCol: 3, endLine: 3, endCol: 3 });
    expect(rangeOf(map, "0.1.1")).toEqual({ startLine: 3, startCol: 7, endLine: 3, endCol: 8 });
  });

  it("keeps one range per node when a paragraph's siblings make the serializer look ahead", () => {
    // `text` has no `peek`, so `containerPhrasing` calls its handler once to look ahead at the
    // next sibling and once for real; the map must carry the second, in document order.
    const { text, map } = formatWithMap(
      paragraphOf([
        { type: "text", value: "a" },
        { type: "text", value: "b" },
        { type: "text", value: "c" },
      ]),
    );
    expect(text).toBe("abc\n");
    expect(layout(map)).toEqual([
      "(root) root 1:1-2:1",
      "0 paragraph 1:1-1:4",
      "0.0 text 1:1-1:2",
      "0.1 text 1:2-1:3",
      "0.2 text 1:3-1:4",
    ]);
  });
});

describe("formatWithMap: zero-width nodes own no character", () => {
  it("places one at the first position at the start of its parent", () => {
    const { map } = formatWithMap(paragraphOf([EMPTY_TEXT, { type: "text", value: "ab" }]));
    expect(rangeOf(map, "0.0")).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 1 });
    expect(rangeOf(map, "0.1")).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 3 });
  });

  it("places one at a middle position where the previous sibling ended", () => {
    const { map } = formatWithMap(
      paragraphOf([{ type: "text", value: "a" }, EMPTY_TEXT, { type: "text", value: "b" }]),
    );
    expect(rangeOf(map, "0.0")).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 2 });
    expect(rangeOf(map, "0.1")).toEqual({ startLine: 1, startCol: 2, endLine: 1, endCol: 2 });
    expect(rangeOf(map, "0.2")).toEqual({ startLine: 1, startCol: 2, endLine: 1, endCol: 3 });
  });

  it("places one at the last position at the end of its parent", () => {
    const { map } = formatWithMap(paragraphOf([{ type: "text", value: "ab" }, EMPTY_TEXT]));
    expect(rangeOf(map, "0.0")).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 3 });
    expect(rangeOf(map, "0.1")).toEqual({ startLine: 1, startCol: 3, endLine: 1, endCol: 3 });
  });

  it("never answers a lookup with a zero-width node", () => {
    const { map } = formatWithMap(
      paragraphOf([{ type: "text", value: "a" }, EMPTY_TEXT, { type: "text", value: "b" }]),
    );
    expect(nodeAt(map, 1, 1)?.path).toBe("0.0");
    expect(nodeAt(map, 1, 2)?.path).toBe("0.2");
    expect(rangeContains(rangeOf(map, "0.1"), 1, 2)).toBe(false);
  });
});

describe("nodeAt", () => {
  const { map } = formatWithMap(parse("A *b* C.\n\nSecond.\n"));

  it("answers with the innermost node covering the position", () => {
    expect(nodeAt(map, 1, 1)?.path).toBe("0.0");
    expect(nodeAt(map, 1, 3)?.path).toBe("0.1");
    expect(nodeAt(map, 1, 4)?.path).toBe("0.1.0");
    expect(nodeAt(map, 1, 5)?.path).toBe("0.1");
    expect(nodeAt(map, 1, 6)?.path).toBe("0.2");
    expect(nodeAt(map, 3, 1)?.path).toBe("1.0");
  });

  it("is null on the blank line between two blocks, which the root alone covers", () => {
    expect(rangeContains(rangeOf(map, ROOT_PATH), 2, 1)).toBe(true);
    expect(nodeAt(map, 2, 1)).toBeNull();
  });

  it("is null past the last character of a line and outside the string", () => {
    expect(nodeAt(map, 1, 9)).toBeNull();
    expect(nodeAt(map, 4, 1)).toBeNull();
    expect(nodeAt(map, 0, 1)).toBeNull();
  });

  it("never answers with the root", () => {
    const paths = new Set<string>();
    for (let line = 1; line <= 4; line++)
      for (let column = 1; column <= 10; column++) {
        const hit = nodeAt(map, line, column);
        if (hit) paths.add(hit.path);
      }
    expect(paths.has(ROOT_PATH)).toBe(false);
    expect(paths.size).toBeGreaterThan(0);
  });
});

describe("rangeContains, pathDepth, childPath", () => {
  const single: NodeRange = { startLine: 2, startCol: 3, endLine: 2, endCol: 6 };
  const multi: NodeRange = { startLine: 2, startCol: 3, endLine: 4, endCol: 2 };
  const empty: NodeRange = { startLine: 2, startCol: 3, endLine: 2, endCol: 3 };

  it("covers the first, middle and last column of a single-line range and nothing beyond", () => {
    expect(rangeContains(single, 2, 3)).toBe(true);
    expect(rangeContains(single, 2, 4)).toBe(true);
    expect(rangeContains(single, 2, 5)).toBe(true);
    expect(rangeContains(single, 2, 2)).toBe(false);
    expect(rangeContains(single, 2, 6)).toBe(false);
    expect(rangeContains(single, 1, 4)).toBe(false);
    expect(rangeContains(single, 3, 4)).toBe(false);
  });

  it("covers a whole intermediate line of a multi-line range", () => {
    expect(rangeContains(multi, 2, 3)).toBe(true);
    expect(rangeContains(multi, 2, 2)).toBe(false);
    expect(rangeContains(multi, 3, 1)).toBe(true);
    expect(rangeContains(multi, 3, 999)).toBe(true);
    expect(rangeContains(multi, 4, 1)).toBe(true);
    expect(rangeContains(multi, 4, 2)).toBe(false);
  });

  it("covers nothing when the range is empty", () => {
    expect(rangeContains(empty, 2, 2)).toBe(false);
    expect(rangeContains(empty, 2, 3)).toBe(false);
    expect(rangeContains(empty, 2, 4)).toBe(false);
  });

  it("counts the steps from the root and builds child paths", () => {
    expect(pathDepth(ROOT_PATH)).toBe(0);
    expect(pathDepth("3")).toBe(1);
    expect(pathDepth("3.1")).toBe(2);
    expect(childPath(ROOT_PATH, 0)).toBe("0");
    expect(childPath("0", 2)).toBe("0.2");
    expect(childPath("0.2", 1)).toBe("0.2.1");
  });
});

describe("indentOffsetMap: the seam blockquote and listItem indent their children through", () => {
  it("maps every offset of the source onto the prefixed copy, its end included", () => {
    const source = "one\ntwo";
    const shift = indentOffsetMap(source, "> one\n> two");
    expect(shift).toBeDefined();
    const mapped = [...Array(source.length + 1).keys()].map((offset) => shift?.(offset));
    expect(mapped).toEqual([2, 3, 4, 5, 8, 9, 10, 11]);
  });

  it("maps a blank line that lost its trailing prefix", () => {
    const shift = indentOffsetMap("a\n\nb", ">a\n>\n>b");
    expect(shift?.(0)).toBe(1);
    expect(shift?.(2)).toBe(4);
    expect(shift?.(3)).toBe(6);
  });

  it("refuses a result with a different number of lines", () => {
    expect(indentOffsetMap("one\ntwo", "> one")).toBeUndefined();
    expect(indentOffsetMap("one", "> one\n> two")).toBeUndefined();
  });

  it("refuses a result whose line is not its source line with something in front", () => {
    expect(indentOffsetMap("one\ntwo", "> one\n> tw")).toBeUndefined();
    expect(indentOffsetMap("one", "> ONE")).toBeUndefined();
  });
});

describe("formatWithMap: a node the serializer rewrote after emitting it", () => {
  it("is reported in unresolved with its subtree, and its siblings keep their ranges", () => {
    // `containerPhrasing` replaces the line ending a `break` produced with a space when the next
    // child is `html`, so the bytes the `break` handler returned are not in the output at all.
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "a" },
            { type: "break" },
            { type: "html", value: "<b>x</b>" },
          ],
        },
      ],
    };
    const { text, map } = formatWithMap(root);
    expect(text).toBe("a\\ <b>x</b>\n");
    expect(map.unresolved).toEqual(["0.1"]);
    expect(map.ranges["0.0"]).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 2 });
    expect(map.ranges["0.2"]).toEqual({ startLine: 1, startCol: 4, endLine: 1, endCol: 12 });
  });
});

/* ---------------------------------------------------------------- the table grid (1.15) --- */

/** A phrasing or table node built by hand, loose enough to hold the shapes below. */
interface Built {
  type: string;
  value?: string;
  children?: Built[];
}

const text = (value: string): Built => ({ type: "text", value });
const cell = (...children: Built[]): Built => ({ type: "tableCell", children });
const row = (...cells: Built[]): Built => ({ type: "tableRow", children: cells });

/** A root holding one table of the given rows, built by hand. */
function tableOf(...rows: Built[]): Root {
  return {
    type: "root",
    children: [{ type: "table", align: null, children: rows }],
  } as unknown as Root;
}

/** The 1-based columns of `line`'s unescaped `|`: the delimiters of one row. */
function delimiterColumns(line: string): number[] {
  const columns: number[] = [];
  for (let index = 0; index < line.length; index++) {
    if (line[index] === "|" && line[index - 1] !== "\\") columns.push(index + 1);
  }
  return columns;
}

/** Assert `range` is a point strictly between delimiter `cell` and delimiter `cell + 1`. */
function expectPointInsideCell(text_: string, range: NodeRange, cellIndex: number): void {
  expect(range.startLine).toBe(range.endLine);
  expect(range.startCol).toBe(range.endCol);
  const columns = delimiterColumns(text_.split("\n")[range.startLine - 1]);
  expect(columns.length).toBeGreaterThan(cellIndex + 1);
  expect(range.startCol).toBeGreaterThan(columns[cellIndex]);
  expect(range.startCol).toBeLessThan(columns[cellIndex + 1]);
}

/** The reproduction of DECISIONS #review-1-r0 F3: what `input.ts`'s table rule builds. */
const REPRODUCTION = "| a | b |\n| - | - |\n| | |\n";

/**
 * One test per guard of the fix, enumerated from the diff of `placeTableGrid` and its helpers
 * rather than from the acceptance sentences (CLAUDE.md's rule). The guards, in source order:
 * the line-count check, the delimiter-line skip, `cellSlices`' column-count check,
 * `delimiterOffsets`' even-backslash rule, `contentSlice`'s all-padding branch, and
 * `setPlacedSpan`'s widening to the descendant hull.
 */
describe("formatWithMap: the table grid, guard by guard (task 1.15)", () => {
  it("guard 1: a table whose output is not one line per row plus the delimiter line keeps the hull", () => {
    // Raw HTML is opaque, so a newline inside it reaches the output and the grid has more lines
    // than rows. Under the grid the header row would be its whole line, 1:1-1:18.
    const { text: out, map } = formatWithMap(
      tableOf(
        row(cell(text("a")), cell(text("b"))),
        row(cell({ type: "html", value: "<br>\n<br>" }), cell(text("d"))),
      ),
    );
    expect(out.split("\n")).toHaveLength(5);
    expect(rangeOf(map, "0.0")).toEqual({ startLine: 1, startCol: 3, endLine: 1, endCol: 16 });
    expect(rangeOf(map, "0.0.0")).toEqual(rangeOf(map, "0.0.0.0"));
  });

  it("guard 2: the delimiter line belongs to no row, so body row i is on line i + 1", () => {
    const { text: out, map } = formatWithMap(parse("| a |\n| - |\n| b |\n| c |\n| d |\n"));
    expect(out).toBe("| a |\n| - |\n| b |\n| c |\n| d |\n");
    const rows = map.entries.filter((entry) => entry.node.type === "tableRow");
    expect(rows.map((entry) => entry.startLine)).toEqual([1, 3, 4, 5]);
    expect(rows.map((entry) => entry.path)).toEqual(["0.0", "0.1", "0.2", "0.3"]);
  });

  it("guard 3: a row line whose delimiters do not divide it into one slice per column keeps the hull", () => {
    // The `|` inside the opaque HTML is a fifth delimiter on a two-column line, so that row falls
    // back to the hull of its cells while the header row above it still takes its whole line.
    const { text: out, map } = formatWithMap(
      tableOf(
        row(cell(text("a")), cell(text("b"))),
        row(cell({ type: "html", value: '<a b="|">' }), cell(text("d"))),
      ),
    );
    // Four delimiters on a two-column line, where the grid needs exactly three.
    expect(delimiterColumns(out.split("\n")[2])).toHaveLength(4);
    expect(rangeOf(map, "0.0")).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 18 });
    expect(rangeOf(map, "0.1")).toEqual({ startLine: 3, startCol: 3, endLine: 3, endCol: 16 });
    expect(rangeOf(map, "0.1.0")).toEqual(rangeOf(map, "0.1.0.0"));
  });

  it("guard 4: an escaped delimiter inside a cell is not a cell boundary", () => {
    const { text: out, map } = formatWithMap(parse("| a | b |\n| - | - |\n| x \\| y |  |\n"));
    expect(out).toBe("| a      | b |\n| ------ | - |\n| x \\| y |   |\n");
    // The whole escaped run is one cell's content; the empty cell after it is the second, not the
    // third, which is what a `\|` counted as a delimiter would have made it.
    expect(rangeOf(map, "0.1.0")).toEqual({ startLine: 3, startCol: 3, endLine: 3, endCol: 9 });
    expect(rangeOf(map, "0.1.1")).toEqual({ startLine: 3, startCol: 12, endLine: 3, endCol: 12 });
    expect(map.ranges["0.1.2"]).toBeUndefined();
  });

  it("guard 5: a cell whose slice is all padding is the point where its first character would go", () => {
    const { text: out, map } = formatWithMap(parse(REPRODUCTION));
    expect(out).toBe("| a | b |\n| - | - |\n|   |   |\n");
    expect(rangeOf(map, "0.1.0")).toEqual({ startLine: 3, startCol: 3, endLine: 3, endCol: 3 });
    expect(delimiterColumns(out.split("\n")[2])[0] + 2).toBe(3);
  });

  it("guard 6: a cell's range is widened to cover a descendant the padding put outside it", () => {
    // The cell's own content starts with a space, so `markdown-table` writes `|  c |` and the
    // `text` node was placed on that space — one column left of the trimmed content slice.
    const { text: out, map } = formatWithMap(
      tableOf(row(cell(text("a")), cell(text("b"))), row(cell(text(" c")), cell(text("d")))),
    );
    expect(out).toBe("| a  | b |\n| -- | - |\n|  c | d |\n");
    expect(rangeOf(map, "0.1.0.0")).toEqual({ startLine: 3, startCol: 3, endLine: 3, endCol: 5 });
    expect(rangeOf(map, "0.1.0")).toEqual(rangeOf(map, "0.1.0.0"));
  });
});

describe("formatWithMap: empty table cells (task 1.15)", () => {
  const EMPTY_CELLS =
    "| a | b | c |\n| - | - | - |\n|  | y | z |\n| x |  | z |\n| x | y |  |\n|  |  |  |\n";

  it("places the first, the middle and the last empty cell of a row inside its own delimiters", () => {
    const { text: out, map } = formatWithMap(parse(EMPTY_CELLS));
    expect(out.split("\n")[2]).toBe("|   | y | z |");
    expectPointInsideCell(out, rangeOf(map, "0.1.0"), 0);
    expectPointInsideCell(out, rangeOf(map, "0.2.1"), 1);
    expectPointInsideCell(out, rangeOf(map, "0.3.2"), 2);
    expect(rangeOf(map, "0.1.0")).toEqual({ startLine: 3, startCol: 3, endLine: 3, endCol: 3 });
    expect(rangeOf(map, "0.2.1")).toEqual({ startLine: 4, startCol: 7, endLine: 4, endCol: 7 });
    expect(rangeOf(map, "0.3.2")).toEqual({ startLine: 5, startCol: 11, endLine: 5, endCol: 11 });
  });

  it("gives a wholly empty body row its whole line and each of its cells a point in it", () => {
    const { text: out, map } = formatWithMap(parse(EMPTY_CELLS));
    expect(out.split("\n")[5]).toBe("|   |   |   |");
    expect(rangeOf(map, "0.4")).toEqual({ startLine: 6, startCol: 1, endLine: 6, endCol: 14 });
    for (const column of [0, 1, 2]) {
      const range = rangeOf(map, `0.4.${column}`);
      expectPointInsideCell(out, range, column);
      expect(rangeContains(rangeOf(map, "0.4"), range.startLine, range.startCol)).toBe(true);
    }
  });

  it("places the cells of a table whose header cells are empty", () => {
    const { text: out, map } = formatWithMap(parse("|  |  |\n| - | - |\n| a | b |\n"));
    expect(out).toBe("|   |   |\n| - | - |\n| a | b |\n");
    expect(map.unresolved).toEqual([]);
    expectPointInsideCell(out, rangeOf(map, "0.0.0"), 0);
    expectPointInsideCell(out, rangeOf(map, "0.0.1"), 1);
    expect(rangeOf(map, "0.0")).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 10 });
    expect(rangeOf(map, "0.1.0")).toEqual({ startLine: 3, startCol: 3, endLine: 3, endCol: 4 });
  });

  it("resolves every path of the reproduction table, the root and its subtree apart", () => {
    const root = parse(REPRODUCTION);
    const { map } = formatWithMap(root);
    expect(map.unresolved).toEqual([]);
    expect(Object.keys(map.ranges).sort()).toEqual(
      ["", "0", "0.0", "0.0.0", "0.0.0.0", "0.0.1", "0.0.1.0", "0.1", "0.1.0", "0.1.1"].sort(),
    );
  });
});

describe("nodeAt over a table with empty cells (task 1.15)", () => {
  const { text, map } = formatWithMap(parse(REPRODUCTION));
  const lines = text.split("\n");

  it("answers every column of every line of the table, and never with the root", () => {
    const answered: string[] = [];
    for (let line = 1; line < lines.length; line++) {
      for (let column = 1; column <= lines[line - 1].length; column++) {
        const hit = nodeAt(map, line, column);
        expect(hit).not.toBeNull();
        expect(hit?.path).not.toBe(ROOT_PATH);
        expect(rangeContains(hit as NodeRange, line, column)).toBe(true);
        answered.push(hit?.path as string);
      }
    }
    expect(new Set(answered)).toEqual(
      // A header cell and its `text` cover the same columns, and `nodeAt` answers with the
      // deeper of the two; the two empty cells of row 2 are zero width and answer nothing.
      new Set(["0", "0.0", "0.0.0.0", "0.0.1.0", "0.1"]),
    );
  });

  it("answers the padding of the empty body row with the row, never with the zero-width cell", () => {
    const empty = rangeOf(map, "0.1.0");
    expect(rangeContains(empty, empty.startLine, empty.startCol)).toBe(false);
    expect(nodeAt(map, empty.startLine, empty.startCol)?.path).toBe("0.1");
  });

  it("is null past the end of a line and outside the string", () => {
    expect(nodeAt(map, 3, lines[2].length + 1)).toBeNull();
    expect(nodeAt(map, lines.length, 1)).toBeNull();
    expect(nodeAt(map, 0, 1)).toBeNull();
  });
});
