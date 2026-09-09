import type {
  Blockquote,
  Break,
  Code,
  Delete,
  Emphasis,
  Heading,
  Html,
  Image,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Table,
  TableCell,
  TableRow,
  Text,
  ThematicBreak,
  Yaml,
} from "mdast";
import {
  Schema,
  type DOMOutputSpec,
  type Mark as PMMark,
  type MarkSpec,
  type Node as PMNode,
  type NodeSpec,
} from "prosemirror-model";

/**
 * The `mdast` node types PRD §6.1 admits, minus the two that never enter the ProseMirror doc:
 * `root` (it becomes `doc`) and `yaml` (held outside the doc, see {@link EditorDocument}). Every
 * remaining type has exactly one node type or one mark in {@link schema}, and every node type and
 * mark in {@link schema} has exactly one type here — that is what "maps 1:1 to §6.1" means, and
 * `schema.test.ts` asserts the correspondence in both directions from this list.
 */
export const MDAST_TYPES = [
  "blockquote",
  "break",
  "code",
  "delete",
  "emphasis",
  "heading",
  "html",
  "image",
  "inlineCode",
  "link",
  "list",
  "listItem",
  "paragraph",
  "strong",
  "table",
  "tableCell",
  "tableRow",
  "text",
  "thematicBreak",
] as const;

/** The class every `raw` node carries, so a later stylesheet can theme the grey box. */
export const RAW_CLASS = "essaydown-raw";

/**
 * The attribute a `raw` node's opaque bytes travel in.
 *
 * The bytes are in the element *twice*, and deliberately: as the element's text, which is what the
 * reader sees in the grey box, and as this attribute, which is what {@link nodes}' parse rule reads
 * back. The text is never the source of truth on the way in — `raw` and `raw_inline` are leaf node
 * types, so ProseMirror's DOM parser creates the node from the attribute and never descends into
 * the element — which is what keeps a pasted raw node opaque: its displayed text is not re-parsed,
 * so `<script>x</script>` in the box comes back as those characters and cannot become an element.
 */
export const RAW_VALUE_ATTR = "data-essaydown-raw";

/**
 * The grey box of PRD §6.1: an `html` node is never rendered as HTML, it is shown as its own
 * source text in a read-only grey box. The styling is inline rather than in a stylesheet so the
 * box is grey wherever the schema is mounted, with no CSS file to import; `RAW_CLASS` is there
 * for a later theme to override it.
 */
const RAW_STYLE =
  "background:#f1f1f0;color:#5f5f5c;border:1px solid #dcdcd9;border-radius:3px;" +
  "padding:0.35em 0.5em;font-family:ui-monospace,monospace;white-space:pre-wrap;";

function rawDOM(tag: string, node: PMNode): DOMOutputSpec {
  const value = node.attrs.value as string;
  return [
    tag,
    { class: RAW_CLASS, contenteditable: "false", style: RAW_STYLE, [RAW_VALUE_ATTR]: value },
    value,
  ];
}

/** Read a `raw`/`raw_inline` node's attrs back out of the element {@link rawDOM} wrote. */
function rawAttrs(dom: HTMLElement): { value: string } {
  return { value: dom.getAttribute(RAW_VALUE_ATTR) ?? "" };
}

/**
 * `""` is how a `data-` attribute spells "the schema's `null` default": an HTML attribute value is
 * always a string, and `code_block`'s `lang`/`meta` are `string | null`. No Markdown fence has an
 * empty info string — micromark gives `null`, never `""` — so nothing is collapsed by the pair.
 */
function emptyToNull(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}

/** `data-spread` is written only when the flag is true, so its absence is the schema's default. */
function spreadOf(dom: HTMLElement): boolean {
  return dom.getAttribute("data-spread") === "true";
}

const ALIGNMENTS: readonly string[] = ["left", "right", "center"];

/**
 * mdast's `align` is one entry per column, each `"left" | "right" | "center" | null`, so it is
 * written as JSON: a comma-joined spelling could not tell `[]` from `[null]`, and `null` is a
 * legitimate entry (a column with no alignment marker). Absent means the schema's `null` default.
 *
 * The value is read from whatever HTML was pasted, so it is validated rather than trusted: a
 * string that is not JSON, or is not an array of the four admitted values, yields `null` — the
 * same as an unaligned table — instead of throwing out of the paste or reaching `format`.
 */
