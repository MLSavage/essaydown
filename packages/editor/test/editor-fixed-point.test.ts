import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Root } from "mdast";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";

/**
 * Task 1.13 (DECISIONS #review-1-r0 F1): the editor's tree kept the whitespace micromark strips,
 * so `format` encoded a trailing space typed before Enter as a numeric character reference, and
 * the editor's Markdown was not a fixed point of `parse`∘`format`.
 *
 * Two suites. The first is one test per guard in `trimBlockEnds` (schema.ts), enumerated from the
 * diff rather than from the acceptance: the two ends it strips, the three neighbours it must not
 * touch, the run it drops, and the third block type it runs on. The second is the corpus leg the
 * review's risk 1 named — every other round-trip leg in this repo is seeded from `parse(fixture)`,
 * so the corpus is closed under the parser and a tree only the editor can build is unreachable by
 * construction. This one seeds from the editor's own output instead.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));

const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

function read(name: string): string {
  return readFileSync(`${FIXTURES}/${name}`, "utf8");
}

function paragraph(...content: PMNode[]): PMNode {
  return schema.node("doc", null, [schema.node("paragraph", null, content)]);
}

function mdastOf(doc: PMNode): Root {
  return pmToMdast({ doc, frontMatter: null });
}

describe("block-end whitespace, one test per guard", () => {
  it("guard 1 (leading strip): the leading whitespace of a block's first text run is dropped", () => {
    const root = mdastOf(paragraph(schema.text("  \they")));
    expect(root.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "hey" }] },
    ]);
    expect(format(root)).toBe("hey\n");
  });

  it("guard 2 (trailing strip): the trailing whitespace of a block's last text run is dropped", () => {
    const root = mdastOf(paragraph(schema.text("hey \t")));
    expect(root.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "hey" }] },
    ]);
    expect(format(root)).toBe("hey\n");
    expect(format(root)).not.toContain("&#x20;");
  });

  it("guard 3 (break-adjacent untouched): a text run beside a hard break keeps its spaces", () => {
    const root = mdastOf(
      paragraph(schema.text("one "), schema.node("hard_break"), schema.text(" two ")),
    );
    expect(root.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "one " },
          { type: "break" },
          { type: "text", value: " two" },
        ],
      },
    ]);
  });

  it("guard 4 (inline code untouched): an inline-code run at a block end keeps its literal bytes", () => {
    const code = schema.marks.inline_code.create();
    const root = mdastOf(paragraph(schema.text(" x ", [code])));
    expect(root.children).toEqual([
      { type: "paragraph", children: [{ type: "inlineCode", value: " x " }] },
    ]);
  });

  it("guard 5 (raw untouched): a raw_inline at a block end keeps its bytes and stops the strip", () => {
    const raw = schema.node("raw_inline", { value: "<i> " });
    const inline = mdastOf(paragraph(schema.text("a "), raw));
    expect(inline.children).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "a " },
          { type: "html", value: "<i> " },
        ],
      },
    ]);
    // The block-level opaque node never reaches the strip at all.
    const block = mdastOf(schema.node("doc", null, [schema.node("raw", { value: "<div> \n" })]));
    expect(block.children).toEqual([{ type: "html", value: "<div> \n" }]);
  });

  it("guard 6 (empty run dropped): a run trimmed to nothing is dropped, not kept as an empty node", () => {
    const strong = schema.marks.strong.create();
    const root = mdastOf(paragraph(schema.text("  ", [strong]), schema.text("x")));
    expect(root.children).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "x" }] },
    ]);
    expect(format(root)).toBe("x\n");
  });

  it("guard 7 (table cell): a table cell's own two ends are stripped like a paragraph's", () => {
    const cell = (text: string): PMNode => schema.node("table_cell", null, [schema.text(text)]);
    const root = mdastOf(
      schema.node("doc", null, [
        schema.node("table", { align: null }, [
          schema.node("table_row", null, [cell(" a "), cell("b")]),
          schema.node("table_row", null, [cell("c"), cell(" d ")]),
        ]),
      ]),
    );
    const cells = (row: number): unknown =>
      // @ts-expect-error -- the shape is asserted by the equality below, not by the type
      root.children[0].children[row].children.map((c) => c.children);
    expect(cells(0)).toEqual([[{ type: "text", value: "a" }], [{ type: "text", value: "b" }]]);
    expect(cells(1)).toEqual([[{ type: "text", value: "c" }], [{ type: "text", value: "d" }]]);
    expect(format(root)).not.toContain("&#x20;");
  });

  it("a heading's ends are stripped too (the third block the strip runs on)", () => {
    const root = mdastOf(
      schema.node("doc", null, [schema.node("heading", { depth: 2 }, [schema.text(" H ")])]),
    );
    expect(format(root)).toBe("## H\n");
  });
});

/**
 * A ProseMirror transaction shaped like typing: a space appended at the end of every paragraph and
 * every heading, applied back-to-front so that each insertion leaves the positions still to come
 * unmoved. `insertText` is the same call `typing.ts` makes for a typed character.
 */
