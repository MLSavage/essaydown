import { describe, expect, it } from "vitest";
import type { DOMOutputSpec, Node as PMNode, TagParseRule } from "prosemirror-model";
import { RAW_VALUE_ATTR, marks, nodes, schema } from "../src/schema.js";

/**
 * Task 1.14 (DECISIONS #review-1-r0 F2): the schema had `toDOM` for every node type and mark and
 * no `parseDOM`, so `prosemirror-view`'s own clipboard path — `DOMSerializer` on copy,
 * `DOMParser` on paste — reconstructed a copied slice as plain text and the editor's own
 * copy → paste turned `# Heading` and `**bold**` into `Heading` and `bold`.
 *
 * **This file is the half a headless run can prove.** Vitest runs in Node here (`vitest.config.ts`
 * sets no `environment`, and no DOM implementation — jsdom, happy-dom, linkedom — is in the
 * lockfile), so there is no `DOMSerializer` → `DOMParser` leg to run without adding a dependency,
 * which PRD §4 forbids. What is asserted here is therefore the schema itself: that every renderer
 * has an inverse (the enumeration, so a future node type cannot be added without its rule), that
 * every rule's `getAttrs` reads back exactly what its `toDOM` wrote, and that the two `raw` types
 * are leaves whose text a parser never descends into. The corpus leg — serialise and re-parse
 * every fixture in `fixtures/markdown/index.json` through a real browser — is
 * `e2e/web/editor-clipboard.spec.ts`.
 *
 * `getAttrs` takes an `HTMLElement`; {@link element} is the two methods every rule here calls,
 * which is all a Node run can offer and all these assertions need.
 */

/** A stand-in for the element a rule's `getAttrs` is handed: attribute lookup, nothing else. */
function element(attrs: Record<string, string>): HTMLElement {
  return {
    getAttribute: (name: string): string | null => (name in attrs ? attrs[name] : null),
    hasAttribute: (name: string): boolean => name in attrs,
  } as unknown as HTMLElement;
}

