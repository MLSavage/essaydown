import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Nodes, Root } from "mdast";
import type { Node as PMNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { format } from "../../core/src/format.js";
import { parse } from "../../core/src/parse.js";
import { formatWithMap } from "../../core/src/positions.js";
import { mdastToPM, pmToMdast, schema } from "../src/schema.js";

/**
 * URL-shaped text keeps the writer's bytes, through the editor (task 3.14, DECISIONS
 * #review-1-r6 L9). The representation, decided once: the parser marks a GFM autolink literal
 * (`data.autolinkLiteral`), the editor's link mark carries it (`literal`), and the formatter writes
 * a marked literal bare and a literal inside typed text unescaped, so text keeps no escapes and the
 * fixed point holds on the re-linked form — typed text comes back from `parse` as a literal link,
 * which is written as the same bytes.
 *
 * The corpus leg types a URL at the end of every textblock (fenced code aside) of every fixture
 * in index.json, three ways — the URL, the URL followed by `.`, and the URL inside emphasis — and
 * asserts that the copied bytes (`format ∘ pmToMdast`, what the copy button and the save write)
 * hold each URL exactly as typed, once per block typed in; that they are a fixed point of
 * parse∘format, and of the editor's own trip; that the parse holds one literal link per URL typed;
 * and that the position map of the editor's output reports nothing unresolved. A fourth,
 * destructive transaction deletes the space typed before the URL, so the URL is flush against
 * whatever the block ended with: the bytes are still a fixed point and the map still places every
 * node, whichever form the formatter had to take.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/markdown", import.meta.url));
const index = JSON.parse(readFileSync(`${FIXTURES}/index.json`, "utf8")) as Record<string, unknown>;
const names = Object.keys(index).sort();

const URL_TYPED = "https://example.com/a_b";

interface Variant {
  name: string;
  /** What the bytes hold, unescaped, for each block typed in. */
  bytes: string;
  /** Whether the URL is typed inside emphasis (and is then inside emphasis in the parse). */
  emphasis: boolean;
  /** What is typed after the URL, outside any mark. */
  after: string;
}

// The emphasis variant's bytes are the URL alone: a block that ends in emphasis takes the typed
// space into its own run (`insertText` keeps the inclusive mark), so the URL joins that run —
// `*(b) https://example.com/a_b*` — and the closing `*` is not always the URL's neighbour.
const VARIANTS: Variant[] = [
  { name: "the URL", bytes: URL_TYPED, emphasis: false, after: "" },
  { name: "the URL followed by `.`", bytes: `${URL_TYPED}.`, emphasis: false, after: "." },
  { name: "the URL inside emphasis", bytes: URL_TYPED, emphasis: true, after: "" },
];

/** The end of every textblock outside a fenced code block, in document order. */
function blockEnds(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type === schema.nodes.code_block) return false;
    if (node.isTextblock) {
      out.push(pos + 1 + node.content.size);
      return false;
    }
    return true;
  });
  return out;
}

/**
 * A typing-shaped transaction: at the end of every block, a space, then the URL (with the
 * emphasis mark when the variant asks), then `after`, applied back-to-front so each insertion
 * leaves the positions still to come unmoved. `insertText` is what `typing.ts` calls per key.
 * `spaces` is where each typed space sits in the changed document, for the destructive leg.
 */
function typeUrlAtEveryBlockEnd(
  doc: PMNode,
  variant: Variant,
): { doc: PMNode; blocks: number; spaces: number[] } {
  const ends = blockEnds(doc);
  let tr = EditorState.create({ doc }).tr;
  for (const pos of [...ends].reverse()) {
    tr = tr.insertText(" ", pos);
    tr = tr.insert(
      pos + 1,
      schema.text(URL_TYPED, variant.emphasis ? [schema.marks.emphasis.create()] : []),
    );
    if (variant.after !== "") tr = tr.insert(pos + 1 + URL_TYPED.length, schema.text(variant.after));
  }
  const typed = 1 + URL_TYPED.length + variant.after.length;
  return { doc: tr.doc, blocks: ends.length, spaces: ends.map((pos, k) => pos + k * typed) };
}

