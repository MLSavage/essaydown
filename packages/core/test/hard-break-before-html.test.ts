import { describe, expect, it } from "vitest";
import type { Nodes, Root } from "mdast";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import { formatWithMap } from "../src/positions.js";

/**
 * **A hard `break` before inline `html` was written as a backslash and a space, and the break was
 * lost** (task 1.58, DECISIONS #review-1-r7 M2 — Claude finding 2 and Sol finding 1, both
 * blockers).
 *
 * `mdast-util-to-markdown/lib/util/container-phrasing.js` (2.1.2) lines 60–80 replace the
 * *previous result's* trailing line ending by one space before an `html` child whatever node
 * wrote it, so the `break` handler's `\` + line ending became `\` + a space — bytes no parser
 * reads as a break, and a literal backslash the writer never typed. Invariant B failed on the
 * parser's own tree: `parse(format(root))` held `text "alpha\ "`, `html`, … and no `break`.
 *
 * The fix is in task 1.57's per-child walk in format.ts: a `break` child located at region 4's
 * form is written as its own output — the line ending kept — exactly when the pair reparses to a
 * `break` directly followed by an `html`, and as one space with no backslash otherwise. The
 * criterion is that round trip itself, never a hand list of tag names (lesson [1.10.r6d]).
 *
 * The guards below are enumerated from the fix's diff, not from the acceptance sentences:
 *
 * - the kept group, every (source form, html tag, left neighbour) tuple: both spellings of a hard
 *   break in the source (a backslash then the line ending; two spaces then the line ending) ×
 *   `<i>`, `<span>`, `<b>` × the break after plain text, after `*ab*`, after a code span, after a
 *   link, after an html node, inside a blockquote and inside a list item;
 * - the space group, the html values CommonMark §4.6 conditions 1–6 let open an html block, where
 *   keeping the line ending would turn the next line into one and the break is a documented loss;
 * - the 1.51 control: a *soft* break before html is still written as one space, unchanged.
 */

/** Every `break` anywhere in `tree`, counted by a walk rather than by a pattern over the bytes. */
function breakCount(tree: Nodes): number {
  let count = tree.type === "break" ? 1 : 0;
  if ("children" in tree) {
    for (const child of tree.children) count += breakCount(child as Nodes);
  }
  return count;
}

/* ------------------------------------------------- the kept group: the break survives, in bytes -- */

/** One left neighbour of the break, as the source spells it before the line break. */
interface LeftNeighbour {
  /** The case title's name for it. */
  name: string;
  /** The source of everything on the break's line before the break itself. */
  head: string;
  /** What each of the two following lines is prefixed with (a container's marker, or nothing). */
  prefix: [string, string];
}

const LEFT_NEIGHBOURS: readonly LeftNeighbour[] = [
  { name: "plain text", head: "alpha", prefix: ["", ""] },
  { name: "`*ab*`", head: "*ab*", prefix: ["", ""] },
  { name: "a code span", head: "`ab`", prefix: ["", ""] },
  { name: "a link", head: "[ab](u)", prefix: ["", ""] },
  { name: "an html node", head: "<em>ab</em>", prefix: ["", ""] },
  { name: "inside a blockquote", head: "alpha", prefix: ["> ", "> "] },
  { name: "inside a list item", head: "alpha", prefix: ["- ", "  "] },
];

/** The two spellings of a hard break CommonMark §6.7 accepts, both ending the line. */
const SOURCE_FORMS: readonly { name: string; spelling: string }[] = [
  { name: "backslash", spelling: "\\\n" },
  { name: "two spaces", spelling: "  \n" },
];

/** The inline tags of CommonMark §4.6 condition 7, which cannot interrupt a paragraph. */
const INLINE_TAGS = ["<i>beta</i>", "<span>beta</span>", "<b>beta</b>"] as const;