/** The attribute object `toDOM` wrote, as a plain record: `["tag", attrs, …]` or `["tag", …]`. */
function attrsOf(spec: DOMOutputSpec): Record<string, string> {
  const parts = spec as readonly unknown[];
  const second = parts[1];
  if (typeof second !== "object" || second === null || Array.isArray(second)) return {};
  return Object.fromEntries(
    Object.entries(second as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
  );
}

/**
 * Render a node with its own `toDOM`, then read the result back with the one `parseDOM` rule that
 * matches the tag it wrote — which is the rule ProseMirror's parser would pick, and the reason a
 * bullet list is read by the `ul` rule and not by `list`'s first (`ol`) one.
 */
function throughDOM(node: PMNode): Record<string, unknown> {
  const spec = node.type.spec;
  const rendered = spec.toDOM!(node) as [string, ...unknown[]];
  const rule = (spec.parseDOM as TagParseRule[]).find(
    (candidate) => candidate.tag!.split("[")[0] === rendered[0],
  );
  expect(rule, `no parseDOM rule matches <${rendered[0]}>`).toBeDefined();
  const getAttrs = rule!.getAttrs;
  return getAttrs === undefined
    ? {}
    : (getAttrs(element(attrsOf(rendered))) as Record<string, unknown>);
}

describe("every renderer has an inverse", () => {
  it("every node type with a toDOM has a parseDOM, and neither without the other", () => {
    const renders = Object.keys(nodes).filter((name) => typeof nodes[name].toDOM === "function");
    const parses = Object.keys(nodes).filter((name) => nodes[name].parseDOM !== undefined);
    expect(parses).toEqual(renders);
    // Not vacuous, and not a literal: the two lists above are the schema's own node names.
    expect(renders).toContain("heading");
    expect(renders.length).toBe(Object.keys(nodes).length - 2); // `doc` and `text` render nothing
    expect(nodes.doc.parseDOM).toBeUndefined();
    expect(nodes.text.parseDOM).toBeUndefined();
  });

  it("every mark with a toDOM has a parseDOM", () => {
    const renders = Object.keys(marks).filter((name) => typeof marks[name].toDOM === "function");
    const parses = Object.keys(marks).filter((name) => marks[name].parseDOM !== undefined);
    expect(parses).toEqual(renders);
    expect(renders).toEqual(Object.keys(marks));
  });

  it("the built schema carries the rules, so the parser is built from them", () => {
    for (const name of Object.keys(nodes)) {
      expect(schema.nodes[name].spec.parseDOM).toBe(nodes[name].parseDOM);
    }
    for (const name of Object.keys(marks)) {
      expect(schema.marks[name].spec.parseDOM).toBe(marks[name].parseDOM);
    }
  });

  it("every rule names a tag, so none of them matches everything", () => {
    const rules = [...Object.values(nodes), ...Object.values(marks)]
      .flatMap((spec) => (spec.parseDOM ?? []) as TagParseRule[])
      .map((rule) => rule.tag);
    expect(rules.length).toBeGreaterThan(0);
    for (const tag of rules) expect(tag).toBeTypeOf("string");
  });
});

describe("each rule reads back exactly what its toDOM wrote", () => {
  it("heading: one rule per depth, and the depth is the rule's own attrs", () => {
    const rules = nodes.heading.parseDOM as TagParseRule[];
    expect(rules.map((rule) => rule.tag!)).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"]);
    for (const depth of [1, 2, 3, 4, 5, 6]) {
      const node = schema.node("heading", { depth }, schema.text("h"));
      // The tag `toDOM` writes is the tag the rule for that depth matches.
      const tag = (node.type.spec.toDOM!(node) as [string])[0];
      const rule = rules.find((candidate) => candidate.tag! === tag);
      expect(rule?.attrs).toEqual({ depth });
    }
  });

  it("code_block: the info string and its absence", () => {
    expect(
      throughDOM(schema.node("code_block", { lang: "ts", meta: "twoslash" }, schema.text("1"))),
    ).toEqual({ lang: "ts", meta: "twoslash" });
    expect(throughDOM(schema.node("code_block", null, schema.text("1")))).toEqual({
      lang: null,
      meta: null,
    });
  });

  it("code_block: the content element is the inner `code`, and a bare `pre` falls back to itself", () => {
    const rule = (nodes.code_block.parseDOM as TagParseRule[])[0] as {
      contentElement: (dom: HTMLElement) => HTMLElement;
      preserveWhitespace: string;
    };
    const inner = { tag: "code" } as unknown as HTMLElement;
    const withCode = { querySelector: () => inner } as unknown as HTMLElement;
    const withoutCode = { querySelector: () => null } as unknown as HTMLElement;
    expect(rule.contentElement(withCode)).toBe(inner);
    expect(rule.contentElement(withoutCode)).toBe(withoutCode);
    // Without this a fenced block's newlines would be collapsed to single spaces on paste.
    expect(rule.preserveWhitespace).toBe("full");
  });

  it("list: ordered with and without a start, bullet, and both spreads", () => {
    const item = schema.node("list_item", null, schema.node("paragraph"));
    const list = (attrs: Record<string, unknown>): PMNode => schema.node("list", attrs, item);
    expect(throughDOM(list({ ordered: true, start: 5 }))).toEqual({
      ordered: true,
      start: 5,
      spread: false,
    });
    expect(throughDOM(list({ ordered: true }))).toEqual({
      ordered: true,
      start: null,
      spread: false,
    });
    expect(throughDOM(list({ ordered: false }))).toEqual({
      ordered: false,
      start: null,
      spread: false,
    });
    expect(throughDOM(list({ ordered: false, spread: true }))).toEqual({
      ordered: false,
      start: null,
      spread: true,
    });
    expect(throughDOM(list({ ordered: true, start: 2, spread: true }))).toEqual({
      ordered: true,
      start: 2,
      spread: true,
    });
  });

  it("list: a bullet list with nothing to say still renders as the bare element it always did", () => {
    const item = schema.node("list_item", null, schema.node("paragraph"));
    const bare = schema.node("list", null, item);
    expect(bare.type.spec.toDOM!(bare)).toEqual(["ul", 0]);
    const loose = schema.node("list", { spread: true }, item);
    expect(loose.type.spec.toDOM!(loose)).toEqual(["ul", { "data-spread": "true" }, 0]);
  });

  it("list: a `start` that is not a number is refused rather than passed on as NaN", () => {
    const rule = (nodes.list.parseDOM as TagParseRule[])[0];
    expect(rule.getAttrs!(element({ start: "nine" }))).toEqual({
      ordered: true,
      start: null,
      spread: false,
    });
  });

  it("list_item: spread, present and absent", () => {
    const item = (attrs: Record<string, unknown>): PMNode =>
      schema.node("list_item", attrs, schema.node("paragraph"));
    expect(throughDOM(item({ spread: true }))).toEqual({ spread: true });
    expect(throughDOM(item({ spread: false }))).toEqual({ spread: false });
    const tight = item({ spread: false });
    expect(tight.type.spec.toDOM!(tight)).toEqual(["li", 0]);
  });

  it("table: an alignment array, including a column with none, and no alignment at all", () => {
    const cell = schema.node("table_cell", null, schema.text("c"));
    const row = schema.node("table_row", null, cell);
    const table = (align: unknown): PMNode => schema.node("table", { align }, row);
    expect(throughDOM(table(["left", null, "center", "right"]))).toEqual({
      align: ["left", null, "center", "right"],
    });
    expect(throughDOM(table(null))).toEqual({ align: null });
    const plain = table(null);
    expect(plain.type.spec.toDOM!(plain)).toEqual(["table", ["tbody", 0]]);
  });

  it("table: an alignment attribute from foreign HTML is validated, never trusted", () => {
    const rule = (nodes.table.parseDOM as TagParseRule[])[0];
    const align = (value: string): unknown => rule.getAttrs!(element({ "data-align": value }));
    expect(align("[")).toEqual({ align: null }); // not JSON
    expect(align('"left"')).toEqual({ align: null }); // JSON, but not an array
    expect(align('["sideways"]')).toEqual({ align: null }); // an array of the wrong strings
    expect(align('["left",null]')).toEqual({ align: ["left", null] }); // the admitted shape
  });

  it("image: url, alt and title, present and absent", () => {
    expect(
      throughDOM(schema.node("image", { url: "a.png", alt: "an alt", title: "a title" })),
    ).toEqual({ url: "a.png", alt: "an alt", title: "a title" });
    expect(throughDOM(schema.node("image", { url: "a.png" }))).toEqual({
      url: "a.png",
      alt: "",
      title: null,
    });
    // `src` is what `toDOM` writes; an `img` with none cannot match the rule's `img[src]` tag, and
    // the empty-string fallback is what keeps the attrs' type honest if one ever does.
    const rule = (nodes.image.parseDOM as TagParseRule[])[0];
    expect(rule.getAttrs!(element({}))).toEqual({ url: "", alt: null, title: null });
  });

  it("link: url and title, present and absent", () => {
    const withTitle = schema.marks.link.create({ url: "a.md", title: "t" });
    const rule = (marks.link.parseDOM as TagParseRule[])[0];
    const attrsFor = (mark: { type: { spec: { toDOM?: unknown } } }): Record<string, string> =>
      attrsOf((marks.link.toDOM as (m: unknown, i: boolean) => DOMOutputSpec)(mark, true));
    expect(rule.getAttrs!(element(attrsFor(withTitle)))).toEqual({ url: "a.md", title: "t" });
    const bare = schema.marks.link.create({ url: "a.md" });
    expect(rule.getAttrs!(element(attrsFor(bare)))).toEqual({ url: "a.md", title: null });
    expect(rule.getAttrs!(element({}))).toEqual({ url: "", title: null });
  });

  it("the three inline-content rules preserve whitespace fully, so a soft break stays a break", () => {
    // mdast writes a wrapped paragraph as a literal `\n` inside its text; without this the DOM
    // parser normalises that newline to a space and `> a\n> b` comes back as one line.
    for (const name of ["paragraph", "heading", "table_cell"]) {
      const rules = nodes[name].parseDOM as TagParseRule[];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) expect(rule.preserveWhitespace).toBe("full");
    }
    // Absence: the block-content rules take the whitespace policy of their context, and the two
    // opaque leaves have no content at all, so neither states one.
    for (const name of ["blockquote", "list", "list_item", "table", "table_row", "raw"]) {
      const rules = nodes[name].parseDOM as TagParseRule[];
      for (const rule of rules) expect(rule.preserveWhitespace).toBeUndefined();
    }
  });

  it("the marks with no attributes have a rule with no getAttrs", () => {
    for (const name of ["strong", "emphasis", "delete", "inline_code"]) {
      const rules = marks[name].parseDOM as TagParseRule[];
      expect(rules.length).toBe(1);
      expect(rules[0].getAttrs).toBeUndefined();
    }
  });
});

