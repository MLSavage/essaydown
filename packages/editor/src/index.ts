export {
  editorPlugins,
  essaydownKeymap,
  exitEmptyListItem,
  markdownInputRules,
  tableFromRow,
  tableRowCells,
} from "./input.js";

export {
  DELIMITER_CLASS,
  activeBlock,
  delimiterDOM,
  markDelimiters,
  revealDecorations,
  revealDelimiters,
  revealPlugin,
  type Delimiter,
} from "./reveal.js";

export {
  TYPING_KEY,
  bindProseMirror,
  createDocumentStore,
  sourceUndoKeymap,
  storePlugins,
  undoKeyBindings,
  undoKeymap,
  type BindOptions,
  type BoundView,
  type DocumentBinding,
  type DocumentStore,
  type DocumentStoreState,
} from "./store.js";

export {
  SOURCE_KEY,
  TOGGLE_KEY,
  bindCodeMirror,
  canonicalCursor,
  otherMode,
  cursorMap,
  renderedSelection,
  sourceCursor,
  sourceOffset,
  sourceToggleKeymap,
  toggleKeyBindings,
  toggleKeymap,
  toggleMode,
  togglePlugins,
  type BoundSourceView,
  type CursorMap,
  type EditorMode,
  type SourceBindOptions,
  type SourceBinding,
  type SourcePosition,
} from "./toggle.js";

export { TOKEN_CLASSES, sourceExtensions, sourceLanguage, tokenHighlightStyle } from "./source.js";

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