function alignOf(dom: HTMLElement): Table["align"] {
  const raw = dom.getAttribute("data-align");
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const ok = parsed.every((entry) => entry === null || ALIGNMENTS.includes(entry as string));
  return ok ? (parsed as Table["align"]) : null;
}

/** `<ol start="…">`, guarded: pasted HTML can carry a value that is not a number. */
function startOf(dom: HTMLElement): number | null {
  const raw = dom.getAttribute("start");
  if (raw === null) return null;
  const start = Number.parseInt(raw, 10);
  return Number.isNaN(start) ? null : start;
}

/**
 * The three node types whose content is inline text, and the one whitespace decision they share.
 *
 * mdast writes a Markdown **soft line break** — a paragraph wrapped over two source lines — as a
 * literal `\n` inside a `text` node, so it is a literal `\n` in the text node `toDOM` produces.
 * ProseMirror's DOM parser normalises `\n` to a space unless the context is "preserve whitespace,
 * fully", which is why a wrapped blockquote came back joined onto one line: the bytes were on the
 * clipboard and the parser dropped them. `"full"` is the setting that keeps them.
 *
 * The cost, stated because it is real: whitespace in *foreign* HTML is no longer collapsed either,
 * so a web page's `<p>` pasted with its source indentation keeps that indentation as soft breaks
 * and runs of spaces — which render as one space in any Markdown reader, and whose leading and
 * trailing runs `trimBlockEnds` already strips on the way out (task 1.13). Byte fidelity for the
 * editor's own documents (PRD §6, invariant C) is worth that; silently rewriting the user's own
 * line breaks is not.
 */
const INLINE_WHITESPACE = "full" as const;

/**
 * Node specs. Declaration order is only significant for `doc` (the first entry is the top node);
 * mark order, which *is* significant, is documented on {@link marks}.
 *
 * Two node types carry an mdast `html` node — `raw` in block position and `raw_inline` in
 * phrasing position — because ProseMirror types a node as one or the other and mdast allows both.
 * They are the same "raw node" of the task text: same attrs, same grey box, both `atom` and
 * `contenteditable="false"`, so neither is editable in place.
 *
 * **`parseDOM` is paired one-to-one with `toDOM`** (DECISIONS #review-1-r0 F2). The native
 * clipboard path is not hypothetical: `prosemirror-view` serialises a copied slice with this
 * schema's `DOMSerializer` and reads it back with its `DOMParser`, so a node with `toDOM` and no
 * rule came back as its plain text and `# Heading` + `**bold**` pasted over itself as
 * `Heading` + `bold`. Every rule below therefore inverts exactly the element its `toDOM` writes,
 * and every attribute the node type carries is in that element: `heading.depth` in the tag name,
 * `list.start` in `start`, `image`/`link` in `src`/`href`/`alt`/`title`, `code_block` in
 * `data-lang`/`data-meta`, and the three the rendering has no HTML spelling for — `list.spread`,
 * `list_item.spread` and `table.align` — in `data-spread` and `data-align`, each written only when
 * it differs from the schema default so the elements a reader sees are unchanged. `doc` and `text`
 * have neither `toDOM` nor `parseDOM`; `parse-dom.test.ts` enumerates the schema and fails if a
 * future node type has one without the other.
 */
