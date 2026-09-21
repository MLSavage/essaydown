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
type ContainerPhrasing = ToMarkdownState["containerPhrasing"];

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
 * The node types `mdast-util-phrasing` (read in node_modules, `lib/index.js`) counts as phrasing
 * content, mirrored here because the package is not a direct dependency of `packages/core` and a
 * manifest line is a lockfile change: `break`, `delete`, `emphasis`, `footnote`,
 * `footnoteReference`, `image`, `imageReference`, `inlineCode`, `inlineMath`, `link`,
 * `linkReference`, `mdxJsxTextElement`, `mdxTextExpression`, `strong`, `text`, `textDirective`.
 * `html` is deliberately absent — upstream calls it ambiguous — so a root holding a block `html`
 * node goes through `containerFlow`, which is what keeps `raw-html.md` and the opaque-node tests
 * byte-identical.
 */
const PHRASING_TYPES: ReadonlySet<string> = new Set([
  "break",
  "delete",
  "emphasis",
  "footnote",
  "footnoteReference",
  "image",
  "imageReference",
  "inlineCode",
  "inlineMath",
  "link",
  "linkReference",
  "mdxJsxTextElement",
  "mdxTextExpression",
  "strong",
  "text",
  "textDirective",
]);

/**
 * A `State` carrying the markers {@link installSurrogateWidening} and {@link installAutolinkFallback}
 * leave once they have run.
 */
type WidenedState = ToMarkdownState & { astralWidened?: true; autolinkGuarded?: true };

/** A handler as `containerPhrasing` reads it: the `peek` it looks ahead with is optional. */
type PeekableHandle = Handle & { peek?: Handle };

/**
 * The three forms a surrogate pair split by `container-phrasing.js` can take, one per rewrite and
 * one for their join on a single child (the join is DECISIONS #review-1-r6 L1, task 1.49): a high
 * surrogate written as a lone character reference (`&#xD83D;`, `D800`–`DBFF`) directly followed
 * by the raw low surrogate it was split from (`encodeAfter` alone); a raw high surrogate directly
 * followed by its low surrogate's lone reference (`&#xDE00;`, `DC00`–`DFFF`; `encodingInfo.before`
 * alone); and a high-surrogate reference directly followed by a low-surrogate reference
 * (`&#xD83D;&#xDE00;`; both rewrites on one two-unit child). The hexadecimal is upper-case with
 * no padding, as `encode-character-reference.js` writes it.
 */
const SPLIT_PAIR = new RegExp(
  [
    // `encodeAfter` alone: the high unit's reference, the raw low unit.
    "&#x(D[89AB][0-9A-F]{2});([\\uDC00-\\uDFFF])",
    // `encodingInfo.before` alone: the raw high unit, the low unit's reference.
    "([\\uD800-\\uDBFF])&#x(D[C-F][0-9A-F]{2});",
    // Both on one child: the high unit's reference, the low unit's reference.
    "&#x(D[89AB][0-9A-F]{2});&#x(D[C-F][0-9A-F]{2});",
  ].join("|"),
  "g",
);

/**
 * Widen every lone-surrogate character reference `value` holds at a child boundary to the
 * code-point reference of the pair it split: `&#xD83D;` + U+DE00 → `&#x1F600;`, U+D83D +
 * `&#xDE00;` → `&#x1F600;`, and `&#xD83D;&#xDE00;` → `&#x1F600;`. These are the three forms
 * `container-phrasing.js`'s two rewrites can produce, read in the installed package (2.1.2): the
 * first UTF-16 unit of the child after an attention run (`encodeAfter`, applied to `value` right
 * after the child's handler returns) and the last unit of the child before one
 * (`encodingInfo.before`, applied to the previous result once the run's handler has set
 * `attentionEncodeSurroundingInfo`) — and, when one two-unit child sits between two runs whose
 * inner edges both ask for their neighbour to be encoded, both rewrites on that one child: the
 * first fires on its high unit, the second on its low unit, and the raw mate each of the first two
 * forms relies on is a reference too. Nothing else in the serializer writes a surrogate reference:
 * `safe()` encodes only the ASCII characters its `unsafe` patterns match, and the handlers' own
 * inside encoding sees a letter (a lone surrogate classifies as "other") at an astral edge and
 * leaves it. The widening is by code point, computed from the two units
 * (`0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)`, the value `codePointAt` returns), the
 * same arithmetic for all three forms.
 */
