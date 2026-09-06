import type { Break, Html, Image, Nodes, Paragraph, PhrasingContent, Root } from "mdast";
import { blocksOf, normalizedText } from "./blocks.js";
import { contentHash } from "./hash.js";
import { parse } from "./parse.js";

/**
 * The abbreviations PRD §6.1 names as non-splitting. Exported because the rule-based fallback
 * segmenter (`core/segment-fallback.ts`, task 0.9) must use the same list rather than a second one.
 */
export const ABBREVIATIONS: readonly string[] = [
  "e.g.",
  "i.e.",
  "Dr.",
  "Mr.",
  "Mrs.",
  "Ms.",
  "vs.",
  "etc.",
];

/** A half-open range of a block's plain text, trimmed of the whitespace around it. */
export interface SentenceRange {
  /** Offset of the first character, into the plain text the range was computed from. */
  readonly start: number;
  /** Offset one past the last character. */
  readonly end: number;
  /** `plainText.slice(start, end)` — plain text, not Markdown. */
  readonly text: string;
}

/** A sentence of a paragraph block (PRD §6.1: `{blockId, index, start, end, text}`). */
export interface Sentence extends SentenceRange {
  /** The contentId of the paragraph the sentence belongs to. */
  readonly blockId: string;
  /** 0-based position of the sentence in its paragraph. */
  readonly index: number;
}

/**
 * A raw segmenter: given plain text, the ascending start offsets of its segments (the first is
 * always 0). The abbreviation post-filter of §6.1 runs over its result, so a fallback segmenter
 * (task 0.9) only has to propose candidate boundaries.
 */
export type SegmentFn = (text: string) => readonly number[];

/** Options shared by every sentence operation. */
export interface SegmentOptions {
  /** The raw segmenter to post-filter. Defaults to `Intl.Segmenter('en', {granularity:'sentence'})`. */
  readonly segment?: SegmentFn;
}

/** Options for {@link sentencesOf}. */
export interface SentenceOptions extends SegmentOptions {
  /**
   * The paragraph's contentId, as {@link blocksOf} computed it for the document the paragraph is
   * in. Defaults to the id the paragraph would have as the first occurrence of its own text.
   */
  readonly blockId?: string;
}

/** `Intl.Segmenter` in sentence granularity, the primary segmenter of PRD §4. */
function intlSegment(text: string): readonly number[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return [...segmenter.segment(text)].map((segment) => segment.index);
}

function escapeForClass(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Text that must not be followed by a sentence break: one of {@link ABBREVIATIONS}, or a single
 * capital letter followed by a period (an initial), at the end of the text before the boundary and
 * itself preceded by a space or an opening delimiter (so `stop.` is not read as the initial `p.`).
 */
const NO_BREAK_AFTER = new RegExp(
  `(?:^|[\\s("'\\[{])(?:${ABBREVIATIONS.map(escapeForClass).join("|")}|[A-Z]\\.)$`,
  "u",
);

/** Whether the §6.1 post-filter allows a sentence to end at `cut`. */
function mayBreakAt(text: string, cut: number): boolean {
  const before = text.slice(0, cut);
  // A decimal number: the period belongs to the number, not to a sentence.
  if (/\d\.$/u.test(before) && /^\d/u.test(text.slice(cut))) return false;
  return !NO_BREAK_AFTER.test(before.replace(/\s+$/u, ""));
}

/**
 * The sentences of a piece of plain text (PRD §6.1): the segments a sentence segmenter proposes,
 * with the boundaries the abbreviation post-filter rejects removed, each trimmed of surrounding
 * whitespace. Whitespace-only text has no sentences.
 *
 * Pure: `segment` is the only input beyond the text, and nothing is memoized between calls.
 */
export function segmentSentences(text: string, segment: SegmentFn = intlSegment): SentenceRange[] {
  const cuts = [...segment(text)]
    .slice(1)
    .filter((cut) => cut > 0 && cut < text.length && mayBreakAt(text, cut));

  const ranges: SentenceRange[] = [];
  let from = 0;
  for (const to of [...cuts, text.length]) {
    let start = from;
    let end = to;
    while (start < end && /\s/u.test(text[start])) start += 1;
    while (end > start && /\s/u.test(text[end - 1])) end -= 1;
    if (end > start) ranges.push({ start, end, text: text.slice(start, end) });
    from = to;
  }
  return ranges;
}

/**
 * The plain text of an inline node, without normalization: `text`, `inlineCode` and `html` give
 * their raw value, an `image` gives its alt text, a `break` gives a space, and a mark
 * (`emphasis`, `strong`, `delete`, `link`) gives the concatenation of its children. Offsets into
 * this string are what sentences are addressed by; `normalizedText` (blocks.ts) collapses
 * whitespace and so cannot be used here.
 */
function plainTextOf(node: Nodes): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "html":
      return node.value;
    case "image":
      return node.alt ?? "";
    case "break":
      return " ";
    default:
      return "children" in node ? node.children.map(plainTextOf).join("") : "";
  }
}