/** The destructive transaction: the space typed before each URL deleted again, back-to-front. */
function deleteSpaces(doc: PMNode, spaces: readonly number[]): PMNode {
  let tr = EditorState.create({ doc }).tr;
  for (const pos of [...spaces].reverse()) {
    expect(doc.textBetween(pos, pos + 1), `the typed space at ${pos}`).toBe(" ");
    tr = tr.delete(pos, pos + 1);
  }
  return tr.doc;
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

/** The literal links of a parsed tree whose url is the typed URL, and whether each is under emphasis. */
function typedLiterals(root: Root): boolean[] {
  const out: boolean[] = [];
  const walk = (node: Nodes, emphasised: boolean): void => {
    if (node.type === "link" && node.url === URL_TYPED && node.data?.autolinkLiteral === true) {
      out.push(emphasised);
    }
    const inside = emphasised || node.type === "emphasis";
    if ("children" in node) for (const child of node.children as Nodes[]) walk(child, inside);
  };
  walk(root, false);
  return out;
}

/** The bytes the editor writes for `doc`, and the same bytes after a load into the editor. */
function written(doc: PMNode, frontMatter: ReturnType<typeof mdastToPM>["frontMatter"]): { root: Root; bytes: string } {
  const root = pmToMdast({ doc, frontMatter });
  return { root, bytes: format(root) };
}

function reloaded(bytes: string): string {
  return format(pmToMdast(mdastToPM(parse(bytes))));
}

describe("URL-shaped text keeps the writer's bytes: a URL typed into every block of every fixture through the editor (task 3.14)", () => {
  let typedIn = 0;
  for (const variant of VARIANTS) {
    it.each(names)(`${variant.name}, typed at every block end, %s: the copied bytes hold it exactly as typed and are a fixed point`, (name) => {
      const editor = mdastToPM(parse(readFileSync(`${FIXTURES}/${name}`, "utf8")));
      const { doc, blocks } = typeUrlAtEveryBlockEnd(editor.doc, variant);
      const { root, bytes } = written(doc, editor.frontMatter);
      expect(count(bytes, variant.bytes), `${name}: the URL as typed, once per block`).toBe(blocks);
      expect(format(parse(bytes)), `${name}: parse∘format fixed point`).toBe(bytes);
      expect(reloaded(bytes), `${name}: the editor's own trip`).toBe(bytes);
      expect(typedLiterals(parse(bytes)), `${name}: one literal link per URL, emphasised as typed`).toEqual(
        Array.from({ length: blocks }, () => variant.emphasis),
      );
      const mapped = formatWithMap(root);
      expect(mapped.text, `${name}: the map is of the copied bytes`).toBe(bytes);
      expect(mapped.map.unresolved, `${name}: nothing unresolved`).toEqual([]);
      typedIn += blocks;
    });
  }

  it.each(names)("the destructive leg, %s: the space before every typed URL deleted, the bytes are still a fixed point and the map places every node", (name) => {
    const editor = mdastToPM(parse(readFileSync(`${FIXTURES}/${name}`, "utf8")));
    const typed = typeUrlAtEveryBlockEnd(editor.doc, VARIANTS[0]);
    const doc = deleteSpaces(typed.doc, typed.spaces);
    expect(doc.content.size, `${name}: one unit deleted per block`).toBe(typed.doc.content.size - typed.blocks);
    const { root, bytes } = written(doc, editor.frontMatter);
    expect(format(parse(bytes)), `${name}: parse∘format fixed point`).toBe(bytes);
    const mapped = formatWithMap(root);
    expect(mapped.text).toBe(bytes);
    expect(mapped.map.unresolved, `${name}: nothing unresolved`).toEqual([]);
  });

  it("typed into some block of the corpus", () => {
    expect(typedIn).toBeGreaterThan(names.length);
  });
});

describe("a loaded file holding a bare URL, an angle-bracket autolink and a `[text](url)` link saves byte-identical (task 3.14)", () => {
  const FILES = [
    "See https://example.com/a_b for details.\n",
    "See <https://example.com/a_b> for details.\n",
    "See [the essay](https://example.com/a_b) for details.\n",
    "See https://example.com/a_b, <https://example.com/a_b> and [the essay](https://example.com/a_b).\n",
  ];
  for (const file of FILES) {
    it(`${JSON.stringify(file)}: unedited and after the editor's trip, the save writes the file's bytes`, () => {
      expect(format(parse(file))).toBe(file);
      expect(reloaded(file)).toBe(file);
    });
  }

  it("the editor's link mark carries the literal flag for the bare URL only, and gives it back", () => {
    const { doc, frontMatter } = mdastToPM(parse(FILES[3]));
    const literals: boolean[] = [];
    doc.descendants((node) => {
      const link = schema.marks.link.isInSet(node.marks);
      if (link !== undefined) literals.push(link.attrs.literal as boolean);
      return true;
    });
    expect(literals).toEqual([true, false, false]);
    const links: (true | undefined)[] = [];
    const walk = (node: Nodes): void => {
      if (node.type === "link") links.push(node.data?.autolinkLiteral);
      if ("children" in node) for (const child of node.children as Nodes[]) walk(child);
    };
    walk(pmToMdast({ doc, frontMatter }));
    expect(links).toEqual([true, undefined, undefined]);
  });
});

describe("a literal link tied with a flanking mark nests inside it (task 3.14 guard: outermostMark)", () => {
  /** One paragraph holding `value` under `marks`, converted to mdast; the paragraph's one child. */
  function nested(value: string, literal: boolean): Nodes {
    const link = schema.marks.link.create({ url: value, title: null, literal });
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text(value, [link, schema.marks.emphasis.create()])]),
    ]);
    const root = pmToMdast({ doc, frontMatter: null });
    return (root.children[0] as { children: Nodes[] }).children[0];
  }

  it("presence: a literal link under emphasis over the same run is emphasis around the link, written bare", () => {
    const node = nested("https://a.b", true);
    expect(node.type).toBe("emphasis");
    expect(format({ type: "root", children: [{ type: "paragraph", children: [node as never] }] })).toBe(
      "*https://a.b*\n",
    );
  });

  it("absence: a link that is not a literal, over a run with no edge whitespace, stays outermost", () => {
    expect(nested("https://a.b", false).type).toBe("link");
  });
});
