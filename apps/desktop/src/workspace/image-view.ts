import { convertFileSrc } from "@tauri-apps/api/core";
import type { Node as PMNode } from "prosemirror-model";
import type { NodeView } from "prosemirror-view";
import { imageAbsolutePathFor } from "./paths";

/**
 * The `image` node's rendered view (task 2.6, PRD §6.4): `schema.ts`'s `toDOM` writes the node's
 * `url` attribute straight into `<img src>`, which is exactly right for the source mode's own
 * bytes (a relative Markdown path is what belongs in the serialized document) but wrong for the
 * *rendered* view, where the browser needs an `asset:` URL Tauri's asset protocol will actually
 * serve. This `NodeView` overrides only the rendered editor's DOM for this one node type
 * (`EditorView`'s `nodeViews` prop); the schema, `toDOM` and `parseDOM` are untouched, so copy/paste
 * and the source mode still see the node's own `url` attribute.
 *
 * A broken path (the file does not exist, or falls outside the asset-protocol scope) fails to
 * load like any other broken `<img>`: the `error` event swaps the `<img>` for a labelled
 * placeholder naming the exact relative path the document held, never a re-check of the
 * filesystem — the browser's own load attempt is the check.
 */
export function createImageNodeView(root: string, currentDocPath: () => string) {
  return (node: PMNode): NodeView => {
    const relative = (node.attrs.url as string | null) ?? "";
    const dom = document.createElement("span");
    dom.className = "image-node";

    const img = document.createElement("img");
    img.alt = (node.attrs.alt as string | null) ?? "";
    if (node.attrs.title !== null) img.title = node.attrs.title as string;
    img.addEventListener(
      "error",
      () => {
        const placeholder = document.createElement("span");
        placeholder.className = "image-placeholder";
        placeholder.setAttribute("data-testid", "image-placeholder");
        placeholder.textContent = `Image not found: ${relative}`;
        dom.replaceChildren(placeholder);
      },
      { once: true },
    );
    img.src = convertFileSrc(imageAbsolutePathFor(root, currentDocPath(), relative));
    dom.replaceChildren(img);

    // The `error` handler above replaces `dom`'s own children outside of a ProseMirror
    // transaction; without this, `EditorView`'s DOM-mutation observer sees a childList change it
    // did not make and "repairs" it by redrawing the node view from the document model, silently
    // putting a fresh (still-loading) `<img>` back in the placeholder's place.
    return { dom, ignoreMutation: () => true };
  };
}
