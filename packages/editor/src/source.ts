import type { Extension } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Tag, styleTags } from "@lezer/highlight";
import { Autolink, Table } from "@lezer/markdown";

/**
 * CodeMirror 6 source view (PRD §4's "toggle to source view to see the raw, color-coded
 * Markdown"). This module is pure — no DOM — so vitest exercises it directly; the caller (a dev
 * route today, the real source pane later) turns {@link sourceExtensions} into an `EditorView`.
 *
 * **The 7 token classes.** `@lezer/markdown`'s own highlighting collapses every delimiter node
 * (`HeaderMark`, `ListMark`, `QuoteMark`, `CodeMark`, `EmphasisMark`, `LinkMark`,
 * `TableDelimiter`) onto one shared tag, `tags.processingInstruction` — verified by parsing a
 * sample document with the stock `markdownHighlighting` and reading each node's resolved tag; a
 * `HighlightStyle` built on that tag alone cannot tell a list marker from a table delimiter. This
 * module instead defines seven private {@link Tag}s and layers its own {@link styleTags} rule
 * over the base language's, so `NodeSet.extend`'s later-wins-per-node semantics (verified the
 * same way) replace the shared tag with one of these seven wherever it was assigned. Colors are
 * not set here: `essaydown-tok-*` classes are plain CSS in `source.css`, switched between light
 * and dark by a `prefers-color-scheme` media query — the browser decides, not this module — which
 * is why `sourceExtensions` never installs `EditorView.theme`'s own dark flag.
 *
 * **Task lists and strikethrough** are GFM extensions this module does not enable: only `Table`
 * (for the table-delimiter class) and `Autolink` (so a bare URL still counts as a link) are
 * added, not the combined `GFM` bundle, so `- [ ] x` parses as an ordinary list item whose text
 * happens to start with `[ ] x` — consistent with task lists staying plain text elsewhere in the
 * app (CLAUDE.md).
 *
 * **No history.** `@codemirror/commands` is not a dependency of this package: the task text
 * requires CodeMirror's `history` extension to stay uninstalled, and the surest way to keep it
 * that way is to never import the package it lives in.
 */

const headingTag = Tag.define();
const emphasisTag = Tag.define();
const linkTag = Tag.define();
const codeTag = Tag.define();
const blockquoteTag = Tag.define();
const listMarkerTag = Tag.define();
const tableDelimiterTag = Tag.define();

/** The `essaydown-tok-*` class each of the 7 token tags resolves to; `source.css` colors them. */
export const TOKEN_CLASSES = {
  heading: "essaydown-tok-heading",
  emphasis: "essaydown-tok-emphasis",
  link: "essaydown-tok-link",
  code: "essaydown-tok-code",
  blockquote: "essaydown-tok-blockquote",
  listMarker: "essaydown-tok-list-marker",
  tableDelimiter: "essaydown-tok-table-delimiter",
} as const;

/**
 * The override layer described in the module comment. Node names, not tags, are the source of
 * truth: every markdown/GFM node that should read as one of the 7 categories is named here once.
 */
const tokenTags = styleTags({
  "ATXHeading1 SetextHeading1 ATXHeading2 SetextHeading2 ATXHeading3 ATXHeading4 ATXHeading5 ATXHeading6 HeaderMark":
    headingTag,
  "Emphasis StrongEmphasis EmphasisMark": emphasisTag,
  "Link Image LinkMark URL Autolink": linkTag,
  "InlineCode CodeText CodeMark CodeInfo FencedCode CodeBlock": codeTag,
  "Blockquote QuoteMark": blockquoteTag,
  ListMark: listMarkerTag,
  TableDelimiter: tableDelimiterTag,
});

export const tokenHighlightStyle = HighlightStyle.define([
  { tag: headingTag, class: TOKEN_CLASSES.heading },
  { tag: emphasisTag, class: TOKEN_CLASSES.emphasis },
  { tag: linkTag, class: TOKEN_CLASSES.link },
  { tag: codeTag, class: TOKEN_CLASSES.code },
  { tag: blockquoteTag, class: TOKEN_CLASSES.blockquote },
  { tag: listMarkerTag, class: TOKEN_CLASSES.listMarker },
  { tag: tableDelimiterTag, class: TOKEN_CLASSES.tableDelimiter },
]);

/** `lang-markdown` with GFM tables and autolinks, and the token-class override in place. */
export function sourceLanguage() {
  return markdown({
    base: markdownLanguage,
    extensions: [Table, Autolink, { props: [tokenTags] }],
  });
}

/** Everything an `EditorState` needs for the source view: the language, and its highlight theme. */
export function sourceExtensions(): Extension[] {
  return [sourceLanguage(), syntaxHighlighting(tokenHighlightStyle)];
}