function typeSpaceAtEveryBlockEnd(doc: PMNode): { doc: PMNode; blocks: number } {
  const ends: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.paragraph || node.type === schema.nodes.heading) {
      ends.push(pos + 1 + node.content.size);
    }
    return true;
  });
  let tr = EditorState.create({ doc }).tr;
  for (const pos of [...ends].reverse()) tr = tr.insertText(" ", pos);
  return { doc: tr.doc, blocks: ends.length };
}

describe("editor fixed point over the corpus", () => {
  it("asserts one editor fixed point per fixture listed in the index", () => {
    // The count is the index's own length, never a literal (see schema-roundtrip.test.ts).
    expect(names.length).toBe(Object.keys(index).length);
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(`${name} is an editor fixed point after a space is typed at every block end`, () => {
      const canonical = format(parse(read(name)));
      const { doc, frontMatter } = mdastToPM(parse(read(name)));
      const typed = typeSpaceAtEveryBlockEnd(doc);

      // Presence: the transaction really changed this document, wherever it has a block to change.
      expect(typed.doc.eq(doc)).toBe(typed.blocks === 0);

      const out = format(pmToMdast({ doc: typed.doc, frontMatter }));
      expect(out).toBe(canonical);
      expect(format(parse(out))).toBe(out);
      expect(out).not.toContain("&#x20;");
    });

    it(`${name} is an editor fixed point unchanged (the absence case)`, () => {
      const canonical = format(parse(read(name)));
      const out = format(pmToMdast(mdastToPM(parse(read(name)))));
      expect(out).toBe(canonical);
      expect(format(parse(out))).toBe(out);
      expect(out).not.toContain("&#x20;");
    });
  }

  it("at least one fixture in the index has a block the typing transaction can reach", () => {
    const reached = names.filter(
      (name) => typeSpaceAtEveryBlockEnd(mdastToPM(parse(read(name))).doc).blocks > 0,
    );
    expect(reached.length).toBeGreaterThan(0);
  });

  it("the leg can fail: the same tree without the strip serialises to a character reference", () => {
    // The tree `pmToMdast` used to hand the serializer for a paragraph typed as `hello `. The
    // entity is matched as a pattern rather than spelled, so that a grep for it across the test
    // tree turns up only assertions of its absence.
    const untrimmed: Root = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "hello " }] }],
    };
    const serialised = format(untrimmed);
    expect(serialised).not.toBe("hello\n");
    expect(serialised).toMatch(/^hello&#x[0-9a-f]+;\n$/i);
    // …and that is what the corpus leg above compares against `format(parse(x))`, so removing the
    // strip turns every fixture with a paragraph or heading red.
    expect(format(parse("hello\n"))).toBe("hello\n");
  });
});
