import { gfmAutolinkLiteralFromMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import type { Root } from "mdast";
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
 * in; every other byte reaches the tree as written, and the opaque set (`html`, `yaml`) keeps
 * its source bytes verbatim in `node.value`.
 */
export function parse(markdown: string): Root {
  return createParser().parse(markdown);
}