function widenSplitSurrogateReferences(value: string): string {
  return value.replace(
    SPLIT_PAIR,
    (
      _match,
      highHex?: string,
      low?: string,
      high?: string,
      lowHex?: string,
      bothHighHex?: string,
      bothLowHex?: string,
    ) => {
      const highUnit =
        bothHighHex !== undefined
          ? parseInt(bothHighHex, 16)
          : highHex !== undefined
            ? parseInt(highHex, 16)
            : (high as string).charCodeAt(0);
      const lowUnit =
        bothLowHex !== undefined
          ? parseInt(bothLowHex, 16)
          : lowHex !== undefined
            ? parseInt(lowHex, 16)
            : (low as string).charCodeAt(0);
      const codePoint = 0x10000 + ((highUnit - 0xd800) << 10) + (lowUnit - 0xdc00);
      return encodeCharacterReference(codePoint);
    },
  );
}

/**
 * Wrap `state.containerPhrasing` once per serialization so that the neighbour of an attention run
 * the built-in assembler decided to encode is written as a whole scalar (DECISIONS #review-1-r5
 * K1). `mdast-util-to-markdown/lib/util/container-phrasing.js` rewrites a child's output after
 * its handler returned at exactly two places — the first UTF-16 unit of the child after a run and
 * the last unit of the child before it — with `encodeCharacterReference(unit.charCodeAt(0))`, so
 * an astral (non-BMP) neighbour of `*`, `**` or `~~` whose inner edge is punctuation or
 * whitespace came out as a lone-surrogate reference (`x ~~a.~~&#xD83D;` + U+DE00) that reparses
 * to U+FFFD. The decision to encode is right and is not changed here: the parser classifies one
 * UTF-16 unit as well (`micromark-util-classify-character`; a lone surrogate is "other"), so a raw
 * astral neighbour never lets the run form while the code-point reference does. This is the
 * app-owned half of the encoding: the handlers and {@link encodeInfo} decide which side to encode,
 * in the parser's own code-unit terms; the app writes what they decided as a whole scalar.
 *
 * `state` is created per serialization, so this patches nothing that outlives the call; it is
 * installed on the first dispatched node — always `root` — because that is the first moment a
 * `State` is in reach (the shape positions.ts's `patchIndentLines` uses), and the marker on the
 * state makes a second install a no-op. The wrapper calls the original bound to `state`, as the
 * handlers do (`containerPhrasingBound` reads `this`).
 */
function installSurrogateWidening(state: WidenedState): void {
  if (state.astralWidened) return;
  state.astralWidened = true;
  const original = state.containerPhrasing;
  const containerPhrasing: ContainerPhrasing = (parent, info) =>
    widenSplitSurrogateReferences(original.call(state, parent, info));
  state.containerPhrasing = containerPhrasing;
}

/**
 * Whether the autolink form `value` — `<` … `>` — carries `url` byte for byte: the bytes between
 * the angle brackets are the url, or the url with the `mailto:` the parser prefixes to an email
 * autolink (CommonMark §6.4) — the two spellings `format-link-as-autolink.js:27` accepts as "the
 * text is the destination". `value` is a non-autolink form (it does not start with `<`) when the
 * built-in already chose the resource form; that is never a fallback case.
 */
function autolinkCarriesUrl(value: string, url: string): boolean {
  if (!value.startsWith("<")) return true;
  const between = value.slice(1, -1);
  return between === url || `mailto:${between}` === url;
}

