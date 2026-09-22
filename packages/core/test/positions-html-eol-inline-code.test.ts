import { describe, expect, it } from "vitest";
import type { Root } from "mdast";
import { parse } from "../src/parse.js";
import {
  formatWithMap,
  inlineCodeSpelling,
  nodeAt,
  spellingIndex,
  spellingOffsets,
  spellingPoint,
  type SpellingTable,
} from "../src/positions.js";

/**
 * **Two node classes the position map could not place a caret in** (task 1.51, DECISIONS
 * #review-1-r6 L3 and L4 — Claude findings 2 and 3, Sol finding 2).
 *
 * L3: `mdast-util-to-markdown/lib/util/container-phrasing.js` (2.1.2) has a third branch that
 * rewrites a child's string after its handler returned — lines 60–80, the line ending before an
 * `html` sibling replaced by one space — and `rewrittenEmissions` enumerated only the two edge
 * encodings, so a `text` child ending in a soft line break before inline html was `unresolved`,
 * had no spelling table, and every caret in it answered the paragraph's start. The guards below
 * are enumerated from the fix's diff: the fourth candidate (tried only before `html`), the
 * line-ending-as-space rule of `spellingOffsets` (the flag passed from the matched candidate),
 * and the two absence cases (no break before html; a `break` child before html, which stays
 * unresolved as `positions.test.ts` asserts).
 *
 * L4: `inlineCode` is a value-bearing node that had no spelling table, so every position strictly
 * inside a code span answered the span's start. `inlineCodeSpelling` reads the handler's shape
 * (`lib/handle/inline-code.js`: fence, optional padding, the value, padding, fence), and the
 * guards below assert the table at the first, middle and last position of every source, with the
 * fence and the padding owned by no character.
 *
 * Every expected offset is computed from where the bytes sit in the output, never copied from one
 * run.
 */

/* ------------------------------------------------------------ L3: a line ending before html -- */

interface HtmlCase {
  /** The source, as the task lists it. */
  source: string;
  /** The path of the text node whose trailing line ending the parent wrote as a space. */
  path: string;
  /** That text node's `value`. */
  value: string;
}

/** The three html sources of the task, each with a soft line break before an inline tag. */
const HTML_CASES: HtmlCase[] = [
  { source: "alpha beta\n<span>x</span> gamma\n", path: "0.0", value: "alpha beta\n" },
  { source: "alpha\n<i>beta</i>\n", path: "0.0", value: "alpha\n" },
  { source: "*a*\n<b>x</b>\n", path: "0.1", value: "\n" },
];

/** A root holding one paragraph: the text `a`, a hard `break`, and one inline `html` node. */
function breakBeforeHtml(html: string): Root {
  return {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          { type: "text", value: "a" },
          { type: "break" },
          { type: "html", value: html },
        ],
      },
    ],
  };
}

function expectMonotone(table: SpellingTable): void {
  for (let i = 0; i < table.ends.length; i += 1) {
    expect(table.ends[i]).toBeGreaterThanOrEqual(table.starts[i]);
    expect(table.starts[i + 1]).toBeGreaterThanOrEqual(table.ends[i]);
  }
}