/** The plain text a paragraph's sentence offsets index into. */
export function paragraphText(paragraph: Paragraph): string {
  return paragraph.children.map(plainTextOf).join("");
}

/** Nodes whose text cannot be cut: they go whole to the slice that contains their start offset. */
function isAtomic(node: PhrasingContent): node is Break | Html | Image {
  return node.type === "image" || node.type === "break" || node.type === "html";
}

/**
 * A deep copy of the inline content covering `[from, to)` of the plain text of `children`.
 *
 * `text` and `inlineCode` are cut by offset; an atomic node goes whole to the slice containing its
 * start; a mark that straddles a boundary is copied into both slices with its own share of the
 * text, which is how a link spanning a sentence boundary survives on both sides (PRD §6.1).
 */
function sliceInline(
  children: readonly PhrasingContent[],
  from: number,
  to: number,
  offset = 0,
): { nodes: PhrasingContent[]; end: number } {
  const nodes: PhrasingContent[] = [];
  let cursor = offset;

  for (const child of children) {
    const start = cursor;
    const end = start + plainTextOf(child).length;
    cursor = end;

    if (isAtomic(child)) {
      const zeroWidth = end === start;
      if (start >= from && (start < to || (zeroWidth && start === from))) {
        nodes.push(structuredClone(child));
      }
      continue;
    }

    const lo = Math.max(start, from);
    const hi = Math.min(end, to);

    if (child.type === "text" || child.type === "inlineCode") {
      if (hi > lo) {
        nodes.push({ ...structuredClone(child), value: child.value.slice(lo - start, hi - start) });
      }
      continue;
    }

    if (hi <= lo) continue;
    // Everything left is a mark. (A childless node outside the §6.1 set, such as a
    // `footnoteReference`, cannot reach a parsed tree; it is skipped rather than trusted.)
    if (!("children" in child)) continue;
    const inner = sliceInline(child.children, from, to, start);
    if (inner.nodes.length > 0) {
      nodes.push({ ...structuredClone(child), children: inner.nodes } as PhrasingContent);
    }
  }

  return { nodes, end: cursor };
}

/**
 * The content between two sentences: whitespace by construction (sentence ranges are trimmed),
 * plus any `break` that separates them, with every mark around it unwrapped. A gap left inside a
 * mark would be copied out as a mark wrapped around a space — `[ ](url)`, or an emphasis whose
 * trailing space the formatter has to escape as `&#x20;`.
 */
function gapNodes(
  children: readonly PhrasingContent[],
  from: number,
  to: number,
): PhrasingContent[] {
  const unwrap = (nodes: readonly PhrasingContent[]): PhrasingContent[] =>
    nodes.flatMap((node) => ("children" in node ? unwrap(node.children) : [node]));
  return unwrap(sliceInline(children, from, to).nodes);
}

/** Adjacent `text` nodes created at a splice seam, joined back into one. */
function mergeAdjacentText(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  const merged: PhrasingContent[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (node.type === "text" && previous?.type === "text") {
      merged[merged.length - 1] = { ...previous, value: previous.value + node.value };
      continue;
    }
    merged.push(node);
  }
  return merged;
}

/** Drop the `position` of every node in a rebuilt subtree: it no longer describes any source. */
function stripPositions(nodes: readonly PhrasingContent[]): PhrasingContent[] {
  return nodes.map((node) => {
    const stripped = { ...node };
    delete stripped.position;
    if ("children" in stripped) {
      (stripped as { children: PhrasingContent[] }).children = stripPositions(stripped.children);
    }
    return stripped;
  });
}

/**
 * The sentences of a paragraph (PRD §6.1). Offsets index the paragraph's plain text
 * ({@link paragraphText}), not its Markdown.
 *
 * Pure: the paragraph is not mutated and nothing is cached.
 */
export function sentencesOf(paragraph: Paragraph, options: SentenceOptions = {}): Sentence[] {
  const blockId = options.blockId ?? `${contentHash(normalizedText(paragraph))}-0`;
  return segmentSentences(paragraphText(paragraph), options.segment).map((range, index) => ({
    ...range,
    blockId,
    index,
  }));
}

/**
 * The top-level paragraph carrying `blockId`. Sentences are addressed only in paragraphs that are
 * direct children of `root` (PRD §6.1, Rewrite/Reorder scope v1); a paragraph inside a list item or
 * a blockquote has no sentence operations.
 */
function topLevelParagraph(
  operation: string,
  root: Root,
  blockId: string,
): { index: number; node: Paragraph } {
  const block = blocksOf(root).find((candidate) => candidate.contentId === blockId);
  if (block === undefined) {
    throw new Error(`${operation}: no block with contentId ${blockId}`);
  }
  if (block.path.length !== 1 || block.node.type !== "paragraph") {
    throw new Error(
      `${operation}: block ${blockId} is a ${block.node.type} at depth ${block.path.length}; sentences are addressed only in top-level paragraphs (PRD §6.1)`,
    );
  }
  return { index: block.path[0], node: block.node };
}

