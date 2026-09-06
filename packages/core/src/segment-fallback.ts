import { segmentSentences, type SegmentFn, type SentenceRange } from "./sentences.js";

/**
 * Which sentence segmenter a runtime should use (PRD §4): `Intl.Segmenter` where it exists and
 * behaves, the rule-based fallback of this module otherwise.
 */
export type SegmenterChoice = "intl" | "fallback";

/** A canary: plain text and the sentences §6.1 says it holds. */
export interface SegmenterCanary {
  /** The id of the matching case in `packages/core/test/sentences.cases.json`. */
  readonly id: string;
  /** Plain text — never Markdown, so the same case can run inside a webview (task 6.2). */
  readonly text: string;
  /** The exact list `segmentSentences(text)` must return. */
  readonly sentences: readonly string[];
}

/**
 * The five cases {@link segmenterSelfTest} runs against the runtime's `Intl.Segmenter`, one per
 * §6.1 rule that an ICU version could plausibly disagree about: an ordinary split, the two
 * post-filtered shapes (an abbreviation and a decimal), a non-period terminator, and text with no
 * terminator at all. Each is a copy of the case of the same id in
 * `packages/core/test/sentences.cases.json`; a test asserts the two never drift apart.
 */
export const SEGMENTER_CANARIES: readonly SegmenterCanary[] = [
  {
    id: "plain-two",
    text: "The pen was full. The page was empty.",
    sentences: ["The pen was full.", "The page was empty."],
  },
  {
    id: "abbrev-dr",
    text: "Dr. Smith went home. He slept.",
    sentences: ["Dr. Smith went home.", "He slept."],
  },
  {
    id: "decimal-mid",
    text: "It cost 3.50 dollars. Then more.",
    sentences: ["It cost 3.50 dollars.", "Then more."],
  },
  {
    id: "question-mark",
    text: "Where is the ink? It is on the desk.",
    sentences: ["Where is the ink?", "It is on the desk."],
  },
  {
    id: "no-terminator",
    text: "One sentence with no terminator",
    sentences: ["One sentence with no terminator"],
  },
];

/**
 * A sentence boundary, by rule rather than by ICU: one or more terminal punctuation marks, any
 * closing quotes or brackets that follow them, whitespace, and then the start of something that
 * can open a sentence — optional opening quotes or brackets and a capital letter or a digit.
 *
 * The boundary is placed after the whitespace, at the first character of the next sentence.
 *
 * Nothing here knows about abbreviations: the boundary this proposes is a *candidate*, and the
 * §6.1 post-filter inside {@link segmentSentences} (which reads `ABBREVIATIONS` from
 * sentences.ts, the same list the primary segmenter is post-filtered with) is what rejects `Dr. `, `e.g. `, an initial
 * and a decimal. A lowercase continuation is never a boundary, which is what keeps `See e.g. the
 * chart.` whole even before the post-filter runs.
 */
const BOUNDARY =
  /[.!?…]+[)\]}"'’”»›]*\s+(?=[("'‘“[{«‹]*[\p{Lu}\p{Lt}\p{Nd}])/gu;

/**
 * The rule-based fallback segmenter of PRD §4 (`core/segment-fallback.ts`), used where
 * `Intl.Segmenter` is absent or {@link segmenterSelfTest} rejects it.
 *
 * Pure, and a drop-in {@link SegmentFn}: it returns the ascending start offsets of the candidate
 * segments (the first is always 0), which {@link segmentSentences} then post-filters and trims.
 */
export const fallbackSegment: SegmentFn = (text: string): readonly number[] => {
  const starts = [0];
  for (const match of text.matchAll(BOUNDARY)) {
    // Always inside the text: the match itself is at least a terminator and a space, and its
    // lookahead has already established that a further character follows it.
    starts.push(match.index + match[0].length);
  }
  return starts;
};

/**
 * The sentences of a piece of plain text using the rule-based fallback instead of
 * `Intl.Segmenter`. Identical in shape and semantics to {@link segmentSentences}'s default: the
 * same §6.1 abbreviation post-filter runs over the candidates, and the ranges are trimmed.
 */
export function fallbackSentences(text: string): SentenceRange[] {
  return segmentSentences(text, fallbackSegment);
}

/** Whether this runtime has an `Intl.Segmenter` constructor at all. */
function hasIntlSegmenter(): boolean {
  return typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";
}

/**
 * Which segmenter this runtime should use (PRD §4). Runs the five {@link SEGMENTER_CANARIES}
 * through the §6.1 pipeline on the runtime's own `Intl.Segmenter` and returns `'intl'` only if
 * every one produces exactly the sentences §6.1 specifies; a missing constructor, a throw, or a
 * single divergent case returns `'fallback'`.
 *
 * Pure and side-effect free: it reads the runtime's `Intl`, mutates nothing and caches nothing, so
 * a caller that stubs `Intl.Segmenter` sees the answer for the stub.
 */
export function segmenterSelfTest(): SegmenterChoice {
  if (!hasIntlSegmenter()) return "fallback";
  try {
    for (const canary of SEGMENTER_CANARIES) {
      const actual = segmentSentences(canary.text).map((range) => range.text);
      if (actual.length !== canary.sentences.length) return "fallback";
      if (actual.some((sentence, index) => sentence !== canary.sentences[index])) return "fallback";
    }
  } catch {
    // A constructor that exists but rejects the locale, the granularity or the input is no more
    // usable than an absent one.
    return "fallback";
  }
  return "intl";
}
