import { gfmAutolinkLiteralToMarkdown } from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import type { Delete, Html, Root, Yaml } from "mdast";
import remarkStringify, { type Options } from "remark-stringify";
import { unified, type Data, type Processor } from "unified";

type ToMarkdownExtensions = NonNullable<Data["toMarkdownExtensions"]>;
type Handlers = NonNullable<Options["handlers"]>;
type Handle = NonNullable<Handlers[keyof Handlers]>;
type ToMarkdownState = Parameters<Handle>[2];
type Info = Parameters<Handle>[3];
type Parents = Parameters<Handle>[1];

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

/**
 * The character classes CommonMark §6.2 flanking is decided by, as `micromark-util-classify-character`
 * decides them for the parser: whitespace is `\s` (space, tab, line endings, the Unicode spaces),
 * punctuation is `\p{P}` or `\p{S}`, everything else — letters, digits, marks — is "other". `code`
 * is a UTF-16 unit from `charCodeAt`, as the parser's own codes are; the `NaN` of an empty side
 * classifies as "other", which is what the built-in handlers get too, and is harmless because
 * `containerPhrasing` has nothing to encode on an empty side.
 */
function classifyCharacter(code: number): "whitespace" | "punctuation" | "other" {
  const character = String.fromCharCode(code);
  if (/\s/.test(character)) return "whitespace";
  if (/\p{P}|\p{S}/u.test(character)) return "punctuation";
  return "other";
}

/**
 * Whether to encode the character on either side of a `~~` delimiter run so that the run still
 * opens or closes when it is parsed back — the table of `mdast-util-to-markdown`'s
 * `lib/util/encode-info.js`, for the `*` column (GFM's `~` forms the way `*` does, not the stricter
 * `_`): letter outside and punctuation inside → the outside letter is encoded, because
 * `micromark-extension-gfm-strikethrough` can open a run only when what follows is not punctuation
 * or what precedes is (and close it only mirrored), so `x~~.~~` and `~~.~~x` are text; whitespace
 * inside → the inside whitespace is encoded (and the outside letter with it, as the built-ins
 * do), because a run beside whitespace never opens or closes; letter inside → nothing, the run
 * already forms against every neighbour. Punctuation is never encoded (it is what Markdown's own
 * constructs are made of), so punctuation outside beside punctuation inside stays as written: GFM
 * reads `.~~.~~.` as a strikethrough already.
 */
function encodeInfo(outside: number, inside: number): { inside: boolean; outside: boolean } {
  const outsideKind = classifyCharacter(outside);
  const insideKind = classifyCharacter(inside);
  if (outsideKind === "other") {
    if (insideKind === "other") return { inside: false, outside: false };
    if (insideKind === "whitespace") return { inside: true, outside: true };
    return { inside: false, outside: true };
  }
  if (outsideKind === "whitespace") {
    if (insideKind === "whitespace") return { inside: true, outside: true };
    return { inside: false, outside: false };
  }
  if (insideKind === "whitespace") return { inside: true, outside: false };
  return { inside: false, outside: false };
}

/** A code unit as the numeric character reference the built-in handlers write (`&#x62;`). */
function encodeCharacterReference(code: number): string {
  return `&#x${code.toString(16).toUpperCase()};`;
}

/**
 * The `delete` handler, replacing `mdast-util-gfm-strikethrough`'s `handleDelete` (task 1.40,
 * DECISIONS #review-1-r4 J1). The extension's handler writes `~~` … `~~` around its children with
 * none of the flanking logic the built-in `emphasis` and `strong` handlers have, so a run whose
 * edge character is punctuation directly beside unmarked alphanumeric text — `Alpha ~~beta.~~gamma`
 * after one deletion in the editor, or the parser's own tree of `~~a.~~&#x62;` — serialises to
 * delimiters GFM can neither open nor close, and the bytes parse back to no `delete` at all. This
 * handler mirrors `lib/handle/emphasis.js`'s shape for the `~` marker: after `containerPhrasing`
 * it classifies the first inner character against the last of `info.before` and the last inner
 * character against the first of `info.after` with {@link encodeInfo}, encodes an inside
 * whitespace character itself, and asks `containerPhrasing` to encode an outside letter through
 * `state.attentionEncodeSurroundingInfo`, exactly as the built-ins do. The tracker, the
 * `strikethrough` construct name and `peek` are the extension's, so its `unsafe` pattern and the
 * escaping of a literal `~` are unchanged for every other tree.
 *
 * Ownership: the serializer, not the editor's tree, owns delimiter validity against the neighbour
 * outside the mark. The editor's edge strip moves whitespace and breaks out of a mark; a mark whose
 * bytes cannot form against a letter is this handler's to encode, and the encoded neighbour is
 * what makes `format` a fixed point of `parse ∘ format` for that tree.
 */
export function handleDelete(
  node: Delete,
  _parent: Parents,
  state: ToMarkdownState,
  info: Info,
): string {
  const marker = "~";
  const exit = state.enter("strikethrough");
  const tracker = state.createTracker(info);
  const before = tracker.move(marker + marker);
  let between = tracker.move(
    state.containerPhrasing(node, { after: marker, before, ...tracker.current() }),
  );
  const betweenHead = between.charCodeAt(0);
  const open = encodeInfo(info.before.charCodeAt(info.before.length - 1), betweenHead);
  if (open.inside) between = encodeCharacterReference(betweenHead) + between.slice(1);
  const betweenTail = between.charCodeAt(between.length - 1);
  const close = encodeInfo(info.after.charCodeAt(0), betweenTail);
  if (close.inside) between = between.slice(0, -1) + encodeCharacterReference(betweenTail);
  const after = tracker.move(marker + marker);
  exit();
  state.attentionEncodeSurroundingInfo = { after: close.outside, before: open.outside };
  return before + between + after;
}
handleDelete.peek = function peekDelete(): string {
  return "~";
};

/**
 * The `mdast-util` serializers matching the parse-side extension set (PRD §4). The strikethrough
 * extension is taken for its `unsafe` pattern only: `mdast-util-to-markdown` merges `handlers`
 * with `Object.assign` in extension order (`lib/configure.js`), so the app's {@link handleDelete}
 * — registered here, after the extension — is the one that runs for every `delete` node.
 */
export function toMarkdownExtensions(): ToMarkdownExtensions {
  return [
    gfmTableToMarkdown(),
    gfmStrikethroughToMarkdown(),
    { handlers: { delete: handleDelete } },
    gfmAutolinkLiteralToMarkdown(),
  ];
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