describe("a text child's line ending before inline html is placed (task 1.51, L3)", () => {
  for (const { source, path, value } of HTML_CASES) {
    const title = JSON.stringify(source.trimEnd());

    it(`${title}: the bytes hold the space for the line ending, are a fixed point, and nothing is unresolved`, () => {
      const root = parse(source);
      const { text, map } = formatWithMap(root);
      expect(text).toBe(source.replace(/\n(?=<)/, " "));
      expect(formatWithMap(parse(text)).text).toBe(text);
      expect(map.unresolved).toEqual([]);
    });

    it(`${title}: the text node at ${path} covers its bytes with the space, and nodeAt inside it answers it`, () => {
      const { text, map } = formatWithMap(parse(source));
      const entry = map.entries.find((candidate) => candidate.path === path);
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      expect(entry.node.type).toBe("text");
      expect((entry.node as { value: string }).value).toBe(value);
      // The written form: the value with its line ending as a space, found at its own offset.
      const written = value.replace(/\n$/, " ");
      const start = text.indexOf(written);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(entry).toMatchObject({
        startLine: 1,
        startCol: start + 1,
        endLine: 1,
        endCol: start + written.length + 1,
      });
      // The first, a middle and the last column of the node — the space included — are its.
      const columns = [start, start + Math.floor(written.length / 2), start + written.length - 1];
      for (const offset of columns) {
        expect(nodeAt(map, 1, offset + 1)?.path, `column ${offset + 1}`).toBe(path);
      }
      // The character after the space is the html's, not the text's.
      expect(nodeAt(map, 1, start + written.length + 1)?.node.type).toBe("html");
    });

    it(`${title}: the spelling table spells the line ending as the space, one unit for one unit`, () => {
      const { text, spellings, lineStarts } = formatWithMap(parse(source));
      const table = spellings[path];
      expect(table).toBeDefined();
      if (table === undefined) return;
      const written = value.replace(/\n$/, " ");
      const start = text.indexOf(written);
      const space = start + written.length - 1;
      expect(text[space]).toBe(" ");
      expect(table.starts).toHaveLength(value.length + 1);
      expect(table.ends).toHaveLength(value.length);
      // Every character before the line ending is at its own offset; the line ending owns the
      // space; the end sentinel is one past it — the same offsets a plain value would have.
      for (let index = 0; index < value.length - 1; index += 1) {
        expect(table.starts[index]).toBe(start + index);
        expect(table.ends[index]).toBe(start + index + 1);
      }
      expect(table.starts[value.length - 1]).toBe(space);
      expect(table.ends[value.length - 1]).toBe(space + 1);
      expect(table.starts[value.length]).toBe(space + 1);
      expectMonotone(table);
      // The cursor before the line ending is the column of the space; the cursor after it is the
      // column after; the space's own column belongs to the line ending.
      expect(spellingPoint(lineStarts, table, value.length - 1).column).toBe(space + 1);
      expect(spellingPoint(lineStarts, table, value.length).column).toBe(space + 2);
      expect(spellingIndex(lineStarts, table, 1, space + 1)).toBe(value.length - 1);
      expect(spellingIndex(lineStarts, table, 1, space + 2)).toBe(value.length);
    });
  }

  it("the no-break control is unchanged: `alpha <i>beta</i> gamma` has no space written for a line ending", () => {
    const source = "alpha <i>beta</i> gamma\n";
    const { text, map, spellings } = formatWithMap(parse(source));
    expect(text).toBe(source);
    expect(map.unresolved).toEqual([]);
    expect(spellings["0.0"]).toEqual({ starts: [0, 1, 2, 3, 4, 5, 6], ends: [1, 2, 3, 4, 5, 6] });
    expect(spellings["0.2"]).toEqual({ starts: [9, 10, 11, 12, 13], ends: [10, 11, 12, 13] });
    expect(nodeAt(map, 1, 7)?.node.type).toBe("html");
  });

  it("a `break` child before an inline tag keeps its line ending and is placed (task 1.58)", () => {
    // The same branch rewrites the `break` handler's `\\\n`, and task 1.58 writes that output
    // back when the pair reparses to a `break` followed by an `html` (DECISIONS #review-1-r7 M2).
    // A break still has no value to spell — the fourth candidate is a `text` child's only — but
    // its bytes are now in the output verbatim, so it is found and ranged.
    const root: Root = breakBeforeHtml("<b>x</b>");
    const { text, map, spellings } = formatWithMap(root);
    expect(text).toBe("a\\\n<b>x</b>\n");
    expect(map.unresolved).toEqual([]);
    const backslash = text.indexOf("\\");
    expect(map.ranges["0.1"]).toEqual({
      startLine: 1,
      startCol: backslash + 1,
      endLine: 2,
      endCol: 1,
    });
    expect(map.ranges["0.0"]).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 2 });
    expect(map.ranges["0.2"]).toEqual({
      startLine: 2,
      startCol: 1,
      endLine: 2,
      endCol: 1 + "<b>x</b>".length,
    });
    expect(spellings["0.0"]).toEqual({ starts: [0, 1], ends: [1] });
    expect(spellings["0.1"]).toBeUndefined();
  });

  it("a `break` child before html that can open a block is one space, and stays unresolved", () => {
    // `<div>` is CommonMark §4.6 condition 6: keeping the line ending would open an html block on
    // the next line, so the break is written as one space and lost — the documented loss on
    // docs/V1.1-BACKLOG.md `[#030 product, a soft or hard break before inline html]`. One space is
    // not the handler's output, so the break is `unresolved` with no spelling table, exactly as
    // every break before html was before task 1.58.
    const { text, map, spellings } = formatWithMap(breakBeforeHtml("<div>x</div>"));
    expect(text).toBe("a <div>x</div>\n");
    expect(map.unresolved).toEqual(["0.1"]);
    expect(map.ranges["0.0"]).toEqual({ startLine: 1, startCol: 1, endLine: 1, endCol: 2 });
    const html = text.indexOf("<div>");
    expect(map.ranges["0.2"]).toEqual({
      startLine: 1,
      startCol: html + 1,
      endLine: 1,
      endCol: html + 1 + "<div>x</div>".length,
    });
    expect(spellings["0.0"]).toEqual({ starts: [0, 1], ends: [1] });
    expect(spellings["0.1"]).toBeUndefined();
  });

  it("the fourth candidate is tried only before html: a line ending before a run is never read as a space", () => {
    // `a\n*b*` keeps its line ending (no html follows), so the value is found as itself; the
    // parent wrote no space, and none is read.
    const source = "a\n*b*\n";
    const { text, map, spellings } = formatWithMap(parse(source));
    expect(text).toBe(source);
    expect(map.unresolved).toEqual([]);
    expect(spellings["0.0"]).toEqual({ starts: [0, 1, 2], ends: [1, 2] });
  });

  it("branch 3 combines with branch 1: a child after a run and before html gets both rewrites", () => {
    // `x *a *b\n<b>y</b>`: the run `*a *` has whitespace inside its closing edge, so the `b`
    // after it is encoded (branch 1, the head form), and the same child's line ending before the
    // html is the space (branch 3).
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "x " },
            { type: "emphasis", children: [{ type: "text", value: "a " }] },
            { type: "text", value: "b\n" },
            { type: "html", value: "<b>y</b>" },
          ],
        },
      ],
    };
    const { text, map, spellings } = formatWithMap(root);
    expect(text).toContain("&#x62; <b>y</b>");
    expect(map.unresolved).toEqual([]);
    const reference = text.indexOf("&#x62;");
    const end = reference + "&#x62;".length;
    expect(spellings["0.2"]).toEqual({ starts: [reference, end, end + 1], ends: [end, end + 1] });
  });

  it("in a blockquote, the continuation prefix and the space are both carried", () => {
    const source = "> a\n> <b>x</b>\n";
    const { text, map, spellings } = formatWithMap(parse(source));
    expect(text).toBe("> a <b>x</b>\n");
    expect(map.unresolved).toEqual([]);
    expect(spellings["0.0.0"]).toEqual({ starts: [2, 3, 4], ends: [3, 4] });
  });
});