export const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },

  paragraph: {
    group: "block",
    content: "inline*",
    toDOM: (): DOMOutputSpec => ["p", 0],
    parseDOM: [{ tag: "p", preserveWhitespace: INLINE_WHITESPACE }],
  },

  heading: {
    group: "block",
    content: "inline*",
    attrs: { depth: { default: 1 } },
    defining: true,
    toDOM: (node): DOMOutputSpec => [`h${node.attrs.depth as number}`, 0],
    // One rule per depth: mdast's `depth` is 1–6 and the tag name is the only place it is written.
    parseDOM: [1, 2, 3, 4, 5, 6].map((depth) => ({
      tag: `h${depth}`,
      attrs: { depth },
      preserveWhitespace: INLINE_WHITESPACE,
    })),
  },

  blockquote: {
    group: "block",
    content: "block+",
    defining: true,
    toDOM: (): DOMOutputSpec => ["blockquote", 0],
    parseDOM: [{ tag: "blockquote" }],
  },

  code_block: {
    group: "block",
    content: "text*",
    marks: "",
    code: true,
    defining: true,
    attrs: { lang: { default: null }, meta: { default: null } },
    toDOM: (node): DOMOutputSpec => [
      "pre",
      {
        "data-lang": (node.attrs.lang as string | null) ?? "",
        "data-meta": (node.attrs.meta as string | null) ?? "",
      },
      ["code", 0],
    ],
    parseDOM: [
      {
        tag: "pre",
        // The `<code>` `toDOM` nests inside the `<pre>`: taking it as the content element means
        // the parser adds its *text* and never matches the element itself against the
        // `inline_code` mark rule. `?? dom` is for the `<pre>` of some other editor, which has no
        // inner `<code>`.
        contentElement: (dom: HTMLElement): HTMLElement => dom.querySelector("code") ?? dom,
        preserveWhitespace: "full" as const,
        getAttrs: (dom: HTMLElement) => ({
          lang: emptyToNull(dom.getAttribute("data-lang")),
          meta: emptyToNull(dom.getAttribute("data-meta")),
        }),
      },
    ],
  },

  thematic_break: {
    group: "block",
    toDOM: (): DOMOutputSpec => ["hr"],
    parseDOM: [{ tag: "hr" }],
  },

  /**
   * One node type for both mdast list flavours, because mdast has one `list` node with an
   * `ordered` flag; `ordered`, `start` and `spread` are the mdast fields verbatim.
   */
  list: {
    group: "block",
    content: "list_item+",
    attrs: { ordered: { default: false }, start: { default: null }, spread: { default: false } },
    toDOM: (node): DOMOutputSpec => {
      const ordered = node.attrs.ordered === true;
      const attrs: Record<string, string | number> = {};
      if (ordered && node.attrs.start !== null) attrs.start = node.attrs.start as number;
      if (node.attrs.spread === true) attrs["data-spread"] = "true";
      // A bullet list with nothing to say still renders as the bare `["ul", 0]` it always did;
      // `ol` keeps its attribute object even when empty, which is what it always did too.
      if (!ordered && Object.keys(attrs).length === 0) return ["ul", 0];
      return [ordered ? "ol" : "ul", attrs, 0];
    },
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (dom: HTMLElement) => ({
          ordered: true,
          start: startOf(dom),
          spread: spreadOf(dom),
        }),
      },
      {
        tag: "ul",
        getAttrs: (dom: HTMLElement) => ({ ordered: false, start: null, spread: spreadOf(dom) }),
      },
    ],
  },

  list_item: {
    content: "block+",
    attrs: { spread: { default: false } },
    defining: true,
    toDOM: (node): DOMOutputSpec =>
      node.attrs.spread === true ? ["li", { "data-spread": "true" }, 0] : ["li", 0],
    parseDOM: [{ tag: "li", getAttrs: (dom: HTMLElement) => ({ spread: spreadOf(dom) }) }],
  },

  table: {
    group: "block",
    content: "table_row+",
    attrs: { align: { default: null } },
    isolating: true,
    toDOM: (node): DOMOutputSpec =>
      node.attrs.align === null
        ? ["table", ["tbody", 0]]
        : ["table", { "data-align": JSON.stringify(node.attrs.align) }, ["tbody", 0]],
    // No `contentElement`: the `<tbody>` `toDOM` writes has no rule of its own, so the parser
    // descends through it to the rows, and a `<thead>` in foreign HTML is reached the same way.
    parseDOM: [{ tag: "table", getAttrs: (dom: HTMLElement) => ({ align: alignOf(dom) }) }],
  },

  table_row: {
    content: "table_cell+",
    toDOM: (): DOMOutputSpec => ["tr", 0],
    parseDOM: [{ tag: "tr" }],
  },

  /**
   * mdast makes no header/body distinction — the first `tableRow` is the header row — so neither
   * does the schema; a view decides how to render row 0.
   */
  table_cell: {
    content: "inline*",
    isolating: true,
    toDOM: (): DOMOutputSpec => ["td", 0],
    // `td` only, because `toDOM` writes `td` only: mdast has no header/body distinction, so the
    // schema has no second cell type for a `th` to invert to.
    parseDOM: [{ tag: "td", preserveWhitespace: INLINE_WHITESPACE }],
  },

  raw: {
    group: "block",
    atom: true,
    attrs: { value: { default: "" } },
    toDOM: (node): DOMOutputSpec => rawDOM("div", node),
    parseDOM: [{ tag: `div[${RAW_VALUE_ATTR}]`, getAttrs: rawAttrs }],
  },

  raw_inline: {
    group: "inline",
    inline: true,
    atom: true,
    attrs: { value: { default: "" } },
    toDOM: (node): DOMOutputSpec => rawDOM("span", node),
    parseDOM: [{ tag: `span[${RAW_VALUE_ATTR}]`, getAttrs: rawAttrs }],
  },

  image: {
    group: "inline",
    inline: true,
    draggable: true,
    attrs: { url: { default: "" }, alt: { default: null }, title: { default: null } },
    toDOM: (node): DOMOutputSpec => [
      "img",
      {
        src: node.attrs.url as string,
        alt: (node.attrs.alt as string | null) ?? "",
        ...(node.attrs.title === null ? {} : { title: node.attrs.title as string }),
      },
    ],
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom: HTMLElement) => ({
          url: dom.getAttribute("src") ?? "",
          alt: dom.getAttribute("alt"),
          title: dom.getAttribute("title"),
        }),
      },
    ],
  },

  hard_break: {
    group: "inline",
    inline: true,
    selectable: false,
    toDOM: (): DOMOutputSpec => ["br"],
    parseDOM: [{ tag: "br" }],
  },

  text: { group: "inline" },
};

