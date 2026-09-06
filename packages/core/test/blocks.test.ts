import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Heading, Image, ListItem, Paragraph, Root, RootContent, TableRow } from "mdast";
import { describe, expect, it } from "vitest";
import {
  blocksOf,
  moveBlock,
  moveSection,
  normalizedText,
  replaceBlock,
  sectionsOf,
  setHeadingDepth,
} from "../src/blocks.js";
import { contentHash } from "../src/hash.js";
import { format } from "../src/format.js";
import { parse } from "../src/parse.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

interface IndexEntry {
  nodeTypes: string[];
  blockCount: number;
  sectionCount: number;
  paragraphStartLines: number[];
}

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, IndexEntry>;

function fixture(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

function paragraph(text: string): Paragraph {
  return { type: "paragraph", children: [{ type: "text", value: text }] };
}

function listItem(text: string): ListItem {
  return { type: "listItem", spread: false, children: [paragraph(text)] };
}

function tableRow(cells: string[]): TableRow {
  return {
    type: "tableRow",
    children: cells.map((cell) => ({ type: "tableCell", children: [{ type: "text", value: cell }] })),
  };
}

/** A structural snapshot, so purity can be asserted without depending on node identity. */
function snapshot(root: Root): string {
  return JSON.stringify(root);
}

function headingDepths(root: Root): number[] {
  return root.children.filter((c): c is Heading => c.type === "heading").map((h) => h.depth);
}

describe("blocksOf (PRD §6.1)", () => {
  it("yields the blockCount fixtures/markdown/index.json records for the essay fixture", () => {
    const root = parse(fixture("essay-fixture.canonical.md"));
    expect(blocksOf(root)).toHaveLength(index["essay-fixture.md"].blockCount);
  });

  it("counts a direct child of root, each listItem and each tableRow — and nothing else", () => {
    // Every fixture's block count is exactly root's children + its listItems + its tableRows,
    // both summands present across the corpus (some fixtures have neither, some have both).
    const names = Object.keys(index);
    let withNested = 0;
    for (const name of names) {
      const root = parse(fixture(name.replace(/\.md$/, ".canonical.md")));
      const blocks = blocksOf(root);
      const nested = blocks.filter((b) => b.path.length > 1);
      const topLevel = blocks.filter((b) => b.path.length === 1);
      expect(topLevel).toHaveLength(root.children.length);
      for (const block of nested) {
        expect(["listItem", "tableRow"]).toContain(block.node.type);
      }
      expect(blocks).toHaveLength(index[name].blockCount);
      if (nested.length > 0) withNested += 1;
    }
    expect(withNested).toBeGreaterThan(0);
    expect(withNested).toBeLessThan(names.length);
  });

  it("reaches listItems nested three deep and tableRows inside a table", () => {
    const lists = blocksOf(parse(fixture("nested-lists.canonical.md")));
    const items = lists.filter((b) => b.node.type === "listItem");
    expect(items.length).toBeGreaterThan(0);
    // A 3-deep list puts a listItem at path depth 6 (list > item > list > item > list > item).
    expect(Math.max(...items.map((b) => b.path.length))).toBeGreaterThanOrEqual(5);

    const table = blocksOf(parse(fixture("table-escaped-pipes.canonical.md")));
    const rows = table.filter((b) => b.node.type === "tableRow");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.path).toHaveLength(2);
    // Table cells are not blocks.
    expect(table.some((b) => b.node.type === "tableCell")).toBe(false);
  });

  it("gives every block a 13-char base-36 hash and a 0-based occurrence", () => {
    const blocks = blocksOf(parse(fixture("essay-fixture.canonical.md")));
    for (const block of blocks) {
      expect(block.contentId).toMatch(/^[0-9a-z]{13}-\d+$/);
      expect(block.contentId).toBe(`${block.hash}-${block.occurrence}`);
      expect(block.hash).toBe(contentHash(block.text));
    }
    expect(new Set(blocks.map((b) => b.contentId)).size).toBe(blocks.length);
  });

  it("gives two identical paragraphs ids ending -0 and -1, in document order", () => {
    const root = parse("Same text here.\n\nDifferent.\n\nSame text here.\n\nSame text here.\n");
    const ids = blocksOf(root).map((b) => b.contentId);
    const same = contentHash("Same text here.");
    const different = contentHash("Different.");
    expect(ids).toEqual([`${same}-0`, `${different}-0`, `${same}-1`, `${same}-2`]);
  });

  it("returns the caller's own nodes and mutates nothing", () => {
    const root = parse(fixture("nested-lists.canonical.md"));
    const before = snapshot(root);
    const blocks = blocksOf(root);
    expect(blocks[0].node).toBe(root.children[0]);
    expect(snapshot(root)).toBe(before);
  });
});

