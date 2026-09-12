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
  Fragment,
  Schema,
  type DOMOutputSpec,
  type Mark as PMMark,
  type MarkSpec,
  type MarkType,
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
 * The three node types whose content is inline text, and the two whitespace settings they share.
 *
 * mdast writes a Markdown **soft line break** — a paragraph wrapped over two source lines — as a
 * literal `\n` inside a `text` node, so it is a literal `\n` in the text node `toDOM` produces.
 * ProseMirror's DOM parser normalises `\n` to a space unless the context is "preserve whitespace,
 * fully", and there are **two** independent paths into that parser, each reading a different
 * setting (DECISIONS #review-1-r1 G3):
 *
 * - The **clipboard** path. `prosemirror-view` builds a `DOMParser` from this schema, so a copied
 *   or pasted `<p>` is matched against the `parseDOM` rules below and each rule's own
 *   `preserveWhitespace` decides. That is {@link INLINE_WHITESPACE}, added by task 1.14 when a
 *   wrapped blockquote came back joined onto one line.
 * - The **typing** path. `prosemirror-view` reparses the DOM the browser just mutated
 *   (`readDOMChange` → `parseBetween`) and does *not* go through a `parseDOM` rule for the block
 *   the caret is in: it reads the node type's own `whitespace` property instead
 *   (`preserveWhitespace: $from.parent.type.whitespace == "pre" ? "full" : true`, and the same
 *   property again when it synthesises a parse rule for a node view). `true` preserves runs of
 *   spaces but still rewrites every `\n` to a space, which is why typing a single character
 *   anywhere in a wrapped paragraph rewrote all of its line breaks. {@link INLINE_PRE} is the
 *   setting that path reads.
 *
 * Both are kept, and **only `whitespace: "pre"` is load-bearing** — verified in the browser by
 * mutation, not reasoned about (task 1.25's journal records both runs). Deleting it turns exactly
 * the three soft-break browser cases red (`editor-soft-line-breaks.spec.ts`'s two typing cases and
 * `editor-cursor.spec.ts`'s blockquote case) while every headless suite stays green, because no
 * headless suite drives `readDOMChange`. Deleting `preserveWhitespace` from the rules instead
 * turns *nothing* behavioural red — 68 of 68 browser cases and 1928 of 1929 unit tests pass, and
 * the one failure is `parse-dom.test.ts` reading the rule's own property — because `wsOptionsFor`
 * (prosemirror-model) consults `type.whitespace == "pre"` whenever a rule leaves
 * `preserveWhitespace` unset, so for these three types the two settings compute the same option
 * bits. The rule-level setting is retained anyway: it states the policy at the rule a reader of
 * the clipboard path actually lands on, it is what task 1.14's finding was written against, and a
 * node type that ever loses `"pre"` for another reason must not silently take the clipboard path
 * down with it.
 *
 * The cost, stated because it is real: whitespace in *foreign* HTML is no longer collapsed either,
 * so a web page's `<p>` pasted with its source indentation keeps that indentation as soft breaks
 * and runs of spaces — which render as one space in any Markdown reader, and which
 * {@link stripUnparsableWhitespace} strips on the way out at every boundary micromark strips it
 * at (tasks 1.13 and 1.25). Byte fidelity for the editor's own documents (PRD §6, invariant C) is
 * worth that; silently rewriting the user's own line breaks is not.
 */
const INLINE_WHITESPACE = "full" as const;

/** The typing-path half of {@link INLINE_WHITESPACE}; see that comment for which path reads it. */
const INLINE_PRE = "pre" as const;

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
    whitespace: INLINE_PRE,
    toDOM: (): DOMOutputSpec => ["p", 0],
    parseDOM: [{ tag: "p", preserveWhitespace: INLINE_WHITESPACE }],
  },

  heading: {
    group: "block",
    content: "inline*",
    attrs: { depth: { default: 1 } },
    defining: true,
    whitespace: INLINE_PRE,
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
    whitespace: INLINE_PRE,
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
 * Mark specs. **Declaration order is the nesting order where the runs coincide**: ProseMirror
 * keeps a mark set sorted by the type's rank in this object, and {@link pmToMdast} wraps the mark
 * whose run reaches furthest outermost ({@link outermostMark}: `*[b](u) c*` is emphasis around a
 * link, `[*b* c](u)` a link around emphasis, because that is the only nesting either tree has),
 * falling back to the lowest rank when two runs cover exactly the same span. So a text span
 * carrying `link` and `strong` and nothing beside it comes back as `[**a**](url)`, never
 * `**[a](url)**`.
 *
 * That is a real, deliberate normalisation, and the price of the ProseMirror mark model (PRD §4):
 * PM records *which* marks cover a character, not how the source nested them, so the nesting of
 * two marks over the same span cannot survive the trip and has to be chosen. `link` is outermost
 * because that is what CommonMark produces for the common `[**a**](url)`, and `code` is innermost
 * because mdast's `inlineCode` holds literal text and can contain nothing else. The one exception
 * (task 1.35, DECISIONS #review-1-r3 I3) is a span whose edge holds whitespace or a hard break:
 * `*[b ](u)*` and `[*b* ](u)` are different trees, and the flat span `[link, emphasis]("b ")` is
 * only ever the first, so the flanking mark is written outermost there — the only nesting in
 * which the delimiter's neighbour is not the whitespace (CommonMark §6.2). `schema.test.ts` pins
 * the normalisation on hand-written input.
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
 * round-trip to their own bytes. A paragraph {@link stripUnparsableWhitespace} empties — one
 * holding only whitespace, or only a trailing hard break (task 1.29) — is the same node by the
 * time it is dropped: between two other blocks the serializer would write it as an extra blank
 * line, which `parse` reads as nothing, so dropping it is what keeps that trip a fixed point.
 */
function blocksToPM(children: readonly RootContent[]): PMNode[] {
  const blocks = children.map(blockToPM);
  return blocks.length > 0 ? blocks : [schema.node("paragraph")];
}

function blocksToMdast(node: PMNode): RootContent[] {
  const out: RootContent[] = [];
  node.forEach((child) => {
    const block = blockToMdast(child);
    if (block.type === "paragraph" && block.children.length === 0) return;
    out.push(block);
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
        children: inlineToMdast(stripUnparsableWhitespace(childrenOf(node), LINE_ENDING)),
      } satisfies Paragraph;
    case n.heading:
      return {
        type: "heading",
        depth: node.attrs.depth as Heading["depth"],
        children: inlineToMdast(stripUnparsableWhitespace(childrenOf(node), LINE_ENDING)),
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
        children: inlineToMdast(stripUnparsableWhitespace(childrenOf(node), CELL_LINE_ENDING)),
      } satisfies TableCell;
    case n.raw:
      return { type: "html", value: node.attrs.value as string } satisfies Html;
    default:
      return unsupported(node.type.name);
  }
}

/**
 * The ASCII whitespace of CommonMark §2.1 — space, tab, line feed, line tabulation, form feed and
 * carriage return — which is the set micromark strips at a block's two ends. Written as the
 * character class rather than as `\s` on purpose: `\s` also matches the Unicode spaces (U+00A0 and
 * the U+2000 block) that a Markdown file *does* keep, so trimming with it would delete bytes
 * `parse` preserves.
 */
const ASCII_WHITESPACE = /[\t\n\v\f\r ]+/;
const LEADING_WHITESPACE = new RegExp(`^${ASCII_WHITESPACE.source}`);
const TRAILING_WHITESPACE = new RegExp(`${ASCII_WHITESPACE.source}$`);

/**
 * A **line-ending run**: any run of ASCII whitespace that contains at least one line ending,
 * matched maximally in both directions so that the whitespace on either side of the break is part
 * of the match. Replacing it with the block's one line ending ({@link LINE_ENDING} or
 * {@link CELL_LINE_ENDING}) is what discharges three of the boundaries in
 * {@link stripUnparsableWhitespace}'s ownership rule at once — the space before a soft break, the
 * space after it, and a whitespace-only line between two of them.
 */
const LINE_ENDING_RUN = /[\t\v\f ]*[\n\r][\t\n\v\f\r ]*/g;

/** What a line-ending run collapses to in a paragraph or heading: one soft line break. */
const LINE_ENDING = "\n";

/**
 * What a line-ending run collapses to in a table cell: one space (task 1.29, DECISIONS
 * #review-1-r2 H6). A GFM cell cannot hold a line ending — the row is the line, so the ending
 * would end the row — and the serializer, which is right about that, spells one as `&#xA;`, bytes
 * no cell a Markdown file parses to has ever held. A space is what the same characters mean to a
 * reader of the rendered table (the cell's text wraps as ordinary whitespace), and it is the
 * only whitespace a cell can carry across the trip.
 */
const CELL_LINE_ENDING = " ";

/**
 * Strip the whitespace `parse` never keeps, so that the tree leaving the editor is one some
 * Markdown file parses to (DECISIONS #review-1-r0 F1, #review-1-r1 G4, #review-1-r2 H1/H5/H6/H8;
 * PRD §6 portability).
 *
 * ProseMirror keeps every character typed into a paragraph, heading or table cell; micromark does
 * not. Where the two disagree the serializer's `unsafe` table faithfully encodes the difference —
 * a space before a line ending becomes a numeric character reference — so the editor's Markdown is
 * bytes no Markdown file contains and no round trip is a fixed point of. The strip therefore
 * belongs here, on the way out of the editor's tree, where the serializer, the copy button and the
 * store all read the same document; not in the serializer's `unsafe` table, which is right about
 * the trees it is given.
 *
 * **Ownership rule, stated once for the whole boundary family** (task 1.13 closed the block's two
 * ends only; task 1.25 the line boundaries inside it; task 1.29 the atom at the block's end and
 * the cell; task 1.30 the mark edge; task 1.34 the atom at the mark edge; task 1.35 the link
 * edge). Whitespace belongs to the boundary it touches, and the boundaries are exactly the ones
 * micromark normalises:
 *
 * - **The outer edge of an `emphasis`, `strong` or `delete` run** gives up the ASCII whitespace
 *   inside it: it belongs **outside** the mark (task 1.30, DECISIONS #review-1-r2 H8). A run's
 *   leading whitespace moves before the mark and its trailing whitespace after it, merged into
 *   the neighbour whose marks it now shares where there is one — `text("a "), em("b "),
 *   text("c")` becomes `text("a "), em("b"), text(" c")` — and a run that is whitespace-only
 *   simply loses the mark. CommonMark §6.2 is why: a closing delimiter run must be
 *   right-flanking, which it is not when preceded by whitespace, and an opening one left-flanking,
 *   which it is not when followed by whitespace (GFM's `~~` is under the same rule), so
 *   `emphasis[text("b ")]` is a tree no Markdown file parses to, and the serializer, right about
 *   that, spells the space as a numeric character reference (`&#x20;`, the byte family of F1) —
 *   or, for `delete`, writes the tildes as they are and the strikethrough is lost on the way
 *   back. A caret at the end of an emphasised word sits inside the mark, so one space typed there
 *   is the one-keystroke route. Nested marks give up the whitespace from every mark whose edge it
 *   touches: `em+strong("b ")` before unmarked text hands its space to both. A **link's** text
 *   keeps its whitespace (`[b ](u)` is a link; `link` is not a flanking mark), which is also why
 *   the moved whitespace keeps every mark other than the one whose edge it left, and inline code
 *   stays opaque. **The link predicate** (task 1.35, DECISIONS #review-1-r3 I3): the edge scan
 *   stops at a node carrying `link` when the node beyond it on that side — the next node the
 *   scan would step to, or the one outside the run where there is none — does not carry the
 *   same link, because the link's edge then coincides with the run's edge and the delimiter's
 *   actual neighbour in the bytes is the bracket, not the whitespace: `*a [b ](u)* c` closes on
 *   `)`, `x *[ b](u)*` opens on `[`, both flanking, and nothing has to move. ProseMirror's flat
 *   mark set (`[link, emphasis]` on one text node) cannot say which mark is outermost in the
 *   serialisation, so the predicate is read from the neighbour, the way §6.2 reads it; 1.30's
 *   clause assumed the flanking mark was outermost and split the link, inventing a second,
 *   whitespace-only link (`*a [b](u)*[ ](u) c`). When the link continues past the run
 *   (`[*b* c](u)`: the node beyond carries the same link) the flanking mark *is* the inner one
 *   and the whitespace moves within the link, as before. **A `hard_break` at either edge of the run leaves the mark the way a
 *   whitespace-only run does** (task 1.34, DECISIONS #review-1-r3 I1): the break gives up the
 *   mark and the edge scan continues past it, so `[em(a), em(break), text(" c")]` becomes
 *   `[em(a), break, text("c")]` — `*a*\` newline `c`, which `parse` reads as `emphasis[a],
 *   break, text(c)` — and `[text("x "), em(break), em(b)]` becomes `[text("x "), break, em(b)]`
 *   (`x \` newline `*b*`) the same way; two breaks at an edge both leave. §6.2 again: a break
 *   ends a line, so the closing delimiter after it would open a line and the opening delimiter
 *   before it would close one, neither flanking, and the serializer, right about that, spells the
 *   break's line ending as a numeric character reference inside the delimiters and escapes the
 *   character after them (`*a\&#xA;*&#x63;`, the family of F1 again — the break gone and the
 *   entity now text). One Backspace in an emphasised verse loaded from a file is the route: every
 *   loaded file supplies the break, and deleting the text after it leaves the break last in the
 *   run with unmarked text after it. A break that is then the block's last node falls to the
 *   block's-end clause below as before. This clause runs **first**, on the incoming list, so that
 *   the whitespace it moves then falls under the line and block rules below like any other — a
 *   space moved to the block's end is the block's end's, and dropped.
 * - **Every line start** takes the ASCII whitespace after it. A block's first inline node starts a
 *   line (CommonMark §4.8: a paragraph's leading whitespace is stripped); so does the position
 *   after a `hard_break` (§6.7: "leading spaces at the beginning of the next line are ignored");
 *   so does the position after a soft line break (§6.8). **A text node carrying `link` stops the
 *   block-start trim** (task 1.35, DECISIONS #review-1-r3 I4): the block's first byte is then the
 *   link's `[`, and `[ b](u)` is a link whose text begins with a space, which §4.8 does not
 *   touch. The two other line starts are not stopped: a continuation line's leading whitespace
 *   is stripped at the block level, before inline parsing sees the link, so `[a\` newline `  b](u)`
 *   parses to `[a\` newline `b](u)` inside the link as it does outside one.
 * - **Every line end** gives up the ASCII whitespace before it (§6.8, the other half of the soft
 *   break's rule). A **hard break is the exception**: it owns the whitespace *after* it and not
 *   the whitespace before it, because `foo \` is exactly how the serializer spells a break after a
 *   text run ending in a space, and that parses back to the same run.
 * - **The block's end** takes the trailing whitespace of its last inline node **and drops a
 *   trailing `hard_break`**, repeatedly, until the last node is neither a whitespace-only run nor
 *   a break — **or is a text node carrying `link`**, which stops the loop with its whitespace kept
 *   (task 1.35, I4): the block's end is then the link's `)`, and `see [the essay ](u)` is a link
 *   whose text ends in a space, bytes micromark keeps and the strip used to rewrite. A break with
 *   nothing after it is not a line break: the serializer spells it as a
 *   backslash before the block's own line ending, and §6.7 reads a backslash at a paragraph's end
 *   as a literal backslash (a heading's is worse — `H\` on its own line reparses as a paragraph,
 *   the block type lost). So it is dropped the way a run trimmed to nothing is dropped, and the
 *   node before it becomes the last node: the whitespace the break did not own is now the
 *   block's end's, and goes with it. A block that is only breaks and whitespace becomes an empty
 *   block, whose fixed point is the one it already has: an empty `paragraph` is dropped by
 *   {@link blocksToMdast} exactly as one ProseMirror already holds empty is, so it has no bytes
 *   at all; an empty `heading` is written by `format` as its marker alone (`##`), which `parse`
 *   reads back as the same empty heading.
 * - A whitespace run holding **two or more line endings collapses to one line ending**: those
 *   bytes spell a blank line, a paragraph node cannot hold one, and splitting the block instead
 *   would mean this function inventing block structure. Collapsing keeps the tree stable across
 *   the round trip; the blank line is the thing no file could have produced here.
 * - **Inside a table cell** every line-ending run collapses to one *space* rather than to `\n`
 *   ({@link CELL_LINE_ENDING}): a GFM row ends at its line ending, so a cell cannot hold one and
 *   the serializer would spell it as `&#xA;`. The cell's own two ends are the block's two ends
 *   above, unchanged.
 *
 * Zero-width and opaque items. An atom (`image`, `hard_break`, `raw_inline`) or an `inline_code`
 * run is opaque: it owns the whitespace inside it, stops the strip (the mark-edge scan included:
 * a marked run that begins or ends at an image, a raw atom or an inline-code run keeps what is
 * inside; a `hard_break` at a run's edge is the one atom that scan does not stop at — it leaves
 * the mark, as the mark-edge clause says, unless it carries a link whose edge is the run's, when
 * the link predicate stops the scan before the atom clause is reached), and (`hard_break` aside)
 * puts the scan mid-line. A run
 * trimmed to nothing is dropped rather than kept as a zero-length text node, which ProseMirror
 * rejects; dropping it leaves the line-boundary state as it found it,
 * because emitting nothing neither starts nor ends a line. The block's *start* is therefore the
 * first node that survives the strip (a dropped run leaves `atLineStart` as it was), and the
 * block's *end* is the last node that survives it (the end-of-block loop below takes the
 * trailing whitespace of whichever node is last once the breaks and empty runs before it are
 * gone) — so a whitespace-only run at either end promotes its neighbour to that end, which is
 * what an atom or an inline-code run at the end then stops. Blocks whose content is not inline —
 * `code_block`, `raw`, and the opaque `html`/`yaml` bytes — never reach this function.
 *
 * @param lineEnding what a line-ending run collapses to: {@link LINE_ENDING} in a paragraph or
 *   heading, {@link CELL_LINE_ENDING} in a table cell.
 */
function stripUnparsableWhitespace(nodes: readonly PMNode[], lineEnding: string): PMNode[] {
  const out: PMNode[] = [];
  let atLineStart = true;
  for (const node of unmarkEdgeWhitespace(nodes)) {
    if (!node.isText || schema.marks.inline_code.isInSet(node.marks) !== undefined) {
      atLineStart = node.type === schema.nodes.hard_break;
      out.push(node);
      continue;
    }
    let text = (node.text as string).replace(LINE_ENDING_RUN, lineEnding);
    // The block's start is the first node that survives; a link there keeps its leading
    // whitespace (the block's first byte is its `[`), a link after a line ending does not.
    const atBlockStart = out.length === 0;
    if (atLineStart && !(atBlockStart && isLinked(node)))
      text = text.replace(LEADING_WHITESPACE, "");
    if (text === "") continue;
    atLineStart = text.endsWith("\n");
    out.push(text === node.text ? node : schema.text(text, node.marks));
  }
  // The block's end: drop trailing breaks and whitespace-only runs, and take the trailing
  // whitespace of the run that is last once they are gone, until the last node is neither.
  for (;;) {
    const last = out[out.length - 1];
    if (last === undefined) break;
    if (last.type === schema.nodes.hard_break) {
      out.pop();
      continue;
    }
    if (!last.isText || schema.marks.inline_code.isInSet(last.marks) !== undefined) break;
    if (isLinked(last)) break;
    const text = (last.text as string).replace(TRAILING_WHITESPACE, "");
    if (text === "") {
      out.pop();
      continue;
    }
    if (text !== last.text) out[out.length - 1] = schema.text(text, last.marks);
    break;
  }
  return out;
}

/** A node carrying the `link` mark: its edge whitespace is the link's, inside the brackets. */
function isLinked(node: PMNode): boolean {
  return schema.marks.link.isInSet(node.marks) !== undefined;
}

/**
 * The link predicate of the mark-edge clause (task 1.35): the scan stops at `run[k]` when it
 * carries a link whose own run — the maximal stretch of nodes carrying the same link, followed
 * through the run and into `before` and `after`, the nodes outside it on each side — lies inside
 * the flanking run, because the link is then the inner mark and the delimiter's neighbour in the
 * bytes is the link's bracket. A link that continues past the flanking run on either side is the
 * outer mark ({@link outermostMark} nests by the same extents), and the whitespace moves within
 * it as for any other inner text. `isInSet` compares marks by `eq`, so a link is "the same" when
 * its `url` and `title` are.
 */
function linkEdgeStops(
  run: readonly PMNode[],
  k: number,
  before: PMNode | undefined,
  after: PMNode | undefined,
): boolean {
  const link = schema.marks.link.isInSet(run[k].marks);
  if (link === undefined) return false;
  let a = k;
  while (a > 0 && link.isInSet(run[a - 1].marks)) a -= 1;
  if (a === 0 && before !== undefined && link.isInSet(before.marks)) return false;
  let b = k;
  while (b < run.length - 1 && link.isInSet(run[b + 1].marks)) b += 1;
  return !(b === run.length - 1 && after !== undefined && link.isInSet(after.marks));
}

/**
 * The marks whose delimiters have to flank their content (CommonMark §6.2 for `*`/`_`, GFM for
 * `~~`), in the order the mark-edge clause of {@link stripUnparsableWhitespace} visits them. The
 * order does not change the result — each pass removes only its own mark, never adds one, and a
 * split it makes leaves the other marks' runs exactly where they were — it only fixes which
 * pass does the splitting when two runs share an edge.
 */
const FLANKING_MARKS: readonly MarkType[] = [
  schema.marks.emphasis,
  schema.marks.strong,
  schema.marks.delete,
];

/** A text run the strip may split or trim: text that is not inline code (which is opaque). */
function isStrippable(node: PMNode): boolean {
  return node.isText && schema.marks.inline_code.isInSet(node.marks) === undefined;
}

/**
 * The mark-edge clause of {@link stripUnparsableWhitespace}'s ownership rule: for every maximal
 * run of every flanking mark, the ASCII whitespace at the run's outer edge leaves the mark.
 *
 * A run is `[i, j)` over the list as it stands when that mark's pass reaches it: `i` the first
 * node carrying the mark, `j` the first node after it that does not (the same half-open cut as
 * {@link inlineToMdast}). Its leading edge is scanned from `i` forward and its trailing edge from
 * `j - 1` back, each scan stepping over whitespace-only runs and `hard_break`s (which lose the
 * mark whole), then splitting the first run with content into its edge whitespace, unmarked, and
 * the rest, and stopping there — or at any other atom or an inline-code run, which is opaque, or
 * at a link whose edge is the run's ({@link linkEdgeStops}). The whole list is then
 * rejoined the way ProseMirror joins it (`Fragment.fromArray`: adjacent text with the same marks
 * becomes one node), so a moved space and its unmarked neighbour are one run for the line and
 * block rules that follow. First, middle and last positions of a run in the block are cut by the
 * same rule; `editor-fixed-point.test.ts` asserts each.
 */
function unmarkEdgeWhitespace(nodes: readonly PMNode[]): PMNode[] {
  let out = [...nodes];
  for (const mark of FLANKING_MARKS) {
    let i = 0;
    while (i < out.length) {
      if (mark.isInSet(out[i].marks) === undefined) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < out.length && mark.isInSet(out[j].marks) !== undefined) j += 1;
      const run = giveUpEdges(out.slice(i, j), mark, out[i - 1], out[j]);
      out = [...out.slice(0, i), ...run, ...out.slice(j)];
      i += run.length;
    }
  }
  return [...Fragment.fromArray(out).content];
}

/**
 * One run of `mark`, its edge whitespace given up on both sides (see {@link unmarkEdgeWhitespace}).
 * `before` and `after` are the nodes outside the run on each side (`undefined` at the block's
 * ends), which the link predicate ({@link linkEdgeStops}) reads to tell a link inside the run
 * from one that continues past it.
 */
function giveUpEdges(
  run: readonly PMNode[],
  mark: MarkType,
  before: PMNode | undefined,
  after: PMNode | undefined,
): PMNode[] {
  const out = [...run];
  const without = (node: PMNode): readonly PMMark[] => mark.removeFromSet(node.marks);
  for (let k = 0; k < out.length; k += 1) {
    const node = out[k];
    if (linkEdgeStops(out, k, before, after)) break;
    if (node.type === schema.nodes.hard_break) {
      out[k] = node.mark(without(node));
      continue;
    }
    if (!isStrippable(node)) break;
    const text = node.text as string;
    const edge = LEADING_WHITESPACE.exec(text);
    if (edge === null) break;
    if (edge[0].length === text.length) {
      out[k] = node.mark(without(node));
      continue;
    }
    out.splice(
      k,
      1,
      schema.text(edge[0], without(node)),
      schema.text(text.slice(edge[0].length), node.marks),
    );
    break;
  }
  for (let k = out.length - 1; k >= 0; k -= 1) {
    const node = out[k];
    if (linkEdgeStops(out, k, before, after)) break;
    if (node.type === schema.nodes.hard_break) {
      out[k] = node.mark(without(node));
      continue;
    }
    if (!isStrippable(node)) break;
    const text = node.text as string;
    const edge = TRAILING_WHITESPACE.exec(text);
    if (edge === null) break;
    if (edge[0].length === text.length) {
      out[k] = node.mark(without(node));
      continue;
    }
    out.splice(
      k,
      1,
      schema.text(text.slice(0, -edge[0].length), node.marks),
      schema.text(edge[0], without(node)),
    );
    break;
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
 * by the same rule (`schema.test.ts` asserts a mark in each of the three positions). Which of a
 * node's marks is wrapped first is {@link outermostMark}'s.
 */
function inlineToMdast(nodes: readonly PMNode[]): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  let i = 0;
  while (i < nodes.length) {
    const outer = outermostMark(nodes, i);
    if (outer === undefined) {
      out.push(leafToMdast(nodes[i]));
      i += 1;
      continue;
    }
    const j = runEnd(nodes, i, outer);
    const inner = nodes.slice(i, j).map((node) => node.mark(outer.removeFromSet(node.marks)));
    out.push(wrapMark(outer, inner));
    i = j;
  }
  return out;
}

/** The end of `mark`'s maximal run starting at `i`: the first index after it that does not carry it. */
function runEnd(nodes: readonly PMNode[], i: number, mark: PMMark): number {
  let j = i + 1;
  while (j < nodes.length && mark.isInSet(nodes[j].marks)) j += 1;
  return j;
}

/** Whether the run `[i, j)` begins or ends with ASCII whitespace or a hard break — an edge that only a link's bracket can shield from CommonMark §6.2's flanking rules. */
function runHasEdgeWhitespace(nodes: readonly PMNode[], i: number, j: number): boolean {
  const edge = (node: PMNode, pattern: RegExp): boolean =>
    node.type === schema.nodes.hard_break || (node.isText && pattern.test(node.text as string));
  return edge(nodes[i], LEADING_WHITESPACE) || edge(nodes[j - 1], TRAILING_WHITESPACE);
}

/**
 * The mark {@link inlineToMdast} wraps outermost at `i` (see {@link marks} for the rule): the one
 * whose run from `i` reaches furthest, ties broken by rank — except that a `link` tied with a
 * flanking mark over a run with edge whitespace yields to it (task 1.35), and `inline_code`,
 * which can hold nothing, is never chosen while another mark is on the node.
 */
function outermostMark(nodes: readonly PMNode[], i: number): PMMark | undefined {
  let best: PMMark | undefined;
  let bestEnd = i;
  for (const mark of nodes[i].marks) {
    if (mark.type === schema.marks.inline_code && nodes[i].marks.length > 1) continue;
    const end = runEnd(nodes, i, mark);
    if (best === undefined || end > bestEnd) {
      best = mark;
      bestEnd = end;
      continue;
    }
    if (
      end === bestEnd &&
      best.type === schema.marks.link &&
      FLANKING_MARKS.includes(mark.type) &&
      runHasEdgeWhitespace(nodes, i, end)
    )
      best = mark;
  }
  return best;
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
