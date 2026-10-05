import { useMemo, useState, type CSSProperties } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import { applyOutlineDrop, outlineDrop, outlineOf, type OutlineItem } from "@essaydown/core";
import type { DocumentStore } from "@essaydown/editor";
import { isNestDrag, sectionId, sectionOfId, useDocumentState } from "./outline-view";

interface Props {
  readonly store: DocumentStore;
}

/** Where the drag in progress would drop, for the row highlight; null when it would be refused. */
interface Pending {
  readonly over: number;
  readonly nest: boolean;
}

/**
 * Outline mode's left-sidebar section tree (PRD §6.3, task 3.2): one row per section, indented by
 * depth. Dragging a row's handle onto another row reorders the section beside it, at that row's
 * depth; dragging it there and to the right by `NEST_OFFSET_PX` or more nests it as that row's last
 * child (`core/outline.ts`'s `outlineDrop`). A drop is one store mutation, so one undo step holding
 * the moved Markdown and the sidecar anchors that moved with it (§6.5).
 *
 * Pointer and keyboard both drive it (`@dnd-kit/core`'s sensors: the handle takes Space or Enter to
 * pick up, arrows to move, Space or Enter to drop). A pointer drag starts after 4 px of movement,
 * so a click on the handle is not a drag.
 */
export default function OutlineTree({ store }: Props) {
  const document = useDocumentState(store);
  const items = useMemo(() => outlineOf(document), [document]);
  const [pending, setPending] = useState<Pending | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  const intent = (event: DragMoveEvent | DragEndEvent): { from: number; over: number; nest: boolean } | null => {
    const from = sectionOfId(event.active.id);
    const over = event.over === null ? null : sectionOfId(event.over.id);
    if (from === null || over === null) return null;
    return { from, over, nest: isNestDrag(event.delta.x) };
  };

  const onDragMove = (event: DragMoveEvent): void => {
    const next = intent(event);
    const allowed = next !== null && outlineDrop(store.getState().document.root, next.from, next.over, next.nest) !== null;
    setPending(allowed ? { over: next.over, nest: next.nest } : null);
  };

  const onDragEnd = (event: DragEndEvent): void => {
    setPending(null);
    const drop = intent(event);
    if (drop === null) return;
    store.getState().dispatch((state) => applyOutlineDrop(state, drop.from, drop.over, drop.nest));
  };

  return (
    <nav className="outline-tree" data-testid="outline-tree" aria-label="Sections">
      <div className="outline-tree-title">Sections</div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={() => setPending(null)}
      >
        <ul className="outline-tree-list">
          {items.map((item) => (
            <TreeRow
              key={item.index}
              item={item}
              drop={pending !== null && pending.over === item.index ? (pending.nest ? "nest" : "beside") : null}
            />
          ))}
        </ul>
      </DndContext>
    </nav>
  );
}

interface RowProps {
  readonly item: OutlineItem;
  readonly drop: "nest" | "beside" | null;
}

function TreeRow({ item, drop }: RowProps) {
  const id = sectionId(item.index);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({ id });
  const { setNodeRef: setDropRef } = useDroppable({ id });
  const style: CSSProperties = {
    paddingLeft: `${8 + (item.depth - 1) * 14}px`,
    transform: transform === null ? undefined : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
    zIndex: isDragging ? 1 : undefined,
    position: isDragging ? "relative" : undefined,
  };
  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        setDropRef(node);
      }}
      style={style}
      className={`outline-tree-row${drop === null ? "" : ` outline-tree-drop-${drop}`}${isDragging ? " outline-tree-dragging" : ""}`}
      data-testid="outline-tree-row"
      data-index={item.index}
      data-depth={item.depth}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="outline-tree-handle"
        data-testid="outline-tree-handle"
        aria-label={`Drag ${item.text}`}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <span className="outline-tree-text" title={item.text}>
        {item.text}
      </span>
    </li>
  );
}