/**
 * Mark specs. **Declaration order is the nesting order**: ProseMirror keeps a mark set sorted by
 * the type's rank in this object, and {@link pmToMdast} wraps the lowest-ranked mark outermost. So
 * a text span carrying `link` and `strong` always comes back as `[**a**](url)`, never
 * `**[a](url)**`.
 *
 * That is a real, deliberate normalisation, and the price of the ProseMirror mark model (PRD §4):
 * PM records *which* marks cover a character, not how the source nested them, so the nesting of
 * two marks over the same span cannot survive the trip and has to be chosen. `link` is outermost
 * because that is what CommonMark produces for the common `[**a**](url)`, and `code` is innermost
 * because mdast's `inlineCode` holds literal text and can contain nothing else. No fixture in
 * fixtures/markdown nests two marks, so the corpus round trip is exact; `schema.test.ts` pins the
 * normalisation on hand-written input instead.
 */
export const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { url: { default: "" }, title: { default: null } },
    inclusive: false,
    toDOM: (mark): DOMOutputSpec => [
      "a",
      {
        href: mark.attrs.url as string,
        ...(mark.attrs.title === null ? {} : { title: mark.attrs.title as string }),
      },
      0,
    ],
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom: HTMLElement) => ({
          url: dom.getAttribute("href") ?? "",
          title: dom.getAttribute("title"),
        }),
      },
    ],
  },
  strong: { toDOM: (): DOMOutputSpec => ["strong", 0], parseDOM: [{ tag: "strong" }] },
  emphasis: { toDOM: (): DOMOutputSpec => ["em", 0], parseDOM: [{ tag: "em" }] },
  delete: { toDOM: (): DOMOutputSpec => ["del", 0], parseDOM: [{ tag: "del" }] },
  inline_code: {
    code: true,
    toDOM: (): DOMOutputSpec => ["code", 0],
    parseDOM: [{ tag: "code" }],
  },
};

/** The editor schema of PRD §6.1. Immutable, so one instance is shared by every document. */
export const schema = new Schema({ nodes, marks });

/**
 * A document as the editor holds it: the ProseMirror doc, and the front matter *beside* it.
 *
 * PRD §6.1 makes `yaml` opaque and byte-identical, and only the two app-owned keys are ever
 * rewritten — by Outline, not by typing. Putting it in the doc would make it a thing the user can
 * put a cursor in; it is therefore held here, outside the doc, and re-attached as the root's first
 * child by {@link pmToMdast}. `mdastToPM` returns this pair rather than a bare doc so that
 * `pmToMdast(mdastToPM(root))` is the whole round trip, with nothing for a caller to carry by hand.
 */
export interface EditorDocument {
  doc: PMNode;
  frontMatter: Yaml | null;
}

function unsupported(type: string): never {
  throw new Error(
    `unsupported mdast node type "${type}": PRD §6.1 restricts the model to ${MDAST_TYPES.join(", ")}, root and yaml`,
  );
}

