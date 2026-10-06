import { applyMoveBlock, format } from "@essaydown/core";
import type { DocumentStore, DocumentStoreState, ModeMutation } from "@essaydown/editor";

/**
 * `window.__essaydown`, the shell e2e's handle on the open document's store (task 3.1's acceptance:
 * "an injected store mutation (test-only `window.__essaydown.dispatch(moveBlock(...))`) followed
 * by Cmd/Ctrl+Z restores the exact prior Markdown and sidecar").
 *
 * **Test-only, present in every build.** The shell e2e drives the same production frontend bundle
 * the app ships (`vite build`, then `cargo build`; ci.yml's e2e-shell job), so there is no build
 * flag to hide it behind without a second bundle. It reaches nothing the page cannot already reach:
 * `dispatch` takes the same core mutations a mode's own UI pushes, and the readers return the
 * store's current snapshot. No product code reads it.
 *
 * **Every reader settles first** (task 3.19): a source burst still inside its window is only in the
 * CodeMirror buffer, so each reader calls the store's `settle()` before it reads, and `dispatch`
 * settles through the store's own `dispatch`.
 */
export interface EssaydownTestHook {
  /** The store's own `dispatch`: one mode mutation, one undo snapshot. */
  dispatch(mutation: ModeMutation): void;
  /** `core`'s `applyMoveBlock` with its indices bound, as a mutation `dispatch` takes. */
  moveBlock(from: number, to: number): ModeMutation;
  /** `format(root)` of the store's current snapshot. */
  markdown(): string;
  /** The store's current sidecar, as JSON. */
  sidecar(): string;
  /** The store's cursor (a ProseMirror position), or null before the view reported one. */
  cursor(): number | null;
  /** How many snapshots the undo stack holds, so a test can see one dispatch push exactly one. */
  snapshots(): number;
}

export interface TestHookHost {
  __essaydown?: EssaydownTestHook;
}

/** The store's state after its pending source burst, if any, was committed. */
function settled(store: DocumentStore): DocumentStoreState {
  store.getState().settle();
  return store.getState();
}

export function createTestHook(store: DocumentStore): EssaydownTestHook {
  return {
    dispatch: (mutation) => store.getState().dispatch(mutation),
    moveBlock: (from, to) => (state) => applyMoveBlock(state, from, to),
    markdown: () => format(settled(store).document.root),
    sidecar: () => JSON.stringify(settled(store).document.sidecar),
    cursor: () => settled(store).cursor,
    snapshots: () => settled(store).stack.entries.length,
  };
}

/**
 * Point `host.__essaydown` at `store` and return the uninstall. The uninstall removes the hook only
 * while it is still this install's, so a pane that unmounts after a newer pane mounted (a reload
 * replaces the store; a switch remounts the pane) never removes the newer pane's hook.
 */
export function installTestHook(host: TestHookHost, store: DocumentStore): () => void {
  const hook = createTestHook(store);
  host.__essaydown = hook;
  return () => {
    if (host.__essaydown === hook) delete host.__essaydown;
  };
}
