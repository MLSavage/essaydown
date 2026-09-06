import { gfmAutolinkLiteralToMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import type { Html, Root, Yaml } from "mdast";
import remarkStringify, { type Options } from "remark-stringify";
import { unified, type Data, type Processor } from "unified";

type ToMarkdownExtensions = NonNullable<Data["toMarkdownExtensions"]>;
type Handlers = NonNullable<Options["handlers"]>;

/**
 * `remark-stringify` options implementing docs/MARKDOWN-STYLE.md: ATX headings, `-` bullets,
 * `1.` ordered lists with incrementing numbers, ``` fences with the info string preserved,
 * `---` thematic breaks, `*emphasis*` / `**strong**`, inline links and images with
 * double-quoted titles, and — because remark-stringify never reflows paragraph text — no hard
 * wrap. The single trailing newline is the serializer's own guarantee.
 */
export function stringifyOptions(): Options {
  return {
    bullet: "-",
    bulletOrdered: ".",
    listItemIndent: "one",
    incrementListMarker: true,
    emphasis: "*",
    strong: "*",
    fence: "`",
    fences: true,
    rule: "-",
    ruleRepetition: 3,
    ruleSpaces: false,
    setext: false,
    resourceLink: false,
    quote: '"',
  };
}

/**
 * Byte-preserving handlers for the opaque set of PRD §6.1. An `html` node is emitted as the exact
 * bytes the parser captured. A `yaml` node is re-fenced with `---` around its untouched value, so
 * quoting style, comments, block scalars, duplicate keys and malformed YAML all survive the trip;
 * only an in-app edit of `title` or `question` ever rewrites anything inside it.
 */
export function opaqueHandlers(): Handlers {
  return {
    html: (node) => (node as Html).value,
    yaml: (node) => {
      const { value } = node as Yaml;
      return value === "" ? "---\n---" : `---\n${value}\n---`;
    },
  };
}

/** The `mdast-util` serializers matching the parse-side extension set (PRD §4). */
export function toMarkdownExtensions(): ToMarkdownExtensions {
  return [gfmTableToMarkdown(), gfmStrikethroughToMarkdown(), gfmAutolinkLiteralToMarkdown()];
}

/**
 * A formatter configured for docs/MARKDOWN-STYLE.md. Built per call, for the same reason as
 * `createParser`: `packages/core` keeps no module-level configuration (PRD §9).
 */
export function createFormatter(): Processor<undefined, undefined, undefined, Root, string> {
  return unified()
    .use(remarkStringify, stringifyOptions())
    .use(function attachOpaqueAndGfm(this: Processor) {
      const data = this.data();
      const extensions: ToMarkdownExtensions = (data.toMarkdownExtensions ??= []);
      extensions.push(...toMarkdownExtensions(), { handlers: opaqueHandlers() });
    }) as Processor<undefined, undefined, undefined, Root, string>;
}

/** Serialize an mdast root in the canonical style of docs/MARKDOWN-STYLE.md. */
export function format(root: Root): string {
  return createFormatter().stringify(root);
}