/**
 * An empty paragraph has no Markdown bytes, so it is the one node that exists on only one side of
 * the trip: mdast never produces it, ProseMirror requires it wherever `block+` has nothing to hold
 * (an empty document, an empty list item). {@link blocksToPM} inserts it and
 * {@link blocksToMdast} drops it again, which is what makes `- ` and a front-matter-only file
 * round-trip to their own bytes.
 */
function blocksToPM(children: readonly RootContent[]): PMNode[] {
  const blocks = children.map(blockToPM);
  return blocks.length > 0 ? blocks : [schema.node("paragraph")];
}

function blocksToMdast(node: PMNode): RootContent[] {
  const out: RootContent[] = [];
  node.forEach((child) => {
    if (child.type === schema.nodes.paragraph && child.content.size === 0) return;
    out.push(blockToMdast(child));
  });
  return out;
}

function blockToPM(node: RootContent): PMNode {
  switch (node.type) {
    case "paragraph":
      return schema.node("paragraph", null, inlineToPM(node.children, []));
    case "heading":
      return schema.node("heading", { depth: node.depth }, inlineToPM(node.children, []));
    case "blockquote":
      return schema.node("blockquote", null, blocksToPM(node.children));
    case "code":
      return schema.node(
        "code_block",
        { lang: node.lang ?? null, meta: node.meta ?? null },
        node.value === "" ? undefined : schema.text(node.value),
      );
    case "thematicBreak":
      return schema.node("thematic_break");
    case "list":
      return schema.node(
        "list",
        { ordered: node.ordered ?? false, start: node.start ?? null, spread: node.spread ?? false },
        node.children.map(blockToPM),
      );
    case "listItem":
      return schema.node("list_item", { spread: node.spread ?? false }, blocksToPM(node.children));
    case "table":
      return schema.node("table", { align: node.align ?? null }, node.children.map(blockToPM));
    case "tableRow":
      return schema.node("table_row", null, node.children.map(blockToPM));
    case "tableCell":
      return schema.node("table_cell", null, inlineToPM(node.children, []));
    case "html":
      return schema.node("raw", { value: node.value });
    default:
      return unsupported(node.type);
  }
}

function blockToMdast(node: PMNode): RootContent {
  const n = schema.nodes;
  switch (node.type) {
    case n.paragraph:
      return {
        type: "paragraph",
        children: inlineToMdast(trimBlockEnds(childrenOf(node))),
      } satisfies Paragraph;
    case n.heading:
      return {
        type: "heading",
        depth: node.attrs.depth as Heading["depth"],
        children: inlineToMdast(trimBlockEnds(childrenOf(node))),
      } satisfies Heading;
    case n.blockquote:
      return {
        type: "blockquote",
        children: blocksToMdast(node) as Blockquote["children"],
      } satisfies Blockquote;
    case n.code_block:
      return {
        type: "code",
        lang: node.attrs.lang as string | null,
        meta: node.attrs.meta as string | null,
        value: node.textContent,
      } satisfies Code;
    case n.thematic_break:
      return { type: "thematicBreak" } satisfies ThematicBreak;
    case n.list:
      return {
        type: "list",
        ordered: node.attrs.ordered as boolean,
        start: node.attrs.start as number | null,
        spread: node.attrs.spread as boolean,
        children: childrenOf(node).map(blockToMdast) as ListItem[],
      } satisfies List;
    case n.list_item:
      return {
        type: "listItem",
        spread: node.attrs.spread as boolean,
        checked: null,
        children: blocksToMdast(node) as ListItem["children"],
      } satisfies ListItem;
    case n.table:
      return {
        type: "table",
        align: node.attrs.align as Table["align"],
        children: childrenOf(node).map(blockToMdast) as TableRow[],
      } satisfies Table;
    case n.table_row:
      return {
        type: "tableRow",
        children: childrenOf(node).map(blockToMdast) as TableCell[],
      } satisfies TableRow;
    case n.table_cell:
      return {
        type: "tableCell",
        children: inlineToMdast(trimBlockEnds(childrenOf(node))),
      } satisfies TableCell;
    case n.raw:
      return { type: "html", value: node.attrs.value as string } satisfies Html;
    default:
      return unsupported(node.type.name);
  }
}

