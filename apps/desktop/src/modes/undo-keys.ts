import { useEffect } from "react";
import type { DocumentStore } from "@essaydown/editor";

/**
 * Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z step the store while a mode's sidebar is showing, wherever focus
 * is — after a sidebar action it is on a button, or on nothing. The editor's own keymap handles the
 * chord first when the editor has focus and marks the event handled, and a text field keeps its
 * native undo, so neither of those steps the store twice. Shared by Rewrite (task 3.4) and Reorder
 * (task 3.5).
 */
export function useStoreUndoKeys(store: DocumentStore, mac: boolean): void {
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.defaultPrevented) return;
      const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!mod || event.altKey || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT")) {
        return;
      }
      event.preventDefault();
      if (event.shiftKey) store.getState().redo();
      else store.getState().undo();
    }
    window.document.addEventListener("keydown", onKeyDown);
    return () => window.document.removeEventListener("keydown", onKeyDown);
  }, [mac, store]);
}