describe("normalizedText", () => {
  it("collapses whitespace and trims, so a re-wrap keeps the same id", () => {
    const wrapped = parse("One two\nthree   four.\n");
    const flat = parse("One two three four.\n");
    expect(normalizedText(wrapped.children[0])).toBe("One two three four.");
    expect(blocksOf(wrapped)[0].contentId).toBe(blocksOf(flat)[0].contentId);
  });

  it("takes value nodes verbatim and image alt text", () => {
    const code = parse("```js\nconst a = 1;\n```\n");
    expect(normalizedText(code.children[0])).toBe("const a = 1;");

    const html = parse("<div>\n  <span>raw</span>\n</div>\n");
    expect(normalizedText(html.children[0])).toContain("<span>raw</span>");

    const yaml = parse("---\ntitle: A\n---\n\nBody.\n");
    expect(normalizedText(yaml.children[0])).toBe("title: A");

    const inline = parse("Some `code` and *emphasis*.\n");
    expect(normalizedText(inline.children[0])).toBe("Some code and emphasis.");

    const image = parse("![a picture](pic.png)\n");
    expect(normalizedText(image.children[0])).toBe("a picture");
  });

  it("treats a missing image alt as empty and a hard break as a space", () => {
    const noAlt: Image = { type: "image", url: "pic.png", alt: null };
    expect(normalizedText(noAlt)).toBe("");
    const withBreak = parse("One  \ntwo\n");
    expect(normalizedText(withBreak.children[0])).toBe("One two");
  });

  it("gives a childless non-value node the empty string", () => {
    const rule = parse("---\n\nAfter.\n");
    expect(rule.children[0].type).toBe("thematicBreak");
    expect(normalizedText(rule.children[0])).toBe("");
  });
});

describe("sectionsOf (PRD §6.1)", () => {
  it("yields the sectionCount fixtures/markdown/index.json records for the essay fixture", () => {
    const root = parse(fixture("essay-fixture.canonical.md"));
    expect(sectionsOf(root)).toHaveLength(index["essay-fixture.md"].sectionCount);
  });

  it("runs a section up to the next heading of equal or shallower depth", () => {
    const root = parse("Intro.\n\n## A\n\nBody.\n\n### A1\n\nMore.\n\n## B\n\nEnd.\n");
    const sections = sectionsOf(root);
    expect(sections.map((s) => s.depth)).toEqual([2, 3, 2]);
    // "## A" stops at "## B" (equal depth) and so contains its "### A1" subsection.
    expect(sections[0].start).toBe(1);
    expect(sections[0].end).toBe(sections[2].start);
    expect(sections[0].nodes).toHaveLength(4);
    // "### A1" stops at the shallower "## B".
    expect(sections[1].start).toBeGreaterThan(sections[0].start);
    expect(sections[1].end).toBe(sections[2].start);
    // The last section runs to the end of the document.
    expect(sections[2].end).toBe(root.children.length);
    // Content before the first heading belongs to no section.
    expect(sections.every((s) => s.start > 0)).toBe(true);
  });

  it("returns no sections for a document with no headings", () => {
    expect(sectionsOf(parse("Just a paragraph.\n"))).toHaveLength(0);
  });

  it("mutates nothing", () => {
    const root = parse(fixture("essay-fixture.canonical.md"));
    const before = snapshot(root);
    sectionsOf(root);
    expect(snapshot(root)).toBe(before);
  });
});

