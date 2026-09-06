export { format, createFormatter, stringifyOptions, opaqueHandlers, toMarkdownExtensions } from "./format.js";
export {
  parse,
  createParser,
  micromarkExtensions,
  fromMarkdownExtensions,
} from "./parse.js";

export function placeholder(): string {
  return "core";
}