/**
 * The ASCII whitespace of CommonMark §2.1 — space, tab, line feed, line tabulation, form feed and
 * carriage return — which is the set micromark strips at the two ends of a paragraph, heading or
 * table cell. Written as the character class rather than as `\s` on purpose: `\s` also matches
 * the Unicode spaces (U+00A0 and the U+2000 block) that a Markdown file *does* keep, so trimming
 * with it would delete bytes `parse` preserves.
 */
const ASCII_WHITESPACE = /[\t\n\v\f\r ]+/;
const LEADING_WHITESPACE = new RegExp(`^${ASCII_WHITESPACE.source}`);
const TRAILING_WHITESPACE = new RegExp(`${ASCII_WHITESPACE.source}$`);

/**
 * Strip the whitespace `parse` never keeps, so that the tree leaving the editor is one some
 * Markdown file parses to (DECISIONS #review-1-r0 F1, PRD §6 portability).
 *
 * micromark drops the leading and trailing ASCII whitespace of a paragraph, heading or table cell,
 * but ProseMirror keeps every character typed into it, so a trailing space typed before Enter
 * survives into `format`, whose `unsafe` table encodes a space before a line ending as `&#x20;` —
 * bytes no Markdown file contains and no round trip is a fixed point of. The strip therefore
 * belongs here, on the way out of the editor's tree, where the serializer, the copy button and the
 * store all read the same document; not in the serializer's `unsafe` table, which is right about
 * the trees it is given.
 *
 * Ownership rule for zero-width items: this trims the block's own two ends and nothing else — the
 * leading whitespace of the block's **first** inline node and the trailing whitespace of its
 * **last**, each only when that node is a text node outside `inline_code`. An atom (`image`,
 * `hard_break`, `raw_inline`) or an inline-code run sitting at an end owns that end and stops the
 * strip there, which is why a text run beside a `hard_break` keeps its spaces (a hard break
 * already serialises to bytes that parse back) and inline code keeps its literal value. A node
 * that is both first and last is trimmed at both ends. A run trimmed to nothing is dropped rather
 * than kept as a zero-length text node, which ProseMirror rejects; dropping it does not promote
 * its neighbour to the boundary, because both ends are chosen before either is trimmed. Blocks
 * whose content is not inline — `code_block`, `raw`, and the opaque `html`/`yaml` bytes — never
 * reach this function.
 */
function trimBlockEnds(nodes: readonly PMNode[]): PMNode[] {
  if (nodes.length === 0) return [];
  const last = nodes.length - 1;
  const out: PMNode[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!node.isText || schema.marks.inline_code.isInSet(node.marks) !== undefined) {
      out.push(node);
      continue;
    }
    let text = node.text as string;
    if (i === 0) text = text.replace(LEADING_WHITESPACE, "");
    if (i === last) text = text.replace(TRAILING_WHITESPACE, "");
    if (text === "") continue;
    out.push(text === node.text ? node : schema.text(text, node.marks));
  }
  return out;
}

function childrenOf(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((child) => out.push(child));
  return out;
}

/**
 * mdast nests inline marks; ProseMirror puts them on the text. Going down, the nesting becomes the
 * mark set carried into the recursion; a node whose text is empty (which mdast can hold and
 * ProseMirror cannot) contributes nothing.
 */
function inlineToPM(children: readonly PhrasingContent[], carried: readonly PMMark[]): PMNode[] {
  const out: PMNode[] = [];
  for (const child of children) {
    switch (child.type) {
      case "text":
        if (child.value !== "") out.push(schema.text(child.value, carried));
        break;
      case "emphasis":
        out.push(...inlineToPM(child.children, schema.marks.emphasis.create().addToSet(carried)));
        break;
      case "strong":
        out.push(...inlineToPM(child.children, schema.marks.strong.create().addToSet(carried)));
        break;
      case "delete":
        out.push(...inlineToPM(child.children, schema.marks.delete.create().addToSet(carried)));
        break;
      case "link":
        out.push(
          ...inlineToPM(
            child.children,
            schema.marks.link
              .create({ url: child.url, title: child.title ?? null })
              .addToSet(carried),
          ),
        );
        break;
      case "inlineCode":
        if (child.value !== "") {
          out.push(schema.text(child.value, schema.marks.inline_code.create().addToSet(carried)));
        }
        break;
      case "image":
        out.push(
          schema.node(
            "image",
            { url: child.url, alt: child.alt ?? null, title: child.title ?? null },
            undefined,
            carried,
          ),
        );
        break;
      case "break":
        out.push(schema.node("hard_break", null, undefined, carried));
        break;
      case "html":
        out.push(schema.node("raw_inline", { value: child.value }, undefined, carried));
        break;
      default:
        return unsupported(child.type);
    }
  }
  return out;
}

