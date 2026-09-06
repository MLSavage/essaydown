export { format, createFormatter, stringifyOptions, opaqueHandlers, toMarkdownExtensions } from "./format.js";
export {
  parse,
  createParser,
  micromarkExtensions,
  fromMarkdownExtensions,
} from "./parse.js";
export {
  fnv1a64,
  toBase36,
  contentHash,
  CONTENT_ID_LENGTH,
  FNV_OFFSET_BASIS_64,
  FNV_PRIME_64,
} from "./hash.js";
export {
  blocksOf,
  sectionsOf,
  normalizedText,
  replaceBlock,
  moveBlock,
  moveSection,
  setHeadingDepth,
  type Block,
  type BlockNode,
  type Section,
} from "./blocks.js";

export {
  segmentSentences,
  sentencesOf,
  paragraphText,
  replaceSentence,
  reorderSentences,
  ABBREVIATIONS,
  type Sentence,
  type SentenceRange,
  type SentenceOptions,
  type SegmentOptions,
  type SegmentFn,
} from "./sentences.js";

export {
  fallbackSegment,
  fallbackSentences,
  segmenterSelfTest,
  SEGMENTER_CANARIES,
  type SegmenterCanary,
  type SegmenterChoice,
} from "./segment-fallback.js";

export function placeholder(): string {
  return "core";
}
