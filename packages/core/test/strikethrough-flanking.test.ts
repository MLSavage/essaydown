import type { Delete, Link, PhrasingContent, Root } from "mdast";
import type { Options } from "remark-stringify";
import type { Data, Processor } from "unified";
import { describe, expect, it } from "vitest";
import { createFormatter, format, handleDelete } from "../src/format.js";
import { parse } from "../src/parse.js";

type ToMarkdownExtensions = NonNullable<Data["toMarkdownExtensions"]>;
type Handlers = NonNullable<Options["handlers"]>;

/**
 * The serializer half of the flanking property (task 1.40, DECISIONS #review-1-r4 J1): a `delete`
 * run's `~~` delimiters must open and close when the bytes are parsed back, whatever character
 * sits directly outside the run. The guards below are enumerated from the table in
 * `mdast-util-to-markdown/lib/util/encode-info.js` — one per side (opening, closing) × neighbour
 * class outside the run (letter, digit, punctuation, whitespace) × inner class at the run's edge
 * (punctuation, letter, inline code, link) — and each asserts three things: the bytes `format`
 * writes, that those bytes parse to exactly one `delete`, and that they are a fixed point of
 * `parse ∘ format`. The trees are built by hand because the parser cannot produce them: the
 * editor reaches them by one deletion (`Alpha ~~beta.~~ gamma` minus the space), and the
 * reconciliation's reproductions appear among the cases by construction, not by name.
 */

const text = (value: string): PhrasingContent => ({ type: "text", value });
const inlineCode = (value: string): PhrasingContent => ({ type: "inlineCode", value });
const link = (...children: PhrasingContent[]): Link => ({
  type: "link",
  title: null,
  url: "u",
  children,
});
const del = (...children: PhrasingContent[]): Delete => ({ type: "delete", children });
const paragraph = (...children: PhrasingContent[]): Root => ({
  type: "root",
  children: [{ type: "paragraph", children }],
});

function countDeletes(root: Root): number {
  let count = 0;
  const walk = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === "delete") count++;
    for (const child of node.children ?? []) walk(child as { type: string; children?: unknown[] });
  };
  walk(root);
  return count;
}

/** A structural clone with every `position` dropped, so a parsed tree compares to a built one. */
function stripPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key !== "position") out[key] = stripPositions(inner);
    }
    return out;
  }
  return value;
}

/**
 * The neighbour outside the run, one text node per class. `encoded` is how the neighbour's edge
 * character comes back when the table says "encode outside": a numeric character reference for a
 * letter or a digit, never for punctuation (Markdown's own constructs are made of it) and never
 * needed beside whitespace, where any run already forms.
 */
const NEIGHBOURS = {
  letter: {
    before: "Alpha",
    after: "gamma delta",
    encodedBefore: "Alph&#x61;",
    encodedAfter: "&#x67;amma delta",
  },
  digit: { before: "1", after: "1", encodedBefore: "&#x31;", encodedAfter: "&#x31;" },
  punctuation: { before: ".", after: ".", encodedBefore: ".", encodedAfter: "." },
  whitespace: {
    before: "Alpha ",
    after: " gamma",
    encodedBefore: "Alpha ",
    encodedAfter: " gamma",
  },
} as const;

/**
 * The run's content, one shape per inner class at the edge under test. `bytes` is the run's
 * content as the serializer writes it; `encodes` says whether the edge character is punctuation
 * in `encode-info.js`'s sense — a letter edge already forms against every neighbour and is left
 * alone. An inline code's edge is its backtick and a link's edge is its bracket, so both sit in
 * the punctuation column of the table even though neither is a text node's character.
 */
const INNERS = {
  closing: {
    punctuation: { children: [text("beta.")], bytes: "beta.", encodes: true },
    letter: { children: [text("beta")], bytes: "beta", encodes: false },
    "inline code": { children: [inlineCode("a")], bytes: "`a`", encodes: true },
    link: { children: [text("a "), link(text("b "))], bytes: "a [b ](u)", encodes: true },
  },
  opening: {
    punctuation: { children: [text("(beta)")], bytes: "(beta)", encodes: true },
    letter: { children: [text("beta")], bytes: "beta", encodes: false },
    "inline code": { children: [inlineCode("a")], bytes: "`a`", encodes: true },
    link: { children: [link(text(" b")), text(" a")], bytes: "[ b](u) a", encodes: true },
  },
} as const;

type NeighbourClass = keyof typeof NEIGHBOURS;
type InnerClass = keyof typeof INNERS.closing;

/** Whether the neighbour class is one the table encodes beside a punctuation edge. */
const ENCODED_OUTSIDE: Record<NeighbourClass, boolean> = {
  letter: true,
  digit: true,
  punctuation: false,
  whitespace: false,
};