/** The inline content of a piece of inline Markdown. */
function parseInline(operation: string, text: string): PhrasingContent[] {
  const root = parse(text);
  if (root.children.length !== 1 || root.children[0].type !== "paragraph") {
    const shape = root.children.map((child) => child.type).join(", ") || "nothing";
    throw new Error(
      `${operation}: ${JSON.stringify(text)} is not inline Markdown (it parses to ${shape})`,
    );
  }
  return root.children[0].children;
}

/** A copy of `root` whose paragraph at `index` has exactly `children`. */
function withParagraphChildren(
  root: Root,
  index: number,
  paragraph: Paragraph,
  children: PhrasingContent[],
): Root {
  const next = structuredClone(root);
  const replacement: Paragraph = {
    ...structuredClone(paragraph),
    children: stripPositions(mergeAdjacentText(children)),
  };
  delete replacement.position;
  next.children[index] = replacement;
  return next;
}

/**
 * A copy of `root` with sentence `index` of the top-level paragraph `blockId` replaced by the
 * inline Markdown `text`.
 *
 * Replacement semantics (PRD §6.1): the sentence's range is replaced wholesale, so marks that lie
 * inside it go with it and marks that begin or end outside it survive untouched — replacing
 * `A **bold** start.` with `A quiet start.` yields plain text, and with `A **quiet** start.` yields
 * bold again. The whitespace separating the sentence from its neighbours is not part of the range:
 * it stays where it is, outside every mark ({@link gapNodes}).
 *
 * @throws Error if `blockId` is not a top-level paragraph or `text` is not inline Markdown.
 * @throws RangeError if `index` is not a sentence of that paragraph.
 */
export function replaceSentence(
  root: Root,
  blockId: string,
  index: number,
  text: string,
  options: SegmentOptions = {},
): Root {
  const { index: at, node } = topLevelParagraph("replaceSentence", root, blockId);
  const sentences = sentencesOf(node, { ...options, blockId });
  if (!Number.isInteger(index) || index < 0 || index >= sentences.length) {
    throw new RangeError(
      `replaceSentence: sentence ${index} is outside 0..${sentences.length - 1} of block ${blockId}`,
    );
  }

  const plain = paragraphText(node);
  const sentence = sentences[index];
  const previousEnd = index > 0 ? sentences[index - 1].end : 0;
  const nextStart = index + 1 < sentences.length ? sentences[index + 1].start : plain.length;
  const children = [
    ...sliceInline(node.children, 0, previousEnd).nodes,
    ...gapNodes(node.children, previousEnd, sentence.start),
    ...parseInline("replaceSentence", text),
    ...gapNodes(node.children, sentence.end, nextStart),
    ...sliceInline(node.children, nextStart, plain.length).nodes,
  ];
  return withParagraphChildren(root, at, node, children);
}

/**
 * A copy of `root` with the sentences of the top-level paragraph `blockId` reordered: the sentence
 * at position `i` of the result is the paragraph's sentence `order[i]`.
 *
 * The whitespace between sentences keeps its position — the sentences move through the gaps rather
 * than carrying them along — so a paragraph reordered by the identity permutation is unchanged.
 * Marks travel with the sentence they belong to, and a mark straddling a boundary is split at it.
 *
 * @throws Error if `blockId` is not a top-level paragraph.
 * @throws RangeError if `order` is not a permutation of the paragraph's sentence indices.
 */
export function reorderSentences(
  root: Root,
  blockId: string,
  order: readonly number[],
  options: SegmentOptions = {},
): Root {
  const { index: at, node } = topLevelParagraph("reorderSentences", root, blockId);
  const sentences = sentencesOf(node, { ...options, blockId });

  const seen = new Set(order);
  const isPermutation =
    order.length === sentences.length &&
    seen.size === order.length &&
    order.every((value) => Number.isInteger(value) && value >= 0 && value < sentences.length);
  if (!isPermutation) {
    throw new RangeError(
      `reorderSentences: [${order.join(", ")}] is not a permutation of the ${sentences.length} sentences of block ${blockId}`,
    );
  }

  const plain = paragraphText(node);
  if (sentences.length === 0) return withParagraphChildren(root, at, node, [...node.children]);

  const children = [...gapNodes(node.children, 0, sentences[0].start)];
  order.forEach((source, position) => {
    children.push(
      ...sliceInline(node.children, sentences[source].start, sentences[source].end).nodes,
    );
    children.push(
      ...gapNodes(
        node.children,
        sentences[position].end,
        position + 1 < sentences.length ? sentences[position + 1].start : plain.length,
      ),
    );
  });
  return withParagraphChildren(root, at, node, children);
}
