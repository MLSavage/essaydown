export {
  editorPlugins,
  essaydownKeymap,
  exitEmptyListItem,
  markdownInputRules,
  tableFromRow,
  tableRowCells,
} from "./input.js";

export {
  MDAST_TYPES,
  RAW_CLASS,
  marks,
  mdastToPM,
  nodes,
  pmToMdast,
  schema,
  type EditorDocument,
} from "./schema.js";

export function placeholder(): string {
  return "editor";
}