describe("the opaque raw node round-trips by its stored value, not by its text", () => {
  const value = '<script>alert("x")</script>';

  for (const [type, tag] of [
    ["raw", "div"],
    ["raw_inline", "span"],
  ] as const) {
    it(`${type}: the value is in the ${tag}'s attribute and read back from it`, () => {
      const node = schema.node(type, { value });
      const spec = node.type.spec.toDOM!(node) as [string, Record<string, string>, string];
      expect(spec[0]).toBe(tag);
      expect(spec[1][RAW_VALUE_ATTR]).toBe(value);
      // The same bytes are the element's *text* too, which is what the grey box shows.
      expect(spec[2]).toBe(value);
      expect(throughDOM(node)).toEqual({ value });
    });

    it(`${type}: the rule matches only an element carrying the attribute`, () => {
      const rules = schema.nodes[type].spec.parseDOM as TagParseRule[];
      expect(rules[0].tag).toBe(`${tag}[${RAW_VALUE_ATTR}]`);
    });

    it(`${type}: is a leaf, so a parser never descends into its text`, () => {
      // This is what makes the pasted node opaque: `addElementByRule` inserts a leaf and calls no
      // `addAll`, so the `<script>` characters above cannot become an element in the document.
      expect(schema.nodes[type].isLeaf).toBe(true);
      expect(schema.nodes[type].spec.content).toBeUndefined();
    });

    it(`${type}: an element with the attribute but no value parses to the empty default`, () => {
      const rules = schema.nodes[type].spec.parseDOM as TagParseRule[];
      expect(rules[0].getAttrs!(element({}))).toEqual({ value: "" });
    });
  }
});
