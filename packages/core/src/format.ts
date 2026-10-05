import {
  gfmAutolinkLiteralFromMarkdown,
  gfmAutolinkLiteralToMarkdown,
} from "mdast-util-gfm-autolink-literal";
import { gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import type {
  Delete,
  Emphasis,
  Html,
  Link,
  Nodes,
  Paragraph,
  Parents as TreeParents,
  PhrasingContent,
  Root,
  Strong,
  Text,
  Yaml,
} from "mdast";
import remarkStringify, { type Options } from "remark-stringify";
import { unified, type Data, type Processor } from "unified";

import { parse } from "./parse.js";

type ToMarkdownExtensions = NonNullable<Data["toMarkdownExtensions"]>;
type Handlers = NonNullable<Options["handlers"]>;
type Handle = NonNullable<Handlers[keyof Handlers]>;
type ToMarkdownState = Parameters<Handle>[2];
type Info = Parameters<Handle>[3];
type Parents = Parameters<Handle>[1];
type ContainerPhrasing = ToMarkdownState["containerPhrasing"];
type StateHandle = ToMarkdownState["handle"];
type HandledNode = Parameters<StateHandle>[0];

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
 * Whether to encode the character on either side of a `~~`, `*` or `_` delimiter run so that the
 * run still opens or closes when it is parsed back — the table of `mdast-util-to-markdown`'s
 * `lib/util/encode-info.js`, branch for branch, with `marker` selecting the same column that file
 * does. For `*` and for GFM's `~` (which forms the way `*` does): letter outside and punctuation
 * inside → the outside letter is encoded, because `micromark-extension-gfm-strikethrough` can open
 * a run only when what follows is not punctuation or what precedes is (and close it only
 * mirrored), so `x~~.~~` and `~~.~~x` are text; whitespace inside → the inside whitespace is
 * encoded (and the outside letter with it, as the built-ins do), because a run beside whitespace
 * never opens or closes; letter inside → nothing, the run already forms against every neighbour.
 * `_` is the one stricter column (`encode-info.js:51`, `marker === '_'`): CommonMark §6.2 forbids
 * intraword `_`, so a letter on both sides encodes *both* of them, where `*` needs neither.
 * Punctuation is never encoded (it is what Markdown's own constructs are made of), so punctuation
 * outside beside punctuation inside stays as written: GFM reads `.~~.~~.` as a strikethrough
 * already, and CommonMark reads `.*.*.` as emphasis.
 */
function encodeInfo(
  outside: number,
  inside: number,
  marker: "*" | "_" | "~",
): { inside: boolean; outside: boolean } {
  const outsideKind = classifyCharacter(outside);
  const insideKind = classifyCharacter(inside);
  if (outsideKind === "other") {
    if (insideKind === "other") {
      return marker === "_" ? { inside: true, outside: true } : { inside: false, outside: false };
    }
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
  const open = encodeInfo(info.before.charCodeAt(info.before.length - 1), betweenHead, marker);
  if (open.inside) between = encodeCharacterReference(betweenHead) + between.slice(1);
  const betweenTail = between.charCodeAt(between.length - 1);
  const close = encodeInfo(info.after.charCodeAt(0), betweenTail, marker);
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
 * The parent every phrasing handler is dispatched with. `mdast-util-to-markdown` types a handler's
 * second argument `Parents | undefined` for the one node that has no parent — `root`, which
 * {@link handleRoot} answers — so a handler for a phrasing node is always called with a parent, as
 * `containerPhrasing` shows (`util/container-phrasing.js:82`, the parent it was given). The type
 * cannot be narrowed on the handler itself (`Handlers` is a record of `Handle`, whose parameters
 * TypeScript checks contravariantly), so the `undefined` case is a guard in
 * {@link opensBesideAttentionRun} rather than a signature.
 */

/** The two node types whose bytes end in the `*` or `_` of a delimiter run. */
const ATTENTION_TYPES: ReadonlySet<string> = new Set(["emphasis", "strong"]);

/**
 * Whether the delimiter run this node is about to open would be written flush against the closing
 * delimiter run of an adjacent sibling of the same marker — the one condition
 * {@link handleEmphasis} and {@link handleStrong} take the other marker on.
 *
 * Both halves are needed and neither alone is the rule. The **bytes** half (`before` ends in `*`)
 * is not enough: the character before a run is also `*` when the run is the first child of its own
 * `emphasis` or `strong` parent, where `***a***` is one nesting and not two runs. The **tree**
 * half (the previous sibling is an attention node) is not enough either: in
 * `emphasis + strong + emphasis` the middle run has already taken `_`, so the third run's
 * neighbour is `_` and `*` is the marker that does not collide. Read together they name exactly
 * the adjacency: the previous sibling wrote a run, and what it wrote ends in the marker this run
 * would open with.
 *
 * `parent` is `undefined` only for `root` (see {@link DefinedParent}), which is not an attention
 * node's parent; the guard is there because `mdast-util-to-markdown` types it so, and
 * `packages/core/test/adjacent-attention.test.ts` is where that branch is exercised.
 */
export function opensBesideAttentionRun(node: Nodes, parent: Parents, before: string): boolean {
  if (before.charAt(before.length - 1) !== "*") return false;
  const siblings: readonly Nodes[] = parent === undefined ? [] : (parent.children as Nodes[]);
  const previous = siblings[siblings.indexOf(node) - 1];
  return previous !== undefined && ATTENTION_TYPES.has(previous.type);
}

/**
 * The `emphasis` and `strong` handlers, replacing the built-ins of
 * `mdast-util-to-markdown/lib/handle/emphasis.js` and `lib/handle/strong.js` (DECISIONS
 * #review-1-r9 O1). The built-ins choose their marker from `state.options` alone
 * (`util/check-emphasis.js:10`, `util/check-strong.js:10`) and encode only the neighbours *outside*
 * the run (`handle/emphasis.js:33-48`, `handle/strong.js:33-48`, through
 * `util/encode-info.js`), never a neighbour that is itself the delimiter of an adjacent run. Two
 * flanking runs of different marks made adjacent by one keystroke — Backspace joining `*(b)*` and
 * `**z**`, or Delete of the single space in `*(b)* **z**` — therefore serialised as `*(b)***z**`,
 * one `***` delimiter run that CommonMark reads as neither run's, so the bytes parse back to
 * `text("*(b)*") + strong("z")`, and Copy Markdown put them on the clipboard.
 *
 * The rule, stated once: **a run opens with `_` (`__` for strong) when the character already
 * written before it is the `*` it would otherwise open with, and with `*` otherwise** — so the
 * neighbouring run's closing delimiter and this run's opening delimiter are never one run. The
 * alternative marker is legal at exactly the positions the rule fires at: the character before is
 * `*`, which CommonMark §6.2 classifies as punctuation, and an `_` run preceded by punctuation is
 * left-flanking-and-openable whatever follows it, while the stricter cells `_` has against letters
 * are the ones {@link encodeInfo}'s `marker === "_"` column encodes, exactly as the built-ins do
 * for `_` (the parser's own rule, read in `encode-info.js`, never assumed here). The rule is a
 * function of the tree and of the bytes already written for its neighbours, so it makes the same
 * choice on the second pass: `format` stays a fixed point of `parse ∘ format`.
 *
 * Ownership of a zero-width run: a run with no children writes its two delimiters with nothing
 * between them and is decided by the same rule — `info.before`'s last character — because the
 * character before the opening delimiter is all the rule reads; `between` is `""`, whose
 * `charCodeAt` is `NaN`, the "other" class, which is the built-ins' own reading of an empty inside
 * and encodes nothing. Such a node is not reachable from the editor (an empty mark is dropped) and
 * is reached here only from a hand-built tree.
 *
 * `_` is stricter than `*` against letters, and that strictness is the built-ins' own and is kept:
 * {@link encodeInfo}'s `marker === "_"` column encodes a letter on both sides of a run, so
 * `emphasis("(b)") + strong("z") + text("w")` is written `*(b)*__&#x7A;__&#x77;` — CommonMark
 * forbids intraword `_`, and a run whose neighbour is its own content's letter forms only once
 * one of the two is a reference. Every side read here is non-empty: `containerFlow` hands a block
 * `before: "\n"` and `after: "\n"` and `handle/paragraph.js:16` passes them through, so the
 * `NaN` an empty side would give `charCodeAt` never reaches {@link classifyCharacter} for these
 * two handlers (asserted by the whole suite: a `throw` on an empty side is never taken).
 *
 * Everything else is the built-in's body mirrored: the `emphasis` / `strong` construct name for
 * `state.enter`, the tracker, `containerPhrasing` with the single-character `after`, the two
 * {@link encodeInfo} calls, `state.attentionEncodeSurroundingInfo` for the neighbours outside, and
 * `peek`. `peek` answers `*` always: `containerPhrasing` calls it with `before: ''`
 * (`util/container-phrasing.js:50-54`), so it cannot know which marker this run will take, and it
 * does not need to — `*` and `_` are both punctuation, so the previous sibling classifies its own
 * closing neighbour identically either way, and `_` in text is escaped unconditionally
 * (`unsafe.js:133`), so no text byte depends on the answer.
 */
function handleAttention(
  node: Emphasis | Strong,
  parent: Parents,
  state: ToMarkdownState,
  info: Info,
  construct: "emphasis" | "strong",
  width: 1 | 2,
): string {
  const beforeCode = info.before.charCodeAt(info.before.length - 1);
  const marker = opensBesideAttentionRun(node, parent, info.before) ? "_" : "*";
  const run = marker.repeat(width);
  const exit = state.enter(construct);
  const tracker = state.createTracker(info);
  const before = tracker.move(run);
  let between = tracker.move(
    state.containerPhrasing(node, { after: marker, before, ...tracker.current() }),
  );
  const betweenHead = between.charCodeAt(0);
  const open = encodeInfo(beforeCode, betweenHead, marker);
  if (open.inside) between = encodeCharacterReference(betweenHead) + between.slice(1);
  const betweenTail = between.charCodeAt(between.length - 1);
  const close = encodeInfo(info.after.charCodeAt(0), betweenTail, marker);
  if (close.inside) between = between.slice(0, -1) + encodeCharacterReference(betweenTail);
  const after = tracker.move(run);
  exit();
  state.attentionEncodeSurroundingInfo = { after: close.outside, before: open.outside };
  return before + between + after;
}

/** The `emphasis` handler of {@link handleAttention}: one marker character. */
export function handleEmphasis(
  node: Emphasis,
  parent: Parents,
  state: ToMarkdownState,
  info: Info,
): string {
  return handleAttention(node, parent, state, info, "emphasis", 1);
}
handleEmphasis.peek = function peekEmphasis(): string {
  return "*";
};

/** The `strong` handler of {@link handleAttention}: the marker character twice. */
export function handleStrong(
  node: Strong,
  parent: Parents,
  state: ToMarkdownState,
  info: Info,
): string {
  return handleAttention(node, parent, state, info, "strong", 2);
}
handleStrong.peek = function peekStrong(): string {
  return "*";
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
 * leave once they have run, and the give-up log the first of them installs
 * ({@link wideningGiveUps}). All three live on the `State`, which `mdast-util-to-markdown` creates
 * per `toMarkdown` call, so nothing here is module-level state (PRD §9).
 */
type WidenedState = ToMarkdownState & {
  astralWidened?: true;
  autolinkGuarded?: true;
  literalSpans?: Map<Text, LiteralSpan[]>;
  wideningGiveUps?: RecordedGiveUp[];
  childOrigins?: ChildOrigins;
  deleteStandIns?: DeleteMerge["standIns"];
};

/**
 * One place {@link widenSplitSurrogateReferences} did less than a full pass over one parent's
 * join, as the walk itself sees it — the walk's own give-up paths, made visible instead of silent
 * (DECISIONS #review-1-r8 N3).
 *
 * - `"unlocatable-child"`: {@link locateChild} found none of {@link emissionForms}' forms at the
 *   cursor, so the walk stopped and children `index`…n were left as the parent wrote them.
 * - `"overlapping-edit"`: {@link applyEdits} dropped an edit that overlaps one already taken and
 *   is not the duplicate that the two anchors of one slice produce by construction, so that
 *   edit's bytes were not written.
 *
 * `index` is the child's index in its parent's `children` — `containerPhrasing` dispatches them in
 * order, one per index — and `type` is its node type.
 */
export interface WideningGiveUp {
  reason: "unlocatable-child" | "overlapping-edit";
  index: number;
  type: string;
}

/** A {@link WideningGiveUp} with the parent whose join it happened in, as the `State` logs it. */
export interface RecordedGiveUp extends WideningGiveUp {
  parent: Nodes;
}

/** How {@link widenSplitSurrogateReferences} hands a give-up back to its caller. */
export type GiveUpRecorder = (giveUp: WideningGiveUp) => void;

/**
 * The give-ups {@link installSurrogateWidening} recorded on `state` during this `toMarkdown` call,
 * in the order the walks hit them. Empty for every tree whose children the walk could locate;
 * {@link formatWithMap} turns each entry into an `unresolved` path, which is the instrument that
 * guards the branch (see {@link widenSplitSurrogateReferences}).
 */
export function wideningGiveUps(state: ToMarkdownState): readonly RecordedGiveUp[] {
  const widened = state as WidenedState;
  const origins = widened.childOrigins;
  return (widened.wideningGiveUps ?? []).map((giveUp) => {
    const origin = origins?.get(giveUp.parent as TreeParents)?.[giveUp.index];
    return origin === undefined
      ? giveUp
      : { ...giveUp, parent: origin.parent, index: origin.index };
  });
}

/** A handler as `containerPhrasing` reads it: the `peek` it looks ahead with is optional. */
type PeekableHandle = Handle & { peek?: Handle };

/**
 * The three forms a surrogate pair split at a child boundary can take, as the two anchored
 * patterns this file applies them with (the join of the first two on one child is DECISIONS
 * #review-1-r6 L1, task 1.49): a high surrogate written as a lone character reference
 * (`&#xD83D;`, `D800`–`DBFF`) directly followed by the raw low surrogate it was split from; a raw
 * high surrogate directly followed by its low surrogate's lone reference (`&#xDE00;`,
 * `DC00`–`DFFF`); and a high-surrogate reference directly followed by a low-surrogate reference
 * (`&#xD83D;&#xDE00;`, both rewrites on one two-unit child). The hexadecimal is upper-case with
 * no padding, as `encode-character-reference.js` writes it.
 *
 * Neither pattern is global, and neither is ever run over a whole string: each is applied at one
 * position {@link widenSplitSurrogateReferences} derives from one child's own slice of the join —
 * the positions the assembler's two encodings and the mark handlers' inner-edge encodings touch,
 * and nowhere else (DECISIONS #review-1-r7 M1; the third form is pure ASCII, so over the join it
 * rewrote a code span's own literal bytes). `head` is sticky (`y`) and matches only the two forms
 * that begin with a reference, starting exactly at `lastIndex`; `tail` is `$`-anchored against
 * the join truncated at a slice's end and matches only the two forms that end with one. A slice
 * whose whole content is one pair matches both, and the second edit is dropped as overlapping.
 */
const SPLIT_PAIR = {
  /** `&#xD83D;` + the raw low unit, or `&#xD83D;&#xDE00;`, starting exactly at `lastIndex`. */
  head: /&#x(D[89AB][0-9A-F]{2});(?:([\uDC00-\uDFFF])|&#x(D[C-F][0-9A-F]{2});)/y,
  /** The raw high unit + `&#xDE00;`, or `&#xD83D;&#xDE00;`, ending at the searched string's end. */
  tail: /(?:([\uD800-\uDBFF])|&#x(D[89AB][0-9A-F]{2});)&#x(D[C-F][0-9A-F]{2});$/,
};

/** The trailing line ending `container-phrasing.js:71` replaces by one space before an `html` sibling. */
const TRAILING_LINE_ENDING = /(\r?\n|\r)$/;

/** The one character `container-phrasing.js:71` writes in a trailing line ending's place. */
const SPACE = " ";

/**
 * Whether a line ending written before this `html` sibling still reads as a paragraph continuation
 * — the criterion the whole of {@link repairBreakBeforeHtml} and {@link repairLineEndingBeforeHtml}
 * turn on, and the round trip itself rather than a hand list of tag names (lesson [1.10.r6d]).
 *
 * `lineEnded` is what precedes the html on the probe's first line: for a `break`, what its handler
 * returned (`\\` + a line ending, `mdast-util-to-markdown/lib/handle/break.js`); for a `text`
 * child, its trailing line ending alone, because whether a line opens an html block is decided by
 * that line's start and nothing before it. `htmlValue` is what the `html` handler returned (the
 * bytes the parser captured, {@link opaqueHandlers}). The probe puts the pair between text on both
 * sides — `x` before, ` y` after, so the line the html starts is not also the paragraph's last —
 * and asks the app's own parser: one block, a paragraph, holding a `break` (or a `text` ending in a
 * line ending, as `type` says) whose next sibling is an `html`. An inline tag (`<i>`, `<span>`,
 * `<b>`) is CommonMark §4.6 condition 7, which cannot interrupt a paragraph, so the pair survives
 * and the answer is `true`; a value that can open an html block — conditions 1–6, `<div>`,
 * `<!-- c -->`, `<script>`, `<?x?>`, `<!DOCTYPE x>`, `<![CDATA[x]]>` — ends the paragraph at the
 * line ending instead, so the probe holds two blocks (or a paragraph with no such pair) and the
 * answer is `false`.
 *
 * `parse` is imported from `./parse.js`, which imports nothing from this file, so there is no
 * cycle; the probe runs only for a child whose next sibling is `html` and whose emission the
 * assembler actually rewrote, which no fixture reaches more than three times.
 */
function lineEndingSurvivesBeforeHtml(
  lineEnded: string,
  htmlValue: string,
  type: "break" | "text",
): boolean {
  const root = parse(`x${lineEnded}${htmlValue} y\n`);
  if (root.children.length !== 1) return false;
  const block = root.children[0];
  if (block.type !== "paragraph") return false;
  const { children } = block;
  return children.some(
    (child, index) =>
      child.type === type &&
      (child.type !== "text" || TRAILING_LINE_ENDING.test(child.value)) &&
      children[index + 1]?.type === "html",
  );
}

/**
 * The bytes a `break` child gets in the join when `container-phrasing.js` lines 60–80 rewrote its
 * trailing line ending to one space before an `html` sibling (DECISIONS #review-1-r7 M2).
 *
 * That branch replaces the *previous result's* trailing line ending whatever node wrote it, so the
 * `break` handler's `\\` + line ending became `\\` + a space — a literal backslash the user never
 * wrote, rendered as text, with the break itself gone from the reparse (invariant B fails on the
 * parser's own tree). Two answers replace it, chosen by {@link lineEndingSurvivesBeforeHtml}:
 *
 * - the break's own output, the line ending kept, exactly when the pair reparses to a `break`
 *   directly followed by an `html` — the inline-tag case, where the assembler's worry (html read
 *   as flow) does not arise because CommonMark §4.6 condition 7 cannot interrupt a paragraph;
 * - one space and no backslash otherwise — the block-capable values of conditions 1–6, where
 *   keeping the line ending really would turn the next line into an html block. The break is lost
 *   there, as it was before, but it is lost as a word space rather than as a stray backslash: a
 *   documented loss on the docs/V1.1-BACKLOG.md line `[#030 product, a soft or hard break before
 *   inline html]`.
 *
 * The `html` child's own bytes are never touched either way.
 */
function repairBreakBeforeHtml(breakOutput: string, htmlValue: string): string {
  return lineEndingSurvivesBeforeHtml(breakOutput, htmlValue, "break") ? breakOutput : SPACE;
}

/**
 * The byte a `text` child's last position gets in the join when `container-phrasing.js` lines
 * 60–80 rewrote its trailing line ending to one space before an `html` sibling (task 3.15;
 * docs/V1.1-BACKLOG.md `[#030 product, a soft or hard break before inline html]`).
 *
 * The assembler's rewrite is safe and over-broad: it changes a text value (`alpha\n<i>beta</i>`
 * written `alpha <i>beta</i>`) for every html sibling, where only the values of CommonMark §4.6
 * conditions 1–6 can interrupt a paragraph. The app pre-empts it: `lineEnding` — the value's own
 * trailing line ending — is written back exactly when {@link lineEndingSurvivesBeforeHtml} says the
 * html on the next line is still read as a continuation (condition 7, an inline tag), and the
 * space is kept otherwise — the recorded behaviour for a block-capable value, where the line
 * ending would open an html block. The `html` child's own bytes are never touched either way.
 */
function repairLineEndingBeforeHtml(lineEnding: string, htmlValue: string): string {
  return lineEndingSurvivesBeforeHtml(lineEnding, htmlValue, "text") ? lineEnding : SPACE;
}

/** The marker a mark handler writes on each side of its `containerPhrasing` result, by node type.
 * The lengths are {@link stringifyOptions}' (`emphasis: "*"`, `strong: "*"` doubled) and the
 * strikethrough extension's `~~`, read from the type and never from the bytes: `***a***` is a
 * `strong` holding an `emphasis`, so the first character of a slice says nothing about its marker.
 */
const MARK_MARKER_LENGTH: ReadonlyMap<string, number> = new Map([
  ["emphasis", 1],
  ["strong", 2],
  ["delete", 2],
]);

/** The code point two surrogate units spell — the value `codePointAt` returns for the pair. */
function widenedPair(high: number, low: number): string {
  return encodeCharacterReference(0x10000 + ((high - 0xd800) << 10) + (low - 0xdc00));
}

/** `value` with its first UTF-16 unit as a reference, as `container-phrasing.js:91-93` writes it. */
function encodeFirstUnit(value: string): string {
  return encodeCharacterReference(value.charCodeAt(0)) + value.slice(1);
}

/** `value` with its last UTF-16 unit as a reference, as `container-phrasing.js:109-111` writes it. */
function encodeLastUnit(value: string): string {
  return value.slice(0, -1) + encodeCharacterReference(value.charCodeAt(value.length - 1));
}

/** One direct child of a phrasing parent and the bytes its handler returned for it. */
export interface RecordedChild {
  node: HandledNode;
  value: string;
}

/** One form a child's emission can take in the join, and which of its edges the parent encoded. */
interface EmissionForm {
  text: string;
  headEncoded: boolean;
  tailEncoded: boolean;
  /** Whether this form is the one region 4 wrote: the trailing line ending replaced by one space. */
  eolAsSpace: boolean;
  /** The line ending region 4 replaced when `eolAsSpace`, and `""` otherwise. */
  lineEnding: string;
}

/** Where one child's emission sits in the join — the half-open slice `[start, end)` — and its edges. */
interface LocatedChild {
  start: number;
  end: number;
  headEncoded: boolean;
  tailEncoded: boolean;
  /** Whether the form found at that slice is region 4's: the line ending written as one space. */
  eolAsSpace: boolean;
  /** The line ending region 4 replaced there when `eolAsSpace`, and `""` otherwise. */
  lineEnding: string;
}

/**
 * One replacement to make in the join: the half-open slice `[start, end)` and its new bytes,
 * together with the child whose own slice it was derived from (`index` and `type`), so that an
 * edit {@link applyEdits} drops can name that child in a {@link WideningGiveUp}.
 */
export interface Edit {
  start: number;
  end: number;
  replacement: string;
  index: number;
  type: string;
}

/**
 * The forms a child's emission can take in the string `containerPhrasing` returns, in the order
 * they are tried. The enumeration is derived from the four regions of
 * `mdast-util-to-markdown/lib/util/container-phrasing.js` (2.1.2, read in `node_modules`) — the
 * same branches `rewrittenEmissions` in positions.ts enumerates, one UTF-16 unit at a time,
 * because that is the unit the assembler encodes:
 *
 * 1. Lines 43–55, the look-ahead: the *next* sibling's handler (or its `peek`) is called only to
 *    classify one character, and is dispatched off `state.handle.handlers` rather than through
 *    `state.handle`. It writes nothing into the join and is never recorded.
 * 2. Lines 88–94, `encodeAfter`: the first UTF-16 unit of the child after an attention run is
 *    replaced by its character reference when that run asked for its neighbour — the head form.
 * 3. Lines 100–115, `encodingInfo.before`: the last unit of the *previous* result is replaced the
 *    same way when the current child's handler asks — the tail form. It runs after region 3 has
 *    already rewritten that result, so the both form is the head form with its last unit encoded,
 *    which for a one-unit value encodes the `;` the head form ends with (`&#x61&#x3B;`).
 * 4. Lines 60–80, the line ending before `html`: when the next child is `html` and this child's
 *    string ends in a line ending, that ending is replaced by one space (line 71). It can combine
 *    with region 2 (a child after a run *and* before html); it cannot combine with region 3,
 *    whose form ends in a reference, nor with itself.
 *
 * Only a `text` child is reached by regions 2 and 3: every other handler's output begins and ends
 * with punctuation — a marker, a bracket, a fence, a tag — and `encode-info.js` never encodes
 * punctuation. So a non-text child has its plain output and, when the next child is `html`, the
 * line-ending form region 4 rewrites it into; the only non-text child whose output ends in a line
 * ending is a `break`, and the form's `eolAsSpace` flag is how the walk knows region 4 fired on it
 * ({@link repairBreakBeforeHtml}, DECISIONS #review-1-r7 M2) — on a `text` child too, where the
 * form's `lineEnding` is what region 4 took away ({@link repairLineEndingBeforeHtml}, task 3.15).
 */
function emissionForms(
  node: HandledNode,
  value: string,
  beforeHtml: boolean,
): readonly EmissionForm[] {
  const forms: EmissionForm[] = [];
  const add = (
    text: string,
    headEncoded: boolean,
    tailEncoded: boolean,
    eolAsSpace: boolean,
    lineEnding = "",
  ): void => {
    const existing = forms.find((form) => form.text === text);
    if (existing) {
      // The head and tail forms of a one-unit value are the same bytes; the walk cannot tell
      // which region wrote them, so both anchors are tried and each fires only on a real pair.
      existing.headEncoded ||= headEncoded;
      existing.tailEncoded ||= tailEncoded;
      existing.eolAsSpace ||= eolAsSpace;
      return;
    }
    forms.push({ text, headEncoded, tailEncoded, eolAsSpace, lineEnding });
  };
  add(value, false, false, false);
  if (node.type === "text" && value.length > 0) {
    const head = encodeFirstUnit(value);
    add(head, true, false, false);
    add(encodeLastUnit(value), false, true, false);
    add(encodeLastUnit(head), true, true, false);
  }
  if (!beforeHtml) return forms;
  for (const form of [...forms]) {
    const lineEnding = TRAILING_LINE_ENDING.exec(form.text);
    if (lineEnding === null) continue;
    add(
      form.text.replace(TRAILING_LINE_ENDING, SPACE),
      form.headEncoded,
      form.tailEncoded,
      true,
      lineEnding[0],
    );
  }
  return forms;
}

/**
 * Locate `value`'s child at `cursor` in `joined`. Children are joined flush
 * (`container-phrasing.js:124`), so a child starts exactly at the cursor and the only question is
 * which of {@link emissionForms}' forms the parent left there; the plain output is tried first.
 * `undefined` is the answer for a child whose bytes are none of them — a form this enumeration
 * does not know — and the caller then leaves the rest of the join alone.
 */
function locateChild(
  joined: string,
  cursor: number,
  node: HandledNode,
  value: string,
  beforeHtml: boolean,
): LocatedChild | undefined {
  for (const form of emissionForms(node, value, beforeHtml)) {
    if (!joined.startsWith(form.text, cursor)) continue;
    return {
      start: cursor,
      end: cursor + form.text.length,
      headEncoded: form.headEncoded,
      tailEncoded: form.tailEncoded,
      eolAsSpace: form.eolAsSpace,
      lineEnding: form.lineEnding,
    };
  }
  return undefined;
}

/** The edit {@link SPLIT_PAIR}.head makes when a split pair starts exactly at `at`, if one does. */
function headEdit(joined: string, at: number, index: number, type: string): Edit | undefined {
  SPLIT_PAIR.head.lastIndex = at;
  const match = SPLIT_PAIR.head.exec(joined);
  if (!match) return undefined;
  const low = match[2] === undefined ? parseInt(match[3], 16) : match[2].charCodeAt(0);
  return {
    start: at,
    end: at + match[0].length,
    replacement: widenedPair(parseInt(match[1], 16), low),
    index,
    type,
  };
}

/** The edit {@link SPLIT_PAIR}.tail makes when a split pair ends exactly at `at`, if one does. */
function tailEdit(joined: string, at: number, index: number, type: string): Edit | undefined {
  const match = SPLIT_PAIR.tail.exec(joined.slice(0, at));
  if (!match) return undefined;
  const high = match[1] === undefined ? parseInt(match[2], 16) : match[1].charCodeAt(0);
  return {
    start: match.index,
    end: at,
    replacement: widenedPair(high, parseInt(match[3], 16)),
    index,
    type,
  };
}

/**
 * `joined` with `edits` applied in order; an edit overlapping one already taken is dropped.
 *
 * **Which overlaps happen (DECISIONS #review-1-r8 N3, clause 4).** Two edits do overlap by
 * construction, and exactly one way: a slice whose whole content is one split pair matches both
 * {@link SPLIT_PAIR} anchors, so {@link headEdit} and {@link tailEdit} return the same
 * `[start, end)` with the same replacement (`&#xD83D;&#xDE00;` → `&#x1F600;`, the third form of
 * {@link SPLIT_PAIR}'s doc comment). That duplicate is the enumeration working as designed — the
 * bytes written are the same whichever of the two is taken — so it is dropped silently. Every
 * other overlap means two different rewrites claimed one stretch of the join and one of them was
 * not written, which is the quiet give-up this file no longer takes: it is handed to `record` and
 * surfaces as an `unresolved` path. No walk of a parseable tree has produced one — the head and
 * tail anchors of a child longer than one pair land on disjoint slices, and the edits of two
 * children lie inside their own disjoint slices — so the branch is reached only by calling this
 * function directly, which is why it is exported and guarded there
 * ("two edits that overlap on different bytes are recorded", format-widening-giveup.test.ts).
 */
export function applyEdits(joined: string, edits: readonly Edit[], record: GiveUpRecorder): string {
  if (edits.length === 0) return joined;
  let out = "";
  let at = 0;
  let taken: Edit = NO_EDIT;
  for (const edit of [...edits].sort((left, right) => left.start - right.start)) {
    if (edit.start < at) {
      if (!duplicates(edit, taken))
        record({ reason: "overlapping-edit", index: edit.index, type: edit.type });
      continue;
    }
    out += joined.slice(at, edit.start) + edit.replacement;
    at = edit.end;
    taken = edit;
  }
  return out + joined.slice(at);
}

/**
 * The value `taken` holds before the first edit is written. An edit's `start` is an offset of the
 * join and so is never negative, and `at` starts at 0, so no edit is ever compared against this
 * one: the first edit reached always has `start >= at` and is taken.
 */
const NO_EDIT: Edit = { start: -1, end: -1, replacement: "", index: -1, type: "" };

/** Whether `edit` writes exactly what `taken` already wrote, over exactly the same slice. */
function duplicates(edit: Edit, taken: Edit): boolean {
  return (
    edit.start === taken.start && edit.end === taken.end && edit.replacement === taken.replacement
  );
}

/**
 * The app's per-child pass over the string `containerPhrasing` returned: one walk, two kinds of
 * edit, each made only at a position where a rewrite of the assembler's can have fired.
 *
 * **The widening (DECISIONS #review-1-r5 K1, #review-1-r7 M1).** Every lone-surrogate character
 * reference written at a child boundary becomes the code-point reference of the pair it split:
 * `&#xD83D;` + U+DE00 → `&#x1F600;`, U+D83D + `&#xDE00;` → `&#x1F600;`, and `&#xD83D;&#xDE00;` →
 * `&#x1F600;`. Those lone references reparse to U+FFFD, so the whole scalar is the app-owned half
 * of the encoding the handlers and {@link encodeInfo} decide; the widening is by code point, the
 * same arithmetic for all three forms ({@link widenedPair}).
 *
 * **The hard break before inline html (DECISIONS #review-1-r7 M2).** A `break` child located at
 * region 4's form — its trailing line ending written as one space, `\\ ` — is replaced by what
 * {@link repairBreakBeforeHtml} decides from the round trip: the break's own output with the line
 * ending kept, or one space with no backslash. The assembler wrote a literal backslash there and
 * lost the break.
 *
 * **The soft line break before inline html (task 3.15; DECISIONS #030 Decision 1, its backlog line
 * `[#030 product, a soft or hard break before inline html]`).** A `text` child located at region
 * 4's form — its trailing line ending written as one space, so `alpha\n<i>beta</i>` came out
 * `alpha <i>beta</i>` — gets one edit over its own slice's last byte, that space, which
 * {@link repairLineEndingBeforeHtml} decides: the value's own line ending back when the html
 * cannot open an html block (CommonMark §4.6 condition 7), the space kept when it can (conditions
 * 1–6). The space is the slice's last byte because region 4 rewrites only a form that ended in the
 * line ending; the edit is disjoint from the widening's, whose tail anchor needs a form ending in a
 * reference and whose head anchor a pair at the slice's start.
 *
 * All three are per child and positional, never over the join. `children` is what this parent's
 * handlers emitted, in order, as recorded by {@link installSurrogateWidening}; the join is walked
 * with a cursor and each child's slice located by {@link locateChild}. The widening's positions:
 *
 * - a `text` child whose first unit the assembler encoded: {@link SPLIT_PAIR}.head anchored at the
 *   slice's start; whose last unit it encoded: {@link SPLIT_PAIR}.tail anchored at its end;
 * - an `emphasis`, `strong` or `delete` child: head right after its opening marker and tail right
 *   before its closing marker ({@link MARK_MARKER_LENGTH}), the two places
 *   `mdast-util-to-markdown/lib/handle/emphasis.js:39-48`, `strong.js` and this file's
 *   {@link handleDelete} encode their own `containerPhrasing` result.
 *
 * Nothing else in the join is touched — the `html` child's own bytes least of all — so the literal
 * bytes `&#xD83D;&#xDE00;` inside a verbatim leaf — a code span, an inline `html` node, either of them in a table cell, inside a mark or
 * inside a link's text — are left exactly as the parser read them (PRD §6.1).
 *
 * **The contract at a child the walk cannot locate (DECISIONS #review-1-r8 N3).** The walk stops
 * at the first child whose bytes are none of {@link emissionForms}' forms: the edits derived from
 * children before it are applied, children from it on are left exactly as the parent wrote them —
 * never widened blind — the join is otherwise returned unchanged, and the give-up is handed to
 * `record` as an `unlocatable-child` {@link WideningGiveUp}. That record is the guard on this
 * branch: {@link installSurrogateWidening} logs it on the `State`, {@link formatWithMap} reports
 * every entry of the log as an `unresolved` path, and the corpus case "maps every node of the
 * tree, and nothing is unresolved" is therefore red for any fixture in
 * `fixtures/markdown/index.json` whose walk gives up, in either leg — `parse(fixture)` and
 * `parse(format(parse(fixture)))`. The instrument is what says so, and nothing else does: the
 * child lookup positions.ts uses to place a node is a *different, more permissive* enumeration —
 * it searches forward with `indexOf` from the cursor rather than requiring `startsWith` at it, and
 * offers a non-text child its raw handler value alone rather than the head-, tail- and
 * eol-as-space forms this walk carries — so it can succeed on a join this walk gives up on, and a
 * guard read off it would be green while this walk did nothing.
 */
export function widenSplitSurrogateReferences(
  joined: string,
  children: readonly RecordedChild[],
  record: GiveUpRecorder,
): string {
  const edits: Edit[] = [];
  let cursor = 0;
  for (let index = 0; index < children.length; index += 1) {
    const { node, value } = children[index];
    const next = children[index + 1];
    const located = locateChild(joined, cursor, node, value, next?.node.type === "html");
    if (located === undefined) {
      record({ reason: "unlocatable-child", index, type: node.type });
      break;
    }
    const { start, end, headEncoded, tailEncoded, eolAsSpace, lineEnding } = located;
    if (node.type === "break" && eolAsSpace && next !== undefined) {
      edits.push({
        start,
        end,
        replacement: repairBreakBeforeHtml(value, next.value),
        index,
        type: node.type,
      });
    }
    // Region 4's form of a `text` child is its plain or head form with the trailing line ending as
    // the slice's last byte, one space; the tail forms end in a reference, never a line ending, so
    // this one-byte edit at `end - 1` is disjoint from the tail edit, which needs `tailEncoded`.
    if (node.type === "text" && eolAsSpace && next !== undefined) {
      edits.push({
        start: end - 1,
        end,
        replacement: repairLineEndingBeforeHtml(lineEnding, next.value),
        index,
        type: node.type,
      });
    }
    const markerLength = MARK_MARKER_LENGTH.get(node.type);
    const head =
      node.type === "text"
        ? headEncoded
          ? start
          : undefined
        : markerLength === undefined
          ? undefined
          : start + markerLength;
    const tail =
      node.type === "text"
        ? tailEncoded
          ? end
          : undefined
        : markerLength === undefined
          ? undefined
          : end - markerLength;
    if (head !== undefined) {
      const edit = headEdit(joined, head, index, node.type);
      if (edit) edits.push(edit);
    }
    if (tail !== undefined) {
      const edit = tailEdit(joined, tail, index, node.type);
      if (edit) edits.push(edit);
    }
    cursor = end;
  }
  return applyEdits(joined, edits, record);
}

/**
 * Wrap `state.containerPhrasing` once per serialization so that a surrogate pair split at a child
 * boundary is written as one scalar (DECISIONS #review-1-r5 K1), at that child's own positions and
 * at no others (DECISIONS #review-1-r7 M1).
 *
 * `mdast-util-to-markdown/lib/util/container-phrasing.js` (2.1.2) has four regions that decide
 * what reaches the join, and the wrapper is built from them: the look-ahead that classifies the
 * next sibling by dispatching off `state.handle.handlers` (lines 43–55), the replacement of the
 * previous result's trailing line ending by a space before an `html` child (lines 60–80),
 * `encodeAfter` on the current value's first UTF-16 unit (lines 88–94) and `encodingInfo.before`
 * on the previous result's last unit (lines 100–115). Regions 3 and 4 are why an astral neighbour
 * of `*`, `**` or `~~` came out as a lone-surrogate reference (`x ~~a.~~&#xD83D;` + U+DE00); the
 * decision to encode is right and is not changed here, because the parser classifies one UTF-16
 * unit as well (`micromark-util-classify-character`; a lone surrogate is "other"), so a raw astral
 * neighbour never lets the run form while the code-point reference does.
 *
 * The per-child rule: during the original call, `state.handle` is replaced by a recorder that
 * calls the original and pushes `{ node, value }` for every child whose `parent` argument is this
 * parent — a nested `containerPhrasing` call installs its own recorder and its children are its
 * own — with the zwitch's own properties (`handlers`, `invalid`, `unknown`) copied onto the
 * recorder by `Object.assign`, so region 1's look-ahead still resolves, and the original restored
 * in a `finally`. {@link widenSplitSurrogateReferences} then walks the join against those
 * recordings and edits at their own slices only — the surrogate widening at their edges, region
 * 4's `\\ ` at a `break`'s slice — so no byte of a verbatim leaf is ever rewritten.
 *
 * `state` is created per serialization, so this patches nothing that outlives the call; it is
 * installed on the first dispatched node — always `root` — because that is the first moment a
 * `State` is in reach (the shape positions.ts's `patchIndentLines` uses), and the marker on the
 * state makes a second install a no-op. The wrapper calls the original bound to `state`, as the
 * handlers do (`containerPhrasingBound` reads `this`).
 *
 * The give-up log lives on the same `State` and for the same reason (DECISIONS #review-1-r8 N3):
 * every walk this call makes hands back what it could not do, tagged with the `parent` whose join
 * it was walking, and {@link wideningGiveUps} is how a caller that wants to know — today
 * {@link formatWithMap} — reads it afterwards. `format` reads it not at all and its bytes are
 * unchanged: the walk still stops, and nothing is widened blind.
 */
function installSurrogateWidening(state: WidenedState): void {
  if (state.astralWidened) return;
  state.astralWidened = true;
  const giveUps: RecordedGiveUp[] = [];
  state.wideningGiveUps = giveUps;
  const originalContainerPhrasing = state.containerPhrasing;
  const containerPhrasing: ContainerPhrasing = (parent, info) => {
    const children: RecordedChild[] = [];
    const originalHandle = state.handle;
    const recorder: StateHandle = (node, handleParent, handleState, handleInfo) => {
      const value = originalHandle.call(state, node, handleParent, handleState, handleInfo);
      if (handleParent === parent) children.push({ node, value });
      return value;
    };
    Object.assign(recorder, originalHandle);
    state.handle = recorder;
    let joined: string;
    try {
      joined = originalContainerPhrasing.call(state, parent, info);
    } finally {
      state.handle = originalHandle;
    }
    return widenSplitSurrogateReferences(joined, children, (giveUp) => {
      giveUps.push({ ...giveUp, parent });
    });
  };
  state.containerPhrasing = containerPhrasing;
}

/**
 * One stretch of a `text` value that the parser reads as a GFM autolink literal: the half-open
 * UTF-16 offsets `[start, end)` of the value and the url the parser gives the link it makes.
 */
export interface LiteralSpan {
  start: number;
  end: number;
  url: string;
}

/**
 * The constructs inside which the installed extension makes no literal: its own `notInConstruct`
 * (`mdast-util-gfm-autolink-literal` 2.0.1, `lib/index.js`, `['autolink', 'link', 'image',
 * 'label']`) — the same set its `transformGfmAutolinkLiterals` skips as `ignore: ['link',
 * 'linkReference']`, since a reference's text is written inside `label`.
 */
const LITERAL_FREE_CONSTRUCTS: ReadonlySet<string> = new Set(["autolink", "link", "image", "label"]);

/**
 * The GFM autolink literals the parser makes of one `text` value, in order (task 3.14). The rule
 * is never restated here: the value is handed, as the one text child of a paragraph, to the
 * installed extension's own `transformGfmAutolinkLiterals` (reached through
 * `gfmAutolinkLiteralFromMarkdown().transforms`, the function `parse` runs over every tree), and
 * each `link` it splits out is one span. Its `previous` rule reads the character before a match
 * in the value, so a match at offset 0 is taken whatever precedes the node — which is the parser's
 * reading too, because the parser's text node starts there as well.
 *
 * Partition: the spans are disjoint and in order; the stretches between them, before the first and
 * after the last are plain text, and a value with no literal has no span.
 */
export function literalSpans(value: string): LiteralSpan[] {
  const paragraph: Paragraph = { type: "paragraph", children: [{ type: "text", value }] };
  const tree: Root = { type: "root", children: [paragraph] };
  for (const transform of gfmAutolinkLiteralFromMarkdown().transforms ?? []) transform(tree);
  const spans: LiteralSpan[] = [];
  let at = 0;
  for (const child of paragraph.children as PhrasingContent[]) {
    const width = child.type === "link" ? textOf(child).length : (child as Text).value.length;
    if (child.type === "link") spans.push({ start: at, end: at + width, url: child.url });
    at += width;
  }
  return spans;
}

/** Every `text` value under `node`, joined in document order. */
function textOf(node: Nodes): string {
  if (node.type === "text") return node.value;
  return "children" in node ? (node.children as Nodes[]).map(textOf).join("") : "";
}

/**
 * Which literals a serialization writes escaped rather than raw (task 3.14): every one (`"all"`),
 * or the literal links and the `text` nodes in the set — the nodes {@link settleLiterals} found the
 * parser would misread raw. Every other literal is written raw.
 */
export type LiteralEscapes = "all" | ReadonlySet<Nodes>;

/**
 * The one option {@link createFormatter} adds to `remark-stringify`'s: `toMarkdown` keeps every
 * option it is given on `state.options`, so the handlers read the escapes from the `State` of
 * their own serialization and nothing is module-level (PRD §9).
 */
type LiteralOptions = Options & { literalEscapes?: LiteralEscapes };

/**
 * Whether `node`, a `text` node or a literal link written now, has its literals written raw: it
 * is not escaped by this serialization's {@link LiteralEscapes}, and the parser reads the bytes as
 * phrasing in which a literal can be made — inside `phrasing` (a paragraph's, a heading's or a
 * cell's) and outside every construct of {@link LITERAL_FREE_CONSTRUCTS}. The built-in `<…>`
 * branch of `link` empties the stack (`lib/handle/link.js:28-45`), so its text is never written
 * raw: that branch keeps its own escaping and the {@link installAutolinkFallback} check.
 */
function writesLiteralsRaw(state: ToMarkdownState, node: Nodes): boolean {
  const escaped = (state.options as LiteralOptions).literalEscapes;
  if (escaped === "all" || escaped?.has(node) === true) return false;
  return (
    state.stack.includes("phrasing") &&
    !state.stack.some((construct) => LITERAL_FREE_CONSTRUCTS.has(construct))
  );
}

/**
 * The app's `text` handler (task 3.14): the built-in's `state.safe(node.value, info)`
 * (`lib/handle/text.js`) for every stretch of the value except the GFM autolink literals the
 * parser will make of it ({@link literalSpans}), which are written as the writer's own bytes.
 * Inside a literal no escape is ever read — the tokenizer takes the bytes as the url, and the
 * transform runs on the decoded value, so `https\://x.y/a\_b` was re-linked with the escapes'
 * meaning gone from neither — so an escape there is a byte the writer never typed. Each plain
 * stretch is passed to `safe` with its real neighbours: the literal's edge character where one
 * touches it, `info`'s otherwise.
 *
 * The spans written raw are recorded on the `State` per node ({@link writtenLiteralSpans}), last
 * call wins — `containerPhrasing` calls a peek-less handler twice — so the position map reads
 * which units were written as themselves instead of guessing it from the bytes.
 */
export function handleText(node: Text, _parent: Parents, state: ToMarkdownState, info: Info): string {
  const spans = writesLiteralsRaw(state, node) ? literalSpans(node.value) : [];
  const widened = state as WidenedState;
  if (spans.length === 0) {
    widened.literalSpans?.delete(node);
    return state.safe(node.value, info);
  }
  (widened.literalSpans ??= new Map()).set(node, spans);
  const { value } = node;
  const plain = (start: number, end: number): string =>
    start === end
      ? ""
      : state.safe(value.slice(start, end), {
          ...info,
          before: start === 0 ? info.before : value.charAt(start - 1),
          after: end === value.length ? info.after : value.charAt(end),
        });
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += plain(at, span.start) + value.slice(span.start, span.end);
    at = span.end;
  }
  return out + plain(at, value.length);
}

/**
 * The literal spans {@link handleText} wrote raw during this `toMarkdown` call, per `text` node —
 * the instrument {@link formatWithMap} reads so that a unit inside one is spelled by itself and
 * never as the escape a backslash before it would otherwise look like.
 */
export function writtenLiteralSpans(state: ToMarkdownState): ReadonlyMap<Text, readonly LiteralSpan[]> {
  return (state as WidenedState).literalSpans ?? new Map();
}

/**
 * Whether `link` is written bare, as the GFM autolink literal the writer wrote (task 3.14): the
 * parser marked it a literal (`data.autolinkLiteral`, see `parse`), it has no title, its one child
 * is a `text` node, and that text, as a whole, is exactly the one literal the parser makes of it
 * with this link's url ({@link literalSpans}) — so the text an edit changed (`https://a.bx` under a
 * link to `https://a.b`) is never written bare. A link that fails any clause is written by the
 * built-in and {@link installAutolinkFallback} as before: `<…>` when that form carries the url,
 * the resource form otherwise.
 */
export function writesBare(link: Link): boolean {
  if (link.data?.autolinkLiteral !== true || link.title != null) return false;
  const [only] = link.children;
  if (link.children.length !== 1 || only.type !== "text") return false;
  const spans = literalSpans(only.value);
  return (
    spans.length === 1 &&
    spans[0].start === 0 &&
    spans[0].end === only.value.length &&
    spans[0].url === link.url
  );
}

/** One link as {@link literalMisread} compares it: url, title, text, and whether it is a literal. */
type LinkSignature = string;

function signature(url: string, title: string | null | undefined, text: string, bare: boolean): LinkSignature {
  return JSON.stringify([url, title ?? null, text, bare]);
}

/** One link `parse` is expected to make of a serialization, and the node of the tree it comes from. */
interface ExpectedLink {
  signature: LinkSignature;
  node: Nodes;
  /** Whether the node wrote this link's bytes raw — a literal link bare, or a text span. */
  raw: boolean;
}

/**
 * The links `parse` will make of `root` serialised with `escaped` ({@link LiteralEscapes}): each
 * link of the tree — a literal exactly when it is written bare, {@link writesBare} and not escaped
 * — and, in document order beside them, one literal per {@link literalSpans} span of every `text`
 * node outside a link or a link reference. A span is a literal whether its text is written raw or
 * escaped, because the transform `literalSpans` runs is the parser's own and reads the decoded
 * value. `undefined` when nothing is written raw, so a tree without a literal pays for no parse.
 */
function expectedLinks(root: Root, escaped: ReadonlySet<Nodes>): ExpectedLink[] | undefined {
  const out: ExpectedLink[] = [];
  const walk = (node: Nodes, linked: boolean): void => {
    if (node.type === "link") {
      const bare = !escaped.has(node) && writesBare(node);
      out.push({ signature: signature(node.url, node.title, textOf(node), bare), node, raw: bare });
    }
    if (node.type === "text" && !linked) {
      for (const span of literalSpans(node.value)) {
        const text = node.value.slice(span.start, span.end);
        out.push({ signature: signature(span.url, null, text, true), node, raw: !escaped.has(node) });
      }
    }
    const inside = linked || node.type === "link" || node.type === "linkReference";
    if ("children" in node) for (const child of node.children as Nodes[]) walk(child, inside);
  };
  walk(root, false);
  return out.some((link) => link.raw) ? out : undefined;
}

/** The links of a parsed tree, a literal marked as one. */
function parsedLinks(root: Root): LinkSignature[] {
  const out: LinkSignature[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === "link") {
      out.push(signature(node.url, node.title, textOf(node), node.data?.autolinkLiteral === true));
    }
    if ("children" in node) for (const child of node.children as Nodes[]) walk(child);
  };
  walk(root);
  return out;
}

/**
 * Whether `text` — `root` serialised with `escaped` — parses to exactly the links
 * {@link expectedLinks} names, in order (task 3.14), and if not, which node to escape next. A
 * literal written raw is read by the parser's tokenizer on the bytes around it, which no
 * one-character `before`/`after` can decide — a letter typed flush against a literal link's edge
 * in the rendered view (`Xhttps://a.b`, `https://a.bX`), a raw literal followed by `*b*` with no
 * space, a cell's `|` inside one — so the check is the parser itself, never a list of neighbours.
 *
 * Returns `null` when the links hold; else the first raw node at the first disagreement — the
 * expected link there, or the one before it, which is the literal that swallowed it — for
 * {@link settleLiterals} to escape; else `"all"`, when neither was written raw.
 */
export function literalMisread(root: Root, text: string, escaped: ReadonlySet<Nodes>): Nodes | null | "all" {
  const expected = expectedLinks(root, escaped);
  if (expected === undefined) return null;
  const parsed = parsedLinks(parse(text));
  let at = 0;
  while (at < expected.length && at < parsed.length && parsed[at] === expected[at].signature) at += 1;
  if (at === expected.length && at === parsed.length) return null;
  for (const candidate of [expected[at], expected[at - 1]]) {
    if (candidate?.raw === true) return candidate.node;
  }
  return "all";
}

/**
 * Serialise `root` with every literal raw that the parser reads back (task 3.14): `run` is called
 * with no escapes, and while {@link literalMisread} names a node, again with that node escaped as
 * well — one node per round, so one literal flush against a letter costs that literal its bare
 * form and no other literal of the document anything. A misread no escape can fix falls back to
 * every literal escaped: the form every link and text had before task 3.14. Terminates: each
 * round escapes one more node of a finite tree. {@link format} and `formatWithMap` both settle
 * through this, so the map is always built for the very bytes `format` returns.
 */
export function settleLiterals<T>(
  root: Root,
  run: (escaped: LiteralEscapes) => T,
  textOf: (result: T) => string,
): T {
  const escaped = new Set<Nodes>();
  for (;;) {
    const result = run(escaped);
    const misread = literalMisread(root, textOf(result), escaped);
    if (misread === null) return result;
    if (misread === "all" || escaped.has(misread)) return run("all");
    escaped.add(misread);
  }
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
  // A literal written bare is its text child and nothing else, so it is serialised as that child
  // alone: `containerPhrasing` dispatches the child (the position map places it, and the link
  // takes its hull), and {@link handleText} writes the literal raw because the construct stack is
  // the parent's, `phrasing` on it.
  const bare = (node: Link): boolean => writesLiteralsRaw(state, node) && writesBare(node);
  const link: PeekableHandle = (node, parent, _state, info) => {
    if (bare(node)) return state.containerPhrasing(node, info);
    const value = original.call(state, node, parent, state, info);
    return autolinkCarriesUrl(value, node.url) ? value : asResourceLink(node, parent, state, info);
  };
  link.peek = (node, parent, _state, info) => {
    if (bare(node)) return textOf(node).charAt(0);
    const value = original.call(state, node, parent, state, info);
    if (!autolinkCarriesUrl(value, node.url)) return "[";
    return originalPeek.call(state, node, parent, state, info);
  };
  state.handlers.link = link;
}

/** Where one child of a stand-in {@link mergeAdjacentDeletes} made sat in the tree it was given. */
interface ChildOrigin {
  parent: TreeParents;
  index: number;
}

/** For each stand-in and merged `delete` {@link mergeAdjacentDeletes} made, each child's origin. */
export type ChildOrigins = Map<TreeParents, ChildOrigin[]>;

/** What {@link mergeAdjacentDeletes} learns about one tree. */
export interface DeleteMerge {
  /**
   * For each given parent with two adjacent `delete` children, the stand-in its children are
   * serialised from: the parent's own fields and its children with each adjacent run merged.
   */
  standIns: Map<TreeParents, TreeParents>;
  origins: ChildOrigins;
}

/**
 * Merge every run of adjacent `delete` siblings under `parent`, at any depth, into one `delete`
 * whose children are the run's children in order (DECISIONS #review-1-r6 L11's `~~` twin,
 * `[1.67, found outside scope]`; tasks 3.13, 3.18). Returns `parent`'s stand-in, or `parent` itself
 * when its own children hold no adjacent pair.
 *
 * Why a merge and not a separating handler, as {@link handleEmphasis} and {@link handleStrong}
 * have: GFM strikethrough has one marker, and the installed tokenizer
 * (`micromark-extension-gfm-strikethrough` 2.1.0, `lib/syntax.js`, `more`: a `~` after two
 * consumed is `nok`; `start`: a `~` directly after a `~` that is not a character escape is `nok`)
 * reads any run of more than two tildes as text. Two `delete` runs written flush are `~~~~`
 * between their contents whatever their contents are — encoding the second run's first character
 * (`~~a.~~~~&#x62;~~`) still parses as one `delete` holding `a.~~~~b` — so the only bytes that keep
 * them two nodes put a node between them (`<!---->`, a character), which changes the tree just as
 * a merge does and adds text the writer never wrote. Two adjacent runs of one mark render as one
 * run, and the editor already holds them so (ProseMirror joins adjacent text with equal marks), so
 * the merge is the tree the bytes can carry: `parse(format(T))` is `T` with each such run merged,
 * and `format` is a fixed point of `parse ∘ format` for it. `emphasis` and `strong` are not merged:
 * they have a second marker, and task 1.67's handlers keep two runs two nodes.
 *
 * Copy on write, and no ancestor is rebuilt: a stand-in is made only for a parent whose own
 * children hold a pair, and it is never put in its parent's children — {@link handleRoot} has
 * `containerPhrasing` serialise a parent from its stand-in — so every given node except the
 * merged-away `delete` siblings is dispatched as itself, and the position map places it by its own
 * output (task 3.18; a rebuilt spine left every ancestor of a merge to the hull of its descendants,
 * its markers outside its range). A merged-away sibling is never dispatched and takes the hull of
 * its dispatched descendants. Every tree `parse` produces (`parse` never yields two adjacent
 * `delete` nodes) gets no stand-in at all. `origins` learns, for each stand-in and merged `delete`,
 * where each of its children sat in the given tree, so {@link wideningGiveUps} can name a give-up
 * by the given tree's parent and index (DECISIONS #review-1-r8 N3): a merged `delete`'s children
 * come from several given parents.
 */
export function mergeAdjacentDeletes(parent: TreeParents, merge: DeleteMerge): TreeParents {
  const given: readonly Nodes[] = parent.children;
  const children: Nodes[] = [];
  const childOrigins: ChildOrigin[] = [];
  let merged = false;
  const originOf = (node: TreeParents, index: number): ChildOrigin =>
    merge.origins.get(node)?.[index] ?? { parent: node, index };
  given.forEach((child, index) => {
    const previous = children[children.length - 1];
    if (child.type === "delete" && previous?.type === "delete") {
      const joined: Delete = {
        type: "delete",
        children: [...previous.children, ...child.children],
      };
      merge.origins.set(joined, [
        ...previous.children.map((_, at) => originOf(previous, at)),
        ...child.children.map((_, at) => originOf(child, at)),
      ]);
      children[children.length - 1] = joined;
      merged = true;
      return;
    }
    children.push(child);
    childOrigins.push(originOf(parent, index));
  });
  // After the list is final, so a merged run's joined children are merged in their turn.
  for (const child of children) if ("children" in child) mergeAdjacentDeletes(child, merge);
  if (!merged) return parent;
  const standIn = { ...parent, children } as TreeParents;
  merge.standIns.set(parent, standIn);
  merge.origins.set(standIn, childOrigins);
  return standIn;
}

/**
 * The app's `root` handler: installs {@link installSurrogateWidening} and
 * {@link installAutolinkFallback} on the `State` it receives, merges adjacent `delete` siblings
 * ({@link mergeAdjacentDeletes}, the origins kept on the `State` for {@link wideningGiveUps}) before
 * any other handler runs, wraps `state.containerPhrasing` once per `State` — outside the surrogate
 * widening, so a give-up is recorded at the stand-in its walk saw — to serialise a parent from the
 * stand-in kept on the `State`, then
 * does what `mdast-util-to-markdown/lib/handle/root.js` does — `containerPhrasing` when any child
 * is phrasing per {@link PHRASING_TYPES}, else `containerFlow`, both called as methods of `state`.
 */
export function handleRoot(
  node: Root,
  _parent: Parents,
  state: ToMarkdownState,
  info: Info,
): string {
  installSurrogateWidening(state);
  installAutolinkFallback(state);
  const merge: DeleteMerge = { standIns: new Map(), origins: new Map() };
  mergeAdjacentDeletes(node, merge);
  const widenedState = state as WidenedState;
  widenedState.childOrigins = merge.origins;
  if (widenedState.deleteStandIns === undefined) {
    const widened = state.containerPhrasing;
    state.containerPhrasing = (parent, phrasingInfo) =>
      widened.call(
        state,
        widenedState.deleteStandIns?.get(parent as TreeParents) ?? parent,
        phrasingInfo,
      );
  }
  widenedState.deleteStandIns = merge.standIns;
  const hasPhrasing = node.children.some((child) => PHRASING_TYPES.has(child.type));
  return hasPhrasing ? state.containerPhrasing(node, info) : state.containerFlow(node, info);
}

/**
 * The `mdast-util` serializers matching the parse-side extension set (PRD §4). The strikethrough
 * extension is taken for its `unsafe` pattern only: `mdast-util-to-markdown` merges `handlers`
 * with `Object.assign` in extension order (`lib/configure.js`), so the app's {@link handleDelete}
 * — registered here, after the extension — is the one that runs for every `delete` node. The last
 * entry replaces two *built-in* handlers the same way: the built-ins are the base `Object.assign`
 * starts from (`lib/handle/index.js`), so {@link handleEmphasis} and {@link handleStrong},
 * registered after every extension, are the handlers that run for every `emphasis` and `strong`
 * node.
 */
export function toMarkdownExtensions(): ToMarkdownExtensions {
  return [
    gfmTableToMarkdown(),
    gfmStrikethroughToMarkdown(),
    { handlers: { delete: handleDelete } },
    gfmAutolinkLiteralToMarkdown(),
    { handlers: { emphasis: handleEmphasis, strong: handleStrong, text: handleText } },
  ];
}

/**
 * A formatter configured for docs/MARKDOWN-STYLE.md. Built per call, for the same reason as
 * `createParser`: `packages/core` keeps no module-level configuration (PRD §9).
 *
 * `escaped` (task 3.14): every GFM autolink literal outside it is written as the writer's bytes —
 * a marked literal link bare ({@link writesBare}) and a literal inside text unescaped
 * ({@link handleText}); one inside it is written as before, a link as `<…>` or the resource form
 * and text through `safe`. {@link format} picks the set with {@link settleLiterals}.
 */
export function createFormatter(
  escaped: LiteralEscapes = new Set(),
): Processor<undefined, undefined, undefined, Root, string> {
  const options: LiteralOptions = { ...stringifyOptions(), literalEscapes: escaped };
  return unified()
    .use(remarkStringify, options)
    .use(function attachOpaqueAndGfm(this: Processor) {
      const data = this.data();
      const extensions: ToMarkdownExtensions = (data.toMarkdownExtensions ??= []);
      extensions.push(
        ...toMarkdownExtensions(),
        { handlers: opaqueHandlers() },
        { handlers: { root: handleRoot } },
      );
    }) as Processor<undefined, undefined, undefined, Root, string>;
}

/**
 * Serialize an mdast root in the canonical style of docs/MARKDOWN-STYLE.md, every GFM autolink
 * literal the parser reads back written as the writer's bytes ({@link settleLiterals}).
 */
export function format(root: Root): string {
  return settleLiterals(
    root,
    (escaped) => createFormatter(escaped).stringify(root),
    (text) => text,
  );
}