describe("replaceBlock", () => {
  it("replaces a top-level block by contentId without touching the input", () => {
    const root = parse("One.\n\nTwo.\n");
    const before = snapshot(root);
    const target = blocksOf(root)[1];
    const next = replaceBlock(root, target.contentId, paragraph("Three."));
    expect(format(next)).toBe("One.\n\nThree.\n");
    expect(snapshot(root)).toBe(before);
  });

  it("replaces a block with a different block type", () => {
    const root = parse("One.\n\nTwo.\n");
    const target = blocksOf(root)[1];
    const heading: Heading = { type: "heading", depth: 2, children: [{ type: "text", value: "Two" }] };
    expect(format(replaceBlock(root, target.contentId, heading))).toBe("One.\n\n## Two\n");
  });

  it("replaces a nested listItem", () => {
    const root = parse("- one\n- two\n");
    const target = blocksOf(root).find((b) => b.node.type === "listItem" && b.text === "two");
    expect(target).toBeDefined();
    const next = replaceBlock(root, target!.contentId, listItem("three"));
    expect(format(next)).toBe("- one\n- three\n");
  });

  it("replaces a nested tableRow", () => {
    const root = parse("| a | b |\n| - | - |\n| c | d |\n");
    const target = blocksOf(root).find((b) => b.node.type === "tableRow" && b.text === "cd");
    expect(target).toBeDefined();
    const next = replaceBlock(root, target!.contentId, tableRow(["e", "f"]));
    expect(format(next)).toContain("| e | f |");
    expect(format(next)).not.toContain("| c | d |");
  });

  it("refuses to put a non-listItem where a listItem was, or a non-tableRow where a tableRow was", () => {
    const list = parse("- one\n");
    const item = blocksOf(list).find((b) => b.node.type === "listItem");
    expect(() => replaceBlock(list, item!.contentId, paragraph("nope"))).toThrow(/listItem/);

    const table = parse("| a |\n| - |\n| c |\n");
    const row = blocksOf(table).find((b) => b.node.type === "tableRow");
    expect(() => replaceBlock(table, row!.contentId, paragraph("nope"))).toThrow(/tableRow/);
  });

  it("throws when no block carries the contentId", () => {
    const root = parse("One.\n");
    expect(() => replaceBlock(root, "0000000000000-0", paragraph("x"))).toThrow(/no block with contentId/);
  });

  it("copies the replacement, so later edits to it do not reach the document", () => {
    const root = parse("One.\n");
    const replacement = paragraph("Two.");
    const next = replaceBlock(root, blocksOf(root)[0].contentId, replacement);
    (replacement.children[0] as { value: string }).value = "Mutated.";
    expect(format(next)).toBe("Two.\n");
  });
});

describe("moveBlock", () => {
  it("moves a top-level block backwards and forwards without touching the input", () => {
    const root = parse("A.\n\nB.\n\nC.\n");
    const before = snapshot(root);
    expect(format(moveBlock(root, 2, 0))).toBe("C.\n\nA.\n\nB.\n");
    expect(format(moveBlock(root, 0, 2))).toBe("B.\n\nC.\n\nA.\n");
    expect(format(moveBlock(root, 1, 1))).toBe("A.\n\nB.\n\nC.\n");
    expect(snapshot(root)).toBe(before);
  });

  it("rejects a non-integer, a negative and an out-of-document index", () => {
    const root = parse("A.\n\nB.\n");
    expect(() => moveBlock(root, 0.5, 0)).toThrow(RangeError);
    expect(() => moveBlock(root, -1, 0)).toThrow(RangeError);
    expect(() => moveBlock(root, 0, 2)).toThrow(RangeError);
  });
});

describe("moveSection", () => {
  it("moves essay-fixture section 2 to the front, matching expected/essay-fixture.moved.md", () => {
    const canonical = fixture("essay-fixture.canonical.md");
    const root = parse(canonical);
    const before = snapshot(root);
    const expected = readFileSync(`${FIXTURES}/expected/essay-fixture.moved.md`, "utf8");
    expect(format(moveSection(root, 2, 0))).toBe(expected);
    expect(snapshot(root)).toBe(before);
    // The golden is a reordering, not a rewrite: same lines, different order.
    expect(expected.split("\n").sort()).toEqual(canonical.split("\n").sort());
    expect(expected).not.toBe(canonical);
  });

  it("carries the whole section, subsections included, and leaves depths alone", () => {
    const root = parse("## A\n\na.\n\n### A1\n\na1.\n\n## B\n\nb.\n");
    const moved = moveSection(root, 0, 2);
    expect(format(moved)).toBe("## B\n\nb.\n\n## A\n\na.\n\n### A1\n\na1.\n");
    expect(headingDepths(moved)).toEqual([2, 2, 3]);
  });

  it("lands a section before the target when moving backwards and after it when moving forwards", () => {
    const root = parse("## A\n\n## B\n\n## C\n");
    expect(format(moveSection(root, 2, 0))).toBe("## C\n\n## A\n\n## B\n");
    expect(format(moveSection(root, 0, 1))).toBe("## B\n\n## A\n\n## C\n");
    expect(format(moveSection(root, 1, 1))).toBe("## A\n\n## B\n\n## C\n");
  });

  it("keeps material before the first heading in place", () => {
    const root = parse("Preamble.\n\n## A\n\n## B\n");
    expect(format(moveSection(root, 1, 0))).toBe("Preamble.\n\n## B\n\n## A\n");
  });

  it("refuses to move a section into itself", () => {
    const root = parse("## A\n\n### A1\n\n## B\n");
    expect(() => moveSection(root, 0, 1)).toThrow(/inside/);
  });

  it("rejects a non-integer, a negative and an out-of-document section index", () => {
    const root = parse("## A\n\n## B\n");
    expect(() => moveSection(root, 0.5, 0)).toThrow(RangeError);
    expect(() => moveSection(root, -1, 0)).toThrow(RangeError);
    expect(() => moveSection(root, 0, 2)).toThrow(RangeError);
  });
});

