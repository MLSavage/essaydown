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

export function placeholder(): string {
  return "core";
}