describe("spellingOffsets: the line ending as space (task 1.51)", () => {
  it("is not read without the flag", () => {
    expect(spellingOffsets("a\n", "a ")).toBeUndefined();
  });

  it("with the flag, the trailing line ending owns the space at its offset", () => {
    expect(spellingOffsets("a\n", "a ", 0, true)).toEqual({ starts: [0, 1, 2], ends: [1, 2] });
    expect(spellingOffsets("\n", " ", 0, true)).toEqual({ starts: [0, 1], ends: [1] });
    expect(spellingOffsets("a\r", "a ", 0, true)).toEqual({ starts: [0, 1, 2], ends: [1, 2] });
  });

  it("with the flag, a `\\r\\n` ending follows the surrogate rule: `\\r` owns the space, `\\n` is zero width at its end", () => {
    expect(spellingOffsets("a\r\n", "a ", 0, true)).toEqual({ starts: [0, 1, 2, 2], ends: [1, 2, 2] });
  });

  it("with the flag, a line ending that is not trailing is still a line ending", () => {
    expect(spellingOffsets("a\nb\n", "a\nb ", 0, true)).toEqual({
      starts: [0, 1, 2, 3, 4],
      ends: [1, 2, 3, 4],
    });
    expect(spellingOffsets("a\nb\n", "a b ", 0, true)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------- L4: inline code ------ */

interface CodeCase {
  source: string;
  /** The `inlineCode` node's path. */
  path: string;
  /** Its `value`. */
  value: string;
  /** The fence the handler writes for it. */
  fence: string;
  /** Whether the handler pads it with one space on each side. */
  padded: boolean;
}

/**
 * The inline-code sources of the task, and what `lib/handle/inline-code.js` writes for each. A
 * value is padded only when it starts *and* ends with a space (or line ending), or starts or ends
 * with a backtick (line 30's conjunction and disjunction): `` ` a` `` parses to the value ` a`,
 * whose one leading space does not earn the padding, so it is the unpadded control beside the
 * padded `` `  a  ` `` (value ` a `).
 */
const CODE_CASES: CodeCase[] = [
  { source: "a `cd` b\n", path: "0.1", value: "cd", fence: "`", padded: false },
  { source: "# h `c`\n", path: "0.1", value: "c", fence: "`", padded: false },
  { source: "` a`\n", path: "0.0", value: " a", fence: "`", padded: false },
  { source: "`  a  `\n", path: "0.0", value: " a ", fence: "`", padded: true },
  { source: "``a`b``\n", path: "0.0", value: "a`b", fence: "``", padded: false },
  { source: "`` `a ``\n", path: "0.0", value: "`a", fence: "``", padded: true },
  { source: "`😀`\n", path: "0.0", value: "😀", fence: "`", padded: false },
];

describe("an inline code span's characters are placed (task 1.51, L4)", () => {
  for (const { source, path, value, fence, padded } of CODE_CASES) {
    const title = JSON.stringify(source.trimEnd());

    it(`${title}: the bytes are a fixed point, the node holds the value, and nothing is unresolved`, () => {
      const root = parse(source);
      const { text, map } = formatWithMap(root);
      expect(text).toBe(source);
      expect(formatWithMap(parse(text)).text).toBe(text);
      expect(map.unresolved).toEqual([]);
      const entry = map.entries.find((candidate) => candidate.path === path);
      expect(entry?.node.type).toBe("inlineCode");
      expect((entry?.node as { value: string }).value).toBe(value);
    });

    it(`${title}: the range covers fence, padding, value, padding, fence, and nodeAt on each answers it`, () => {
      const { text, map } = formatWithMap(parse(source));
      const padding = padded ? " " : "";
      const written = `${fence}${padding}${value}${padding}${fence}`;
      const start = text.indexOf(written);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(map.ranges[path]).toEqual({
        startLine: 1,
        startCol: start + 1,
        endLine: 1,
        endCol: start + written.length + 1,
      });
      // The opening fence, the first character, a middle one, the last, the closing fence.
      const inner = start + fence.length + padding.length;
      const columns = [start, inner, inner + Math.floor(value.length / 2), inner + value.length - 1, start + written.length - 1];
      for (const offset of columns) {
        expect(nodeAt(map, 1, offset + 1)?.path, `column ${offset + 1}`).toBe(path);
      }
    });

    it(`${title}: the spelling table at the first, middle and last position, the fence and padding owned by no character`, () => {
      const { text, spellings, lineStarts } = formatWithMap(parse(source));
      const table = spellings[path];
      expect(table).toBeDefined();
      if (table === undefined) return;
      const padding = padded ? " " : "";
      const written = `${fence}${padding}${value}${padding}${fence}`;
      const start = text.indexOf(written);
      const inner = start + fence.length + padding.length;
      expect(table.starts).toHaveLength(value.length + 1);
      expect(table.ends).toHaveLength(value.length);
      // First: the position before the first character is the offset after the opening fence and
      // padding. Middle: every character is at its own offset, one unit each. Last: the position
      // after the last character is the offset before the closing padding and fence.
      expect(table.starts[0]).toBe(inner);
      const middle = Math.floor(value.length / 2);
      expect(table.starts[middle]).toBe(inner + middle);
      expect(table.ends[middle]).toBe(inner + middle + 1);
      expect(table.ends[value.length - 1]).toBe(inner + value.length);
      expect(table.starts[value.length]).toBe(inner + value.length);
      for (let index = 0; index < value.length; index += 1) {
        expect(table.starts[index]).toBe(inner + index);
        expect(table.ends[index]).toBe(inner + index + 1);
      }
      expectMonotone(table);
      // The fence and the padding are owned by no character: an offset on the opening side
      // belongs to the first character, an offset on the closing side to the end of the value.
      for (let offset = start; offset < inner; offset += 1) {
        expect(spellingIndex(lineStarts, table, 1, offset + 1), `opening column ${offset + 1}`).toBe(0);
      }
      for (let offset = inner + value.length; offset < start + written.length; offset += 1) {
        expect(spellingIndex(lineStarts, table, 1, offset + 1), `closing column ${offset + 1}`).toBe(
          value.length,
        );
      }
      expect(spellingPoint(lineStarts, table, 0).column).toBe(inner + 1);
      expect(spellingPoint(lineStarts, table, value.length).column).toBe(inner + value.length + 1);
    });
  }

  it("`# h `c``: the heading's end is the code span's end, and `toSource` of it is not the line's end", () => {
    // The heading `# h `c``: the last position of the block is the end of the code span's value,
    // before the closing fence — the answer the toggle's inverse needs.
    const { text, spellings } = formatWithMap(parse("# h `c`\n"));
    const closingFence = text.lastIndexOf("`");
    expect(spellings["0.1"]?.starts.at(-1)).toBe(closingFence);
  });
});

describe("inlineCodeSpelling: the handler's shapes (task 1.51)", () => {
  it("fence, value, fence", () => {
    expect(inlineCodeSpelling("cd", "`cd`")).toEqual({ starts: [1, 2, 3], ends: [2, 3] });
  });

  it("a longer fence for a value holding a backtick run", () => {
    expect(inlineCodeSpelling("a`b", "``a`b``")).toEqual({ starts: [2, 3, 4, 5], ends: [3, 4, 5] });
    expect(inlineCodeSpelling("a``b", "`a``b`")).toEqual({ starts: [1, 2, 3, 4, 5], ends: [2, 3, 4, 5] });
  });

  it("padding on both sides", () => {
    expect(inlineCodeSpelling(" a ", "`  a  `")).toEqual({ starts: [2, 3, 4, 5], ends: [3, 4, 5] });
    expect(inlineCodeSpelling("`a", "`` `a ``")).toEqual({ starts: [3, 4, 5], ends: [4, 5] });
  });

  it("a line ending the handler swapped for a space, one unit for one unit", () => {
    expect(inlineCodeSpelling("a\n# b", "`a # b`")).toEqual({
      starts: [1, 2, 3, 4, 5, 6],
      ends: [2, 3, 4, 5, 6],
    });
  });

  it("an astral value: one unit per unit, the pair two entries", () => {
    expect(inlineCodeSpelling("😀", "`😀`")).toEqual({ starts: [1, 2, 3], ends: [2, 3] });
  });

  it("refuses a string that is not fence, padding, value, padding, fence", () => {
    expect(inlineCodeSpelling("cd", "cd")).toBeUndefined();
    expect(inlineCodeSpelling("cd", "`cd")).toBeUndefined();
    expect(inlineCodeSpelling("cd", "``cd`")).toBeUndefined();
    expect(inlineCodeSpelling("cd", "`ce`")).toBeUndefined();
    expect(inlineCodeSpelling("cd", "`xcd `")).toBeUndefined();
    expect(inlineCodeSpelling("cd", "`cdx`")).toBeUndefined();
  });
});
