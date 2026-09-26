import { useEffect, useRef } from "react";

export type ContextMenuTarget = { path: string; cloudOnly: boolean; x: number; y: number };

export type ContextMenuProps = {
  target: ContextMenuTarget;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onReveal: (path: string) => void;
  onClose: () => void;
};

/** The file tree's right-click menu (task 2.4). A `cloudOnly` entry has no downloaded document to
 * rename or trash — `rename_file`/`delete_to_trash` would hit the real, honest `NotFound` I/O error
 * a not-yet-materialised `.icloud` placeholder produces — so those two items are omitted for it and
 * only "Reveal in Folder" (which reveals the placeholder itself) remains. */
export default function ContextMenu({ target, onRename, onDelete, onReveal, onClose }: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      if (menu.current !== null && !menu.current.contains(event.target as Node)) onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menu}
      className="file-tree-context-menu"
      data-testid="context-menu"
      style={{ position: "fixed", left: target.x, top: target.y }}
    >
      {!target.cloudOnly && (
        <button
          type="button"
          data-testid="context-menu-rename"
          onClick={() => {
            onRename(target.path);
            onClose();
          }}
        >
          Rename
        </button>
      )}
      {!target.cloudOnly && (
        <button
          type="button"
          data-testid="context-menu-delete"
          onClick={() => {
            onDelete(target.path);
            onClose();
          }}
        >
          Delete
        </button>
      )}
      <button
        type="button"
        data-testid="context-menu-reveal"
        onClick={() => {
          onReveal(target.path);
          onClose();
        }}
      >
        Reveal in Folder
      </button>
    </div>
  );
}
