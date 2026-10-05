import { describe, expect, it } from "vitest";
import type { Nodes, PhrasingContent, Root } from "mdast";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";
import { formatWithMap } from "../src/positions.js";

/**
 * **A soft line break before inline `html` was written as one space, and the writer's line break
 * was lost** (task 3.15; docs/V1.1-BACKLOG.md `[#030 product, a soft or hard break before inline
 * html]`, DECISIONS #030 Decision 1, #review-1-r7 M2, #050).
 *
 * `mdast-util-to-markdown/lib/util/container-phrasing.js` (2.1.2) lines 60–80 replace the previous
 * result's trailing line ending by one space before any `html` child, so `alpha\n<i>beta</i>` was
 * written `alpha <i>beta</i>`: a text value changed on save. The rewrite is there so the html is
 * not read as an html block, but only CommonMark §4.6 conditions 1–6 can interrupt a paragraph —
 * condition 7, an inline tag, cannot. The fix pre-empts the rewrite per child in format.ts's walk:
 * a `text` child located at region 4's form gets its line ending back exactly when the line ending
 * followed by the html value reparses as a paragraph continuation, and keeps the space otherwise.
 *
 * The guards are the matrix the acceptance names — each html child kind (an inline tag, a comment,
 * a processing instruction, CDATA, a declaration, a block-capable `<div>`) × {soft break, hard
 * break} before it. The trees are built by hand, because the parser never puts a block-capable
 * value on a paragraph's continuation line; the inline-tag rows also run from parsed source.
 */

/** Every node of `tree`, the tree itself included. */
function nodeCount(tree: Nodes): number {
  let count = 1;
  if ("children" in tree) for (const child of tree.children) count += nodeCount(child as Nodes);
  return count;
}

/** One html child kind, its value, and whether CommonMark §4.6 lets it open an html block. */
interface HtmlKind {
  name: string;
  value: string;
  blockCapable: boolean;
}

const HTML_KINDS: readonly HtmlKind[] = [
  { name: "an inline tag (condition 7)", value: "<i>", blockCapable: false },
  { name: "a comment (condition 2)", value: "<!-- c -->", blockCapable: true },
  { name: "a processing instruction (condition 3)", value: "<?x?>", blockCapable: true },
  { name: "a declaration (condition 4)", value: "<!DOCTYPE x>", blockCapable: true },
  { name: "CDATA (condition 5)", value: "<![CDATA[x]]>", blockCapable: true },
  { name: "a block-capable <div> (condition 6)", value: "<div>", blockCapable: true },
];

/** The two breaks a writer puts before the html: the line ending in the text, or a `break`. */
const BREAKS: readonly { name: string; before: PhrasingContent[] }[] = [
  { name: "soft break", before: [{ type: "text", value: "alpha\n" }] },
  { name: "hard break", before: [{ type: "text", value: "alpha" }, { type: "break" }] },
];

function treeOf(before: PhrasingContent[], html: string): Root {
  return {
    type: "root",
    children: [
      {
        type: "paragraph",
        children: [
          ...before.map((node) => ({ ...node })),
          { type: "html", value: html },
          { type: "text", value: " gamma" },
        ],
      },
    ],
  };
}

describe("a break before html keeps its line ending when the html cannot start a block", () => {
  for (const kind of HTML_KINDS) {
    for (const brk of BREAKS) {
      it(`${brk.name} before ${kind.name}`, () => {
        const tree = treeOf(brk.before, kind.value);
        const out = format(tree);
        const head = brk.name === "soft break" ? "alpha" : "alpha\\";
        if (!kind.blockCapable) {
          // The line ending is kept; the reparse is the same tree, node for node (M2).
          expect(out).toBe(`${head}\n${kind.value} gamma\n`);
          expect(nodeCount(parse(out))).toBe(nodeCount(tree));
          expect(parse(out).children).toHaveLength(1);
        } else {
          // The recorded behaviour (task 1.58, DECISIONS #030): one space, no backslash; the line
          // ending would open an html block, so a soft break is a word space and a hard break is
          // lost, a documented loss.
          expect(out).toBe(`alpha ${kind.value} gamma\n`);
          expect(parse(out).children).toHaveLength(1);
          expect(nodeCount(parse(out))).toBe(
            nodeCount(tree) - (brk.name === "hard break" ? 1 : 0),
          );
        }
        expect(format(parse(out))).toBe(out);
        // The map places every node, except the one task 1.58 named: a `break` written as one
        // space has no characters to spell and stays unresolved (positions.ts, `rewrittenEmissions`).
        const { unresolved } = formatWithMap(tree).map;
        if (kind.blockCapable && brk.name === "hard break") expect(unresolved).not.toEqual([]);
        else expect(unresolved).toEqual([]);
      });
    }
  }
});

/** Parsed source, so the tree is the parser's own: the inline tags of condition 7. */
describe("a soft break before inline html survives a save, from parsed source", () => {
  const CASES = [
    "alpha\n<i>beta</i>\n",
    "alpha beta\n<span>x</span> gamma\n",
    "*a*\n<b>x</b>\n",
    "> alpha\n> <i>beta</i> gamma\n",
    "- alpha\n  <i>beta</i> gamma\n",
    "`ab`\n<i>beta</i>\n",
    "[ab](u)\n<i>beta</i>\n",
    "<em>ab</em>\n<i>beta</i>\n",
  ];
  for (const source of CASES) {
    it(`${JSON.stringify(source)} is byte-identical`, () => {
      const tree = parse(source);
      const out = format(tree);
      expect(out).toBe(source);
      expect(nodeCount(parse(out))).toBe(nodeCount(tree));
      expect(formatWithMap(tree).map.unresolved).toEqual([]);
    });
  }
});