/**
 * Wrap the configured `link` handler once per serialization so that a link is written in the
 * `<…>` autolink form exactly when that form round-trips the url byte for byte, and in the
 * resource form `[text](url)` otherwise (DECISIONS #review-1-r6 L2). Nothing inside `<…>` can be
 * escaped — CommonMark §6.4 reads the bytes literally — and `mdast-util-to-markdown`'s autolink
 * branch (`lib/handle/link.js:28-45`) hides the construct stack (`state.stack = []`) so that no
 * `unsafe` pattern with an `inConstruct` applies, yet the text child still goes through `safe()`,
 * whose backslash rule (`lib/util/safe.js:147`, "typical escapes are handled in `safe`") doubles
 * a backslash before ASCII punctuation, the closing `>` included. So `https://x.y\` was written
 * `<https://x.y\\>`, whose parse holds two backslashes, and every `parse ∘ format` doubled again.
 * The criterion is the round trip itself, never a hand list of characters: the wrapper calls the
 * original; when the result is the autolink form and {@link autolinkCarriesUrl} says no, it calls
 * the original again with `state.options.resourceLink` — the one option `formatLinkAsAutolink`
 * reads — set to `true` for that call only and restored in a `finally`, so the resource form is
 * written for that node and for no other. Backslash escapes work in a label and in a link
 * destination, so `[https://x.y\\](https://x.y\\)` parses back to the original url — the form the
 * built-in already falls back to when the text and the url differ (`www.x.y\`).
 *
 * `peek` answers `[` when the fallback will be taken and the original's `peek` (`<`) otherwise,
 * because `containerPhrasing` classifies the previous sibling's `after` by it; both `<` and `[`
 * are punctuation, so the sibling's escaping is the same either way, and the answer is exact.
 *
 * Installed in the shape of {@link installSurrogateWidening}: from the app `root` handler on the
 * `State` it receives, once per `State` (the marker), the original reached through
 * `state.handlers.link` — `mdast-util-to-markdown` is not a direct dependency of `packages/core`,
 * so the built-in is never imported — and called bound to `state`, as `zwitch` calls it. Both
 * `state.handle` and `containerPhrasing`'s look-ahead read `state.handlers` at dispatch time, so
 * the wrapper is what runs for every `link` node of the serialization; `formatWithMap` inherits it
 * because its instrumented `link` is what `state.handlers.link` holds when the root runs.
 */
function installAutolinkFallback(state: WidenedState): void {
  if (state.autolinkGuarded) return;
  state.autolinkGuarded = true;
  const original = state.handlers.link as PeekableHandle;
  // The built-in `link` carries `peek` (`lib/handle/link.js:10`) and positions.ts's `wrapHandle`
  // copies it onto the instrumented handler, so the handler found here always has one.
  const originalPeek = original.peek as Handle;
  const asResourceLink: Handle = (node, parent, _state, info) => {
    const previous = state.options.resourceLink;
    state.options.resourceLink = true;
    try {
      return original.call(state, node, parent, state, info);
    } finally {
      state.options.resourceLink = previous;
    }
  };
  const link: PeekableHandle = (node, parent, _state, info) => {
    const value = original.call(state, node, parent, state, info);
    return autolinkCarriesUrl(value, node.url) ? value : asResourceLink(node, parent, state, info);
  };
  link.peek = (node, parent, _state, info) => {
    const value = original.call(state, node, parent, state, info);
    if (!autolinkCarriesUrl(value, node.url)) return "[";
    return originalPeek.call(state, node, parent, state, info);
  };
  state.handlers.link = link;
}

/**
 * The app's `root` handler: installs {@link installSurrogateWidening} and
 * {@link installAutolinkFallback} on the `State` it receives, then does what
 * `mdast-util-to-markdown/lib/handle/root.js` does — `containerPhrasing` when any child is
 * phrasing per {@link PHRASING_TYPES}, else `containerFlow`, both called as methods of `state`.
 */
export function handleRoot(node: Root, _parent: Parents, state: ToMarkdownState, info: Info): string {
  installSurrogateWidening(state);
  installAutolinkFallback(state);
  const hasPhrasing = node.children.some((child) => PHRASING_TYPES.has(child.type));
  return hasPhrasing ? state.containerPhrasing(node, info) : state.containerFlow(node, info);
}

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
      extensions.push(...toMarkdownExtensions(), { handlers: opaqueHandlers() }, { handlers: { root: handleRoot } });
    }) as Processor<undefined, undefined, undefined, Root, string>;
}

/** Serialize an mdast root in the canonical style of docs/MARKDOWN-STYLE.md. */
export function format(root: Root): string {
  return createFormatter().stringify(root);
}
