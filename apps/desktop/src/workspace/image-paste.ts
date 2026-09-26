import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/** Writes `bytes` through `save_image` and returns the document-directory-relative fragment
 * (`assets/<stem>/<file>`, PRD §6.4) to insert as the new `image` node's `url`. */
export type SaveImage = (bytes: Uint8Array, extension: string) => Promise<string>;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

/** The file's own MIME type first (the source of truth for pasted clipboard data, which rarely
 * carries a real filename); a dropped file's name extension as the fallback; `png` failing both. */
function extensionFor(file: File): string {
  const byMime = EXTENSION_BY_MIME[file.type];
  if (byMime !== undefined) return byMime;
  const dot = file.name.lastIndexOf(".");
  return dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "png";
}

function imageFilesFrom(data: DataTransfer | null): File[] {
  if (data === null) return [];
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

/** Saves every file in order and inserts one `image` node per file, starting at `atPos` (the
 * current selection when `null`, a drop's own drop point otherwise) and advancing by each
 * inserted node's size — reads `view.state` fresh before every insert, since `saveImage`'s IPC
 * round trip is the one await point where another transaction could land first. */
async function insertImages(view: EditorView, files: File[], saveImage: SaveImage, atPos: number | null): Promise<void> {
  let pos = atPos ?? view.state.selection.from;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const relative = await saveImage(bytes, extensionFor(file));
    const { state } = view;
    const node = state.schema.nodes.image.create({ url: relative, alt: null, title: null });
    const clamped = Math.min(pos, state.doc.content.size);
    view.dispatch(state.tr.insert(clamped, node));
    pos = clamped + node.nodeSize;
  }
}

/**
 * Paste/drag → `save_image` → `![](assets/<docstem>/<file>)` (task 2.6, PRD §6.4). Only image
 * files take this route: a paste or drop carrying no image file returns `false` and falls through
 * to ProseMirror's own handling (plain text, an HTML fragment, `img[src]` from another app's rich
 * paste, unchanged).
 */
export function imagePastePlugin(saveImage: SaveImage): Plugin {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const files = imageFilesFrom(event.clipboardData);
        if (files.length === 0) return false;
        void insertImages(view, files, saveImage, null);
        return true;
      },
      handleDrop(view, event) {
        const files = imageFilesFrom(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
        void insertImages(view, files, saveImage, at?.pos ?? null);
        return true;
      },
    },
  });
}
