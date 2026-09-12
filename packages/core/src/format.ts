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

/** A `State` carrying the marker {@link installSurrogateWidening} leaves once it has run. */
type WidenedState = ToMarkdownState & { astralWidened?: true };

/**
 * A high surrogate written as a lone character reference (`&#xD83D;`, `D800`–`DBFF`) directly
 * followed by the raw low surrogate it was split from, and the mirror: a raw high surrogate
 * directly followed by its low surrogate's lone reference (`&#xDE00;`, `DC00`–`DFFF`). The
 * hexadecimal is upper-case with no padding, as `encode-character-reference.js` writes it.
 */
const SPLIT_PAIR = /&#x(D[89AB][0-9A-F]{2});([\uDC00-\uDFFF])|([\uD800-\uDBFF])&#x(D[C-F][0-9A-F]{2});/g;

/**
 * Widen every lone-surrogate character reference `value` holds at a child boundary to the
 * code-point reference of the pair it split: `&#xD83D;` + U+DE00 → `&#x1F600;`, and U+D83D +
 * `&#xDE00;` → `&#x1F600;`. These are the only two forms `container-phrasing.js`'s two rewrites
 * can produce — the first UTF-16 unit of the child after an attention run (`encodeAfter`) and the
 * last unit of the child before one (`encodingInfo.before`) — and nothing else in the serializer
 * writes a surrogate reference: `safe()` encodes only the ASCII characters its `unsafe` patterns
 * match, and the handlers' own inside encoding sees a letter (a lone surrogate classifies as
 * "other") at an astral edge and leaves it. The widening is by code point, computed from the two
 * units (`0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)`, the value `codePointAt` returns).
 */
function widenSplitSurrogateReferences(value: string): string {
  return value.replace(SPLIT_PAIR, (_match, highHex?: string, low?: string, high?: string, lowHex?: string) => {
    const highUnit = highHex !== undefined ? parseInt(highHex, 16) : (high as string).charCodeAt(0);
    const lowUnit = lowHex !== undefined ? parseInt(lowHex, 16) : (low as string).charCodeAt(0);
    const codePoint = 0x10000 + ((highUnit - 0xd800) << 10) + (lowUnit - 0xdc00);
    return encodeCharacterReference(codePoint);
  });
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
 * The app's `root` handler: installs {@link installSurrogateWidening} on the `State` it receives,
 * then does what `mdast-util-to-markdown/lib/handle/root.js` does — `containerPhrasing` when any
 * child is phrasing per {@link PHRASING_TYPES}, else `containerFlow`, both called as methods of
 * `state`.
 */
export function handleRoot(node: Root, _parent: Parents, state: ToMarkdownState, info: Info): string {
  installSurrogateWidening(state);
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