/**
 * Going back up, the flat inline list is partitioned into **adjacent half-open runs** of nodes
 * sharing their outermost mark, and each run is wrapped and recursed into with that mark removed.
 *
 * Ownership rule for zero-width items: there are none to own. ProseMirror rejects a zero-length
 * text node, {@link inlineToPM} never creates one, and the leaf nodes (`image`, `hard_break`,
 * `raw_inline`) are atoms with a width of their own; so every run holds at least one node and no
 * item can sit on a run boundary. A run is `[i, j)`: `i` is the first node carrying the mark and
 * `j` the first node after it that does not, so the first, middle and last runs of a list are cut
 * by the same rule (`schema.test.ts` asserts a mark in each of the three positions).
 */
function inlineToMdast(nodes: readonly PMNode[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < nodes.length) {
    const outer = nodes[i].marks[0];
    if (outer === undefined) {
      out.push(leafToMdast(nodes[i]));
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < nodes.length && outer.isInSet(nodes[j].marks)) j += 1;
    const inner = nodes.slice(i, j).map((node) => node.mark(outer.removeFromSet(node.marks)));
    out.push(wrapMark(outer, inner));
    i = j;
  }
  return out;
}

function wrapMark(mark: PMMark, inner: readonly PMNode[]): PhrasingContent {
  switch (mark.type) {
    case schema.marks.inline_code:
      // `inlineCode` holds literal text and no children, which is why `inline_code` is the
      // innermost mark: by the time a run is wrapped in it, `inner` is plain text.
      return {
        type: "inlineCode",
        value: inner.map((node) => node.textContent).join(""),
      } satisfies InlineCode;
    case schema.marks.link:
      return {
        type: "link",
        url: mark.attrs.url as string,
        title: mark.attrs.title as string | null,
        children: inlineToMdast(inner),
      } satisfies Link;
    case schema.marks.strong:
      return { type: "strong", children: inlineToMdast(inner) } satisfies Strong;
    case schema.marks.emphasis:
      return { type: "emphasis", children: inlineToMdast(inner) } satisfies Emphasis;
    default:
      return { type: "delete", children: inlineToMdast(inner) } satisfies Delete;
  }
}

function leafToMdast(node: PMNode): PhrasingContent {
  const n = schema.nodes;
  switch (node.type) {
    case n.text:
      // `Node.text` is typed `string | undefined` on every node; on a *text* node it is always
      // the string, so there is no empty-string fallback to take (and ProseMirror rejects a
      // zero-length text node, so it could not be reached even in principle).
      return { type: "text", value: node.text as string } satisfies Text;
    case n.image:
      return {
        type: "image",
        url: node.attrs.url as string,
        alt: node.attrs.alt as string | null,
        title: node.attrs.title as string | null,
      } satisfies Image;
    case n.hard_break:
      return { type: "break" } satisfies Break;
    case n.raw_inline:
      return { type: "html", value: node.attrs.value as string } satisfies Html;
    default:
      return unsupported(node.type.name);
  }
}

/**
 * Convert an mdast root (PRD §6.1) into an editable document: the `yaml` front matter is lifted out
 * of the tree and returned beside the doc, every other child becomes a block.
 */
export function mdastToPM(root: Root): EditorDocument {
  let frontMatter: Yaml | null = null;
  const blocks: RootContent[] = [];
  for (const child of root.children) {
    if (child.type === "yaml") {
      frontMatter = { type: "yaml", value: child.value };
      continue;
    }
    blocks.push(child);
  }
  return { doc: schema.node("doc", null, blocksToPM(blocks)), frontMatter };
}

/**
 * Convert an editable document back into an mdast root, re-attaching the front matter as the
 * root's first child with its bytes untouched.
 */
export function pmToMdast(document: EditorDocument): Root {
  const children = blocksToMdast(document.doc);
  return {
    type: "root",
    children: document.frontMatter === null ? children : [{ ...document.frontMatter }, ...children],
  };
}
