import { assetsPathFor, sidecarPathFor } from "./paths";

export type ConfirmDeleteProps = {
  path: string;
  onCancel: () => void;
  onConfirm: (path: string) => void;
};

/** `delete_to_trash` (task 2.3) trashes the document, its sidecar and its `assets/<stem>` directory
 * together; this dialog lists all three by name before the frontend calls it, since a missing
 * sidecar or assets directory is silently skipped on the Rust side and the user should know what
 * is actually about to move — not just the one path they clicked. */
export default function ConfirmDelete({ path, onCancel, onConfirm }: ConfirmDeleteProps) {
  const items = [path, sidecarPathFor(path), assetsPathFor(path)];
  return (
    <div className="confirm-delete-overlay" data-testid="confirm-delete">
      <div className="confirm-delete-dialog">
        <p>Move to trash:</p>
        <ul data-testid="confirm-delete-list">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="confirm-delete-buttons">
          <button type="button" data-testid="confirm-delete-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" data-testid="confirm-delete-confirm" onClick={() => onConfirm(path)}>
            Move to Trash
          </button>
        </div>
      </div>
    </div>
  );
}
