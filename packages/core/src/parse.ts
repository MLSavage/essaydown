import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { Nodes, Root } from "mdast";
import { gfmAutolinkLiteral } from "micromark-extension-gfm-autolink-literal";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified, type Data, type Processor } from "unified";

type MicromarkExtensions = NonNullable<Data["micromarkExtensions"]>;
type FromMarkdownExtensions = NonNullable<Data["fromMarkdownExtensions"]>;

/**
 * The GFM subset of PRD §4: tables, strikethrough and autolink literals, each as its individual
 * micromark extension. Footnotes and task lists are deliberately absent, so `[^1]` and `- [ ]`
 * reach the tree as plain `text` (PRD §6.1).
 */
export function micromarkExtensions(): MicromarkExtensions {
  return [gfmTable(), gfmStrikethrough({ singleTilde: false }), gfmAutolinkLiteral()];
}

/** The `mdast-util` counterparts of {@link micromarkExtensions}. */
export function fromMarkdownExtensions(): FromMarkdownExtensions {
  return [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmAutolinkLiteralFromMarkdown()];
}

/**
 * A parser configured for the §6.1 node set: `remark-parse`, `remark-frontmatter` for the `yaml`
 * block, and the three GFM extensions above. Built per call — `packages/core` keeps no
 * module-level configuration (PRD §9), so no state is shared between documents.
 */
export function createParser(): Processor<Root> {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(function attachGfm(this: Processor) {
      const data = this.data();
      const micromark: MicromarkExtensions = (data.micromarkExtensions ??= []);
      const fromMarkdown: FromMarkdownExtensions = (data.fromMarkdownExtensions ??= []);
      micromark.push(...micromarkExtensions());
      fromMarkdown.push(...fromMarkdownExtensions());
    }) as Processor<Root>;
}

/**
 * Parse Markdown into the mdast root of PRD §6.1. Line endings are normalised to LF on the way
 * in — micromark itself only drops the CR between blocks, keeping it inside multi-line
 * paragraphs and fenced code, so the rewrite runs over the whole document (opaque nodes
 * included) before the parser ever sees it. Every other byte reaches the tree as written, and
 * the opaque set (`html`, `yaml`) keeps its (now LF-only) source bytes verbatim in `node.value`.
 */
export function parse(markdown: string): Root {
  const normalised = markdown.replace(/\r\n?/g, "\n");
  const root = createParser().parse(normalised);
  markAutolinkLiterals(root, normalised);
  unescapeCellLinkPipes(root, normalised, false);
  return root;
}

declare module "mdast" {
  interface LinkData {
    /**
     * Set by {@link parse} on a link the source wrote as a GFM autolink literal — a bare
     * `https://…`, `www.…` or e-mail address, with no `<…>` and no `[…](…)` around it — so that
     * the formatter can write it back bare (task 3.14). Absent on every other link.
     */
    autolinkLiteral?: true;
  }
}

/**
 * Mark every link the source wrote as a GFM autolink literal (task 3.14): the mdast of a literal
 * and of a `<…>` autolink are otherwise the same tree, and each form's bytes are the writer's. The
 * two ways the installed extension makes a literal are both read here: a micromark
 * `literalAutolink` token, whose link starts at the literal's first byte — never `<` or `[`, the
 * first byte of the other two forms — and `mdast-util-gfm-autolink-literal`'s
 * `transformGfmAutolinkLiterals` (2.0.1, `lib/index.js`), whose `findAndReplace` builds the link
 * with no `position`. Resource, reference and `<…>` links all start at `<` or `[`.
 */
function markAutolinkLiterals(node: Nodes, source: string): void {
  if (node.type === "link") {
    const start = node.position?.start.offset;
    const first = start === undefined ? undefined : source.charAt(start);
    if (first !== "<" && first !== "[") node.data = { ...node.data, autolinkLiteral: true };
  }
  if ("children" in node) for (const child of node.children) markAutolinkLiterals(child, source);
}

/**
 * A table cell's `\|` read the way GFM §4.10 reads it (task 4.6, DECISIONS #review-3-r2): the
 * spec replaces the pipe escape with `|` in a cell before any inline construct is parsed, while
 * micromark leaves the cell's bytes as they stand and lets each inline construct decode them. Every
 * construct that decodes a backslash escape (text, a resource link's label and destination)
 * already reads `\|` as `|`; the two that read their bytes literally keep the backslash, and
 * so differ from every other GFM reader: inline code, which `mdast-util-gfm-table`'s
 * `exitCodeText` already normalises (`lib/index.js`), and a link whose bytes the parser takes raw —
 * a `<…>` autolink and a GFM autolink literal the tokenizer made. Those are the links that start
 * at a byte other than `[` and carry a `position`: the transform-made literal (no `position`)
 * was found in already-decoded text, where a second pass would remove a backslash the source
 * escaped. Their url and their text child are rewritten with `exitCodeText`'s own rule,
 * {@link unescapeCellPipes}.
 */
function unescapeCellLinkPipes(node: Nodes, source: string, inCell: boolean): void {
  if (inCell && node.type === "link") {
    const start = node.position?.start.offset;
    if (start !== undefined && source.charAt(start) !== "[") {
      node.url = unescapeCellPipes(node.url);
      for (const child of node.children) {
        if (child.type === "text") child.value = unescapeCellPipes(child.value);
      }
    }
    return;
  }
  const inside = inCell || node.type === "tableCell";
  if ("children" in node) for (const child of node.children) unescapeCellLinkPipes(child, source, inside);
}

/**
 * `value` with each `\|` read as `|`, scanning left to right so that a `\\` pair is kept as it
 * stands and never lends its second backslash to a `|` after it — `mdast-util-gfm-table`'s
 * `exitCodeText` rule (`value.replace(/\\([\\|])/g, …)`, "pipes work, backslashes don't"), the
 * same pairing the table tokenizer's `bodyRowEscape` makes.
 */
export function unescapeCellPipes(value: string): string {
  return value.replace(/\\([\\|])/g, (pair, next: string) => (next === "|" ? next : pair));
}
