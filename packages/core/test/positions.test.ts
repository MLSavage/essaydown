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

  it("gives a table's rows and cells the hull of the cells `markdown-table` aligned", () => {
    const { text, map } = formatWithMap(parse("| a | b |\n| - | - |\n| c | d |\n"));
    expect(text).toBe("| a | b |\n| - | - |\n| c | d |\n");
    expect(layout(map)).toEqual([
      "(root) root 1:1-4:1",
      "0 table 1:1-3:10",
      "0.0 tableRow 1:3-1:8",
      "0.0.0 tableCell 1:3-1:4",
      "0.0.0.0 text 1:3-1:4",
      "0.0.1 tableCell 1:7-1:8",
      "0.0.1.0 text 1:7-1:8",
      "0.1 tableRow 3:3-3:8",
      "0.1.0 tableCell 3:3-3:4",
      "0.1.0.0 text 3:3-3:4",
      "0.1.1 tableCell 3:7-3:8",
      "0.1.1.0 text 3:7-3:8",
    ]);
  });

  it("reports an empty table cell as unresolved, and a filled one beside it as resolved", () => {
    const { map } = formatWithMap(parse("| a | b |\n| - | - |\n|  | c |\n"));
    expect(map.unresolved).toEqual(["0.1.0"]);
    expect(map.ranges["0.1.0"]).toBeUndefined();
    expect(map.ranges["0.1.1"]).toEqual({ startLine: 3, startCol: 7, endLine: 3, endCol: 8 });
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