describe("strikethrough flanking (task 1.40, J1): the `delete` handler encodes the neighbour a `~~` run cannot form against", () => {
  describe("closing side: the run's last character against the first character after it", () => {
    for (const neighbour of Object.keys(NEIGHBOURS) as NeighbourClass[]) {
      for (const inner of Object.keys(INNERS.closing) as InnerClass[]) {
        it(`(closing, ${neighbour} outside, ${inner} inside): bytes, one delete, fixed point`, () => {
          const shape = INNERS.closing[inner];
          const n = NEIGHBOURS[neighbour];
          // The opening side is whitespace outside a letter edge for every case here, so only the
          // closing side is under test.
          const root = paragraph(text("x "), del(...shape.children), text(n.after));
          const encoded = shape.encodes && ENCODED_OUTSIDE[neighbour];
          const expected = `x ~~${shape.bytes}~~${encoded ? n.encodedAfter : n.after}\n`;
          const bytes = format(root);
          expect(bytes).toBe(expected);
          const reparsed = parse(bytes);
          expect(countDeletes(reparsed)).toBe(1);
          expect(stripPositions(reparsed)).toEqual(stripPositions(root));
          expect(format(reparsed)).toBe(bytes);
        });
      }
    }
  });

  describe("opening side: the run's first character against the last character before it", () => {
    for (const neighbour of Object.keys(NEIGHBOURS) as NeighbourClass[]) {
      for (const inner of Object.keys(INNERS.opening) as InnerClass[]) {
        it(`(opening, ${neighbour} outside, ${inner} inside): bytes, one delete, fixed point`, () => {
          const shape = INNERS.opening[inner];
          const n = NEIGHBOURS[neighbour];
          // The closing side is a letter edge before whitespace for every case here, so only the
          // opening side is under test.
          const root = paragraph(text(n.before), del(...shape.children), text(" x"));
          const encoded = shape.encodes && ENCODED_OUTSIDE[neighbour];
          const expected = `${encoded ? n.encodedBefore : n.before}~~${shape.bytes}~~ x\n`;
          const bytes = format(root);
          expect(bytes).toBe(expected);
          const reparsed = parse(bytes);
          expect(countDeletes(reparsed)).toBe(1);
          expect(stripPositions(reparsed)).toEqual(stripPositions(root));
          expect(format(reparsed)).toBe(bytes);
        });
      }
    }
  });

  describe("whitespace inside the run: the table's third column", () => {
    it("a letter outside a whitespace edge encodes both, as the built-in handlers do", () => {
      const root = paragraph(text("a"), del(text(" b ")), text("c"));
      const bytes = format(root);
      expect(bytes).toBe("&#x61;~~&#x20;b&#x20;~~&#x63;\n");
      expect(countDeletes(parse(bytes))).toBe(1);
      expect(format(parse(bytes))).toBe(bytes);
    });

    it("punctuation outside a whitespace edge encodes the whitespace only", () => {
      const root = paragraph(text("."), del(text(" b ")), text("."));
      const bytes = format(root);
      expect(bytes).toBe(".~~&#x20;b&#x20;~~.\n");
      expect(countDeletes(parse(bytes))).toBe(1);
      expect(format(parse(bytes))).toBe(bytes);
    });
  });

  describe("invariant A on the parser's own tree", () => {
    it("`~~a.~~&#x62;` — a delete the parser holds — formats to itself, not to the bytes GFM cannot close", () => {
      const source = "~~a.~~&#x62;\n";
      const root = parse(source);
      expect(countDeletes(root)).toBe(1);
      const bytes = format(root);
      expect(bytes).toBe(source);
      expect(countDeletes(parse(bytes))).toBe(1);
      expect(format(parse(bytes))).toBe(bytes);
    });
  });

  describe("the rest of the extension's behaviour is kept", () => {
    it("a literal `~` in text beside a run is still escaped and one inside the run still escapes", () => {
      const root = paragraph(text("a ~~ b"), del(text("c~d")), text(" e"));
      const bytes = format(root);
      expect(bytes).toBe("a \\~\\~ b~~c\\~d~~ e\n");
      expect(countDeletes(parse(bytes))).toBe(1);
      expect(stripPositions(parse(bytes))).toEqual(stripPositions(root));
      expect(format(parse(bytes))).toBe(bytes);
    });

    it("a run that already forms against its neighbours is written byte-identically (the corpus's own shape)", () => {
      const source = "This draft had ~~a redundant clause~~ removed.\n";
      expect(format(parse(source))).toBe(source);
    });

    it("`peek` reports the marker, so the text before a run is escaped against `~`", () => {
      expect(handleDelete.peek()).toBe("~");
    });
  });

  describe("registration: the app's handler is the one that runs", () => {
    /** The `delete` handler on the real `State` the app's formatter serializes with. */
    function installedDeleteHandler(): Handlers["delete"] {
      let installed: Handlers["delete"];
      createFormatter()
        .use(function capture(this: Processor) {
          const data = this.data();
          const extensions: ToMarkdownExtensions = (data.toMarkdownExtensions ??= []);
          extensions.push({
            handlers: {
              root: (_node, _parent, state) => {
                installed = state.handlers.delete;
                return "";
              },
            },
          });
        })
        .stringify({ type: "root", children: [] });
      return installed;
    }

    it("`state.handlers.delete` is format.ts's `handleDelete`, not the extension's", () => {
      expect(installedDeleteHandler()).toBe(handleDelete);
    });

    it("the closing-side letter case is the one the extension's handler gets wrong", () => {
      // The observable half of the registration: the bytes are the app handler's, and a parse
      // of them holds the delete. The extension's own handler writes `~~beta.~~gamma`, which
      // parses to text — the reproduction of J1.
      const root = paragraph(text("Alpha "), del(text("beta.")), text("gamma delta"));
      const bytes = format(root);
      expect(bytes).toBe("Alpha ~~beta.~~&#x67;amma delta\n");
      expect(countDeletes(parse(bytes))).toBe(1);
      expect(countDeletes(parse("Alpha ~~beta.~~gamma delta\n"))).toBe(0);
    });
  });
});
