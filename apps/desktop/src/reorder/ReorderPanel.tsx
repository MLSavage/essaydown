import { useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { Root } from "mdast";
import {
  applyMoveBlock,
  applyMoveSection,
  applyReorderSentences,
  blocksOf,
  normalizedText,
  outlineOf,
  rewriteCards,
} from "@essaydown/core";
import { cursorBlock, mdastToPM, type DocumentStore, type ModeMutation } from "@essaydown/editor";
import { useDocumentState } from "../outline/outline-view";
import { useStoreUndoKeys } from "../modes/undo-keys";

interface Props {
  readonly store: DocumentStore;
  /** Cmd (macOS) or Ctrl (elsewhere), as the mode chords and the editor's `Mod-` read it. */
  readonly mac: boolean;
}

/** The caret's top-level block and the blocks between the headings around it (its section's own). */
interface Focus {
  readonly at: number;
  readonly blocks: readonly number[];
}

function isHeading(root: Root, at: number): boolean {
  return root.children[at]?.type === "heading";
}

function focusOf(root: Root, at: number | null): Focus | null {
  if (at === null || at >= root.children.length) return null;
  const shift = root.children[0]?.type === "yaml" ? 1 : 0;
  let first = at;
  while (first > shift && !isHeading(root, first)) first -= 1;
  if (isHeading(root, first)) first += 1;
  let last = at;
  while (last + 1 < root.children.length && !isHeading(root, last + 1)) last += 1;
  const blocks: number[] = [];
  for (let index = first; index <= last; index += 1) blocks.push(index);
  return { at, blocks };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The index a sortable id of `prefix` names, or null for an id of another list. */
function indexOf(prefix: string, id: string | number | undefined): number | null {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(String(id));
  return match === null ? null : Number(match[1]);
}

const PREVIEW_LENGTH = 90;

function preview(text: string): string {
  return text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`;
}

/**
 * Reorder mode's right sidebar (PRD §6.3, task 3.5): the sentence chips of the caret's paragraph,
 * the block cards of the caret's section (the blocks between the headings around it), and the
 * section tree of the whole essay. Each list is a `@dnd-kit/sortable` list in its own
 * `DndContext`, so an item drops only among its own kind.
 *
 * Pointer and keyboard both drive every list: a pointer drag starts after 4 px of movement on an
 * item's handle; the handle takes Space (or Enter) to pick up, arrows to move one item at a time
 * (`sortableKeyboardCoordinates`), Space (or Enter) to drop, Escape to cancel. A drop is one store
 * mutation — `applyReorderSentences`, `applyMoveBlock` or `applyMoveSection` from `core`, each of
 * which carries the sidecar's anchors with the moved item — so one undo step holding both the
 * Markdown and the sidecar (§6.5); Cmd/Ctrl+Z outside the editor steps the store like the editor's
 * keymap does.
 *
 * A drop onto the item's own place changes nothing and pushes nothing.
 */
export default function ReorderPanel({ store, mac }: Props) {
  const document = useDocumentState(store);
  const cursor = useSyncExternalStore(store.subscribe, () => store.getState().cursor);
  const [error, setError] = useState<string | null>(null);
  const doc = useMemo(() => mdastToPM(document.root).doc, [document.root]);
  const focus = useMemo(() => {
    if (cursor === null) return null;
    const position = cursorBlock(doc, cursor);
    if (position === null) return null;
    const shift = document.root.children[0]?.type === "yaml" ? 1 : 0;
    return focusOf(document.root, position.block + shift);
  }, [document.root, doc, cursor]);
  const sentences = useMemo(() => (focus === null ? null : rewriteCards(document, focus.at)), [document, focus]);
  const sections = useMemo(() => outlineOf(document), [document]);
  useStoreUndoKeys(store, mac);

  const run = (mutation: ModeMutation): void => {
    try {
      store.getState().dispatch(mutation);
      setError(null);
    } catch (failure) {
      setError(describe(failure));
    }
  };

  const dropSentence = (event: DragEndEvent): void => {
    const from = indexOf("chip", event.active.id);
    const to = indexOf("chip", event.over?.id);
    if (focus === null || sentences === null || from === null || to === null || from === to) return;
    const block = blocksOf(document.root).find((one) => one.path.length === 1 && one.path[0] === focus.at);
    if (block === undefined) return;
    const order = arrayMove(
      sentences.map((_, index) => index),
      from,
      to,
    );
    run((state) => applyReorderSentences(state, block.contentId, order));
  };

  const dropBlock = (event: DragEndEvent): void => {
    const from = indexOf("block", event.active.id);
    const to = indexOf("block", event.over?.id);
    if (from === null || to === null || from === to) return;
    run((state) => applyMoveBlock(state, from, to));
  };

  const dropSection = (event: DragEndEvent): void => {
    const from = indexOf("section", event.active.id);
    const to = indexOf("section", event.over?.id);
    if (from === null || to === null || from === to) return;
    run((state) => applyMoveSection(state, from, to));
  };

  return (
    <aside className="reorder-panel" data-testid="reorder-panel" aria-label="Reorder">
      <div className="reorder-header">
        <span className="reorder-title">Reorder</span>
      </div>
      {error !== null && (
        <p className="reorder-error" role="alert" data-testid="reorder-error">
          {error}
        </p>
      )}
      <section className="reorder-group" data-testid="reorder-sentences">
        <h3 className="reorder-group-title">Sentences</h3>
        {sentences === null || sentences.length === 0 ? (
          <p className="reorder-empty">Put the caret in a paragraph to reorder its sentences.</p>
        ) : (
          <SortableList prefix="chip" count={sentences.length} onDragEnd={dropSentence}>
            {sentences.map((sentence, index) => (
              <SortableItem
                key={index}
                id={`chip-${index}`}
                testid="reorder-sentence"
                index={index}
                label={sentence.markdown}
              >
                {sentence.markdown}
              </SortableItem>
            ))}
          </SortableList>
        )}
      </section>
      <section className="reorder-group" data-testid="reorder-blocks">
        <h3 className="reorder-group-title">Paragraphs</h3>
        {focus === null || focus.blocks.length === 0 ? (
          <p className="reorder-empty">Put the caret in a section to reorder its paragraphs.</p>
        ) : (
          <SortableList prefix="block" ids={focus.blocks} onDragEnd={dropBlock}>
            {focus.blocks.map((at) => {
              const node = document.root.children[at];
              const text = preview(normalizedText(node));
              return (
                <SortableItem key={at} id={`block-${at}`} testid="reorder-block" index={at} kind={node.type} label={text}>
                  {node.type !== "paragraph" && <span className="reorder-kind">{node.type}</span>}
                  {text}
                </SortableItem>
              );
            })}
          </SortableList>
        )}
      </section>
      <section className="reorder-group" data-testid="reorder-sections">
        <h3 className="reorder-group-title">Sections</h3>
        {sections.length === 0 ? (
          <p className="reorder-empty">This essay has no headings.</p>
        ) : (
          <SortableList prefix="section" count={sections.length} onDragEnd={dropSection}>
            {sections.map((section) => (
              <SortableItem
                key={section.index}
                id={`section-${section.index}`}
                testid="reorder-section"
                index={section.index}
                depth={section.depth}
                label={section.text}
              >
                {section.text}
              </SortableItem>
            ))}
          </SortableList>
        )}
      </section>
    </aside>
  );
}

interface ListProps {
  readonly prefix: string;
  /** The items' indices, when they are not simply 0..count-1. */
  readonly ids?: readonly number[];
  readonly count?: number;
  readonly onDragEnd: (event: DragEndEvent) => void;
  readonly children: ReactNode;
}

function SortableList({ prefix, ids, count = 0, onDragEnd, children }: ListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const items = (ids ?? Array.from({ length: count }, (_, index) => index)).map((index) => `${prefix}-${index}`);
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <ol className="reorder-list">{children}</ol>
      </SortableContext>
    </DndContext>
  );
}

interface ItemProps {
  readonly id: string;
  readonly testid: string;
  readonly index: number;
  readonly label: string;
  readonly kind?: string;
  readonly depth?: number;
  readonly children: ReactNode;
}

function SortableItem({ id, testid, index, label, kind, depth, children }: ItemProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: CSSProperties = {
    paddingLeft: depth === undefined ? undefined : `${8 + (depth - 1) * 14}px`,
    transform: transform === null ? undefined : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
    transition,
    zIndex: isDragging ? 1 : undefined,
    position: isDragging ? "relative" : undefined,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`reorder-item${isDragging ? " reorder-item-dragging" : ""}`}
      data-testid={testid}
      data-index={index}
      data-kind={kind}
      data-depth={depth}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="reorder-handle"
        data-testid={`${testid}-handle`}
        aria-label={`Move ${label}`}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <span className="reorder-text" data-testid={`${testid}-text`} title={label}>
        {children}
      </span>
    </li>
  );
}
