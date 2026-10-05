import { useSyncExternalStore } from "react";
import type { DocumentState } from "@essaydown/core";
import type { DocumentStore } from "@essaydown/editor";

/**
 * The horizontal distance (px) a section row must be dragged to the right for the drop to nest it
 * under the row it lands on (task 3.2): less is a reorder beside that row, at its depth. The same
 * threshold for a pointer drag and for the keyboard sensor's arrow steps (25 px each in
 * `@dnd-kit/core`'s default coordinates, so two ArrowRight presses nest).
 */
export const NEST_OFFSET_PX = 40;

/** Whether a drag that moved `deltaX` px horizontally ends as a nest (see {@link NEST_OFFSET_PX}). */
export function isNestDrag(deltaX: number): boolean {
  return deltaX >= NEST_OFFSET_PX;
}

/** The section index a tree row's draggable/droppable id names, or null for any other id. */
export function sectionOfId(id: string | number): number | null {
  const match = /^section-(\d+)$/.exec(String(id));
  return match === null ? null : Number(match[1]);
}

/** The id of section `index`'s tree row, as {@link sectionOfId} reads it back. */
export function sectionId(index: number): string {
  return `section-${index}`;
}

/**
 * The store's present snapshot, re-rendering on a snapshot change only (a caret move notifies the
 * store too, and the Outline shows nothing of the caret).
 */
export function useDocumentState(store: DocumentStore): DocumentState {
  return useSyncExternalStore(store.subscribe, () => store.getState().document);
}