describe("setHeadingDepth", () => {
  it("re-depths an H2 with H3 children to H3 with H4 children", () => {
    const root = parse("## Parent\n\nBody.\n\n### Child\n\nMore.\n\n## Next\n");
    const before = snapshot(root);
    const next = setHeadingDepth(root, 0, 3);
    // The section's own heading becomes H3, its H3 child becomes H4, the next section is untouched.
    expect(headingDepths(next)).toEqual([3, 4, 2]);
    expect(format(next)).toBe("### Parent\n\nBody.\n\n#### Child\n\nMore.\n\n## Next\n");
    expect(snapshot(root)).toBe(before);
  });

  it("promotes as well as demotes, keeping the relative shape", () => {
    const root = parse("### Parent\n\n#### Child\n\n### Sibling\n");
    expect(headingDepths(setHeadingDepth(root, 0, 2))).toEqual([2, 3, 3]);
  });

  it("is a no-op when the depth is already the section's depth", () => {
    const root = parse("## A\n\n### A1\n");
    expect(format(setHeadingDepth(root, 0, 2))).toBe("## A\n\n### A1\n");
  });

  it("rejects a depth outside 1..6", () => {
    const root = parse("## A\n");
    expect(() => setHeadingDepth(root, 0, 0)).toThrow(RangeError);
    expect(() => setHeadingDepth(root, 0, 7)).toThrow(RangeError);
    expect(() => setHeadingDepth(root, 0, 1.5)).toThrow(RangeError);
  });

  it("rejects a shift that would push a descendant heading past depth 6", () => {
    const root = parse("## A\n\n### A1\n\n#### A1a\n");
    expect(() => setHeadingDepth(root, 0, 5)).toThrow(/depth 7/);
    // The same shift is fine when the section has no descendants that deep.
    expect(headingDepths(setHeadingDepth(root, 2, 6))).toEqual([2, 3, 6]);
  });

  it("rejects a section index outside the document", () => {
    const root = parse("## A\n");
    expect(() => setHeadingDepth(root, 1, 3)).toThrow(RangeError);
  });
});

describe("purity across the whole algebra", () => {
  it("leaves the input root byte-identical after every operation", () => {
    const root = parse(fixture("essay-fixture.canonical.md"));
    const before = snapshot(root);
    const canonical = format(root);
    const id = blocksOf(root)[0].contentId;

    replaceBlock(root, id, paragraph("x"));
    moveBlock(root, 0, 3);
    moveSection(root, 2, 0);
    setHeadingDepth(root, 0, 3);

    expect(snapshot(root)).toBe(before);
    expect(format(root)).toBe(canonical);
  });

  it("returns a root the formatter still round-trips", () => {
    const root = parse(fixture("essay-fixture.canonical.md"));
    const moved = moveSection(root, 2, 0);
    const output = format(moved);
    expect(format(parse(output))).toBe(output);
  });
});

describe("blocks of the moved essay golden", () => {
  it("preserves the corpus block and section counts", () => {
    const entry = index["essay-fixture.md"];
    const golden = parse(readFileSync(`${FIXTURES}/expected/essay-fixture.moved.md`, "utf8"));
    expect(blocksOf(golden)).toHaveLength(entry.blockCount);
    expect(sectionsOf(golden)).toHaveLength(entry.sectionCount);
  });
});

describe("mdast typing guards", () => {
  it("keeps the RootContent union usable for callers building replacements", () => {
    const nodes: RootContent[] = [paragraph("a"), { type: "thematicBreak" }];
    const root: Root = { type: "root", children: nodes };
    expect(blocksOf(root)).toHaveLength(2);
  });
});