describe("a hard break before inline html keeps its line ending", () => {
  for (const left of LEFT_NEIGHBOURS) {
    for (const tag of INLINE_TAGS) {
      for (const form of SOURCE_FORMS) {
        it(`${left.name}, ${tag.slice(0, tag.indexOf(">") + 1)}, the ${form.name} source form`, () => {
          const [firstPrefix, secondPrefix] = left.prefix;
          const source = `${firstPrefix}${left.head}${form.spelling}${secondPrefix}${tag} gamma\n`;
          const tree = parse(source);
          expect(breakCount(tree)).toBe(1);

          // Both source spellings are one `break` node, so both serialize to the canonical
          // backslash form — the bytes asserted here, with the line ending kept before the tag.
          const expected = `${firstPrefix}${left.head}\\\n${secondPrefix}${tag} gamma\n`;
          const out = format(tree);
          expect(out).toBe(expected);
          expect(out).not.toContain("\\ ");

          // The break is still a break on the parser's own tree (invariant B), the bytes are a
          // fixed point of `parse ∘ format` (invariant A), and the map places every node.
          expect(breakCount(parse(out))).toBe(breakCount(tree));
          expect(format(parse(out))).toBe(out);
          expect(formatWithMap(tree).map.unresolved).toEqual([]);
        });
      }
    }
  }
});

/* ------------------------------ the space group: the html value can open a block, the break lost -- */

/**
 * A `break` before an html value of CommonMark §4.6 conditions 1–6 cannot be written with its
 * line ending: the next line would open an html block and the paragraph would end at the break.
 * These trees are built by hand for exactly that reason — no source spells them, because the
 * parser would read the second line as flow html.
 */
function brokenBefore(html: string): Root {
  return {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [{ type: "text", value: "a" }, { type: "break" }, { type: "html", value: html }],
      },
    ],
  };
}

/** The condition each value opens a block by, named so the case titles carry the reason. */
const BLOCK_CAPABLE: readonly { value: string; condition: string }[] = [
  { value: "<div>x</div>", condition: "condition 6, a known block-level tag name" },
  { value: "<!-- c -->", condition: "condition 2, a comment" },
  { value: "<script>x</script>", condition: "condition 1, a script tag" },
  { value: "<?x?>", condition: "condition 3, a processing instruction" },
  { value: "<![CDATA[x]]>", condition: "condition 5, a CDATA section" },
];

describe("a hard break before block-capable html is written as one space: the break is lost", () => {
  for (const { value, condition } of BLOCK_CAPABLE) {
    it(`${value} (${condition}): one space, no backslash — the break is lost, by design`, () => {
      const tree = brokenBefore(value);
      expect(breakCount(tree)).toBe(1);

      const out = format(tree);
      expect(out).toBe(`a ${value}\n`);
      expect(out).not.toContain("\\");

      // The documented loss: the break is gone from the reparse, as it was before this fix, but
      // it is gone as a word space and not as a stray backslash — docs/V1.1-BACKLOG.md,
      // `[#030 product, a soft or hard break before inline html]`.
      expect(breakCount(parse(out))).toBe(0);
      expect(format(parse(out))).toBe(out);

      // The html child's own bytes are untouched, and it is still one inline `html` node.
      expect(parse(out).children).toHaveLength(1);
      expect(out).toContain(value);
    });
  }
});

/* ------------------------------------------------------------------- the 1.51 control, unchanged -- */

describe("a soft break before inline html is still one space (task 1.51, unchanged)", () => {
  const CASES = [
    { source: "alpha\n<i>beta</i>\n", expected: "alpha <i>beta</i>\n" },
    { source: "alpha beta\n<span>x</span> gamma\n", expected: "alpha beta <span>x</span> gamma\n" },
    { source: "*a*\n<b>x</b>\n", expected: "*a* <b>x</b>\n" },
  ];
  for (const { source, expected } of CASES) {
    it(`${JSON.stringify(source)} is unchanged`, () => {
      const tree = parse(source);
      expect(breakCount(tree)).toBe(0);
      const out = format(tree);
      expect(out).toBe(expected);
      expect(format(parse(out))).toBe(out);
      expect(formatWithMap(tree).map.unresolved).toEqual([]);
    });
  }
});
