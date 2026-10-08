import { useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isValidPandocFormat, outputPathFor } from "@essaydown/export";
import { exportDocument, type ExportIO } from "./export-sync";

export type ExportDialogProps = {
  io: ExportIO;
  docPath: string;
  onClose: () => void;
  /** The missing-image warning (lesson [4.0]), told to a caller that shows it as a toast outside
   * this dialog — the dialog has already closed by the time it fires (export succeeded). */
  onWarning: (message: string) => void;
};

type Preset = "docx" | "html" | "other";

function formatFor(preset: Preset, other: string): string {
  return preset === "other" ? other.trim() : preset;
}

function notSavedMessage(flush: "conflict" | "failed"): string {
  return flush === "conflict"
    ? "Not exported: choose Reload or Keep mine on 'Changed on disk' first."
    : "Not exported: this document is not saved yet.";
}

/**
 * File → Export (task 4.3's description): DOCX / HTML / an "Other" pandoc writer name, pandoc's
 * stderr streamed live as it arrives (`export:progress`, `export.rs`'s own sibling of `fs:changed`),
 * and `reveal_in_folder` on success. A missing-image warning does not fail the export (lesson
 * [4.0]) — it closes this dialog exactly as a clean export does, and is reported to `onWarning`
 * for the caller's own toast.
 */
export default function ExportDialog({ io, docPath, onClose, onWarning }: ExportDialogProps) {
  const [preset, setPreset] = useState<Preset>("docx");
  const [other, setOther] = useState("");
  const format = formatFor(preset, other);
  const [outPath, setOutPath] = useState(() => outputPathFor(docPath, format));
  const [progress, setProgress] = useState<readonly string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notSaved, setNotSaved] = useState<string | null>(null);
  const formatValid = isValidPandocFormat(format);

  function selectPreset(next: Preset): void {
    setPreset(next);
    const nextFormat = formatFor(next, other);
    if (isValidPandocFormat(nextFormat)) setOutPath(outputPathFor(docPath, nextFormat));
  }

  function changeOther(value: string): void {
    setOther(value);
    const nextFormat = formatFor("other", value);
    if (preset === "other" && isValidPandocFormat(nextFormat)) setOutPath(outputPathFor(docPath, nextFormat));
  }

  async function runExport(): Promise<void> {
    if (!formatValid || running) return;
    setRunning(true);
    setError(null);
    setNotSaved(null);
    setProgress([]);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listen<{ chunk: string }>("export:progress", (event) => {
        setProgress((chunks) => [...chunks, event.payload.chunk]);
      });
      const result = await exportDocument(io, docPath, outPath, format);
      if (result.status === "not-saved") {
        setNotSaved(notSavedMessage(result.flush));
        return;
      }
      if (result.outcome.warning !== null) onWarning(result.outcome.warning);
      onClose();
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      unlisten?.();
      setRunning(false);
    }
  }

  return (
    <div className="settings-overlay" data-testid="export-dialog">
      <div className="settings-dialog">
        <h2>Export</h2>
        <label className="settings-row">
          <input type="radio" name="export-format" data-testid="export-format-docx" checked={preset === "docx"} onChange={() => selectPreset("docx")} />
          DOCX
        </label>
        <label className="settings-row">
          <input type="radio" name="export-format" data-testid="export-format-html" checked={preset === "html"} onChange={() => selectPreset("html")} />
          HTML
        </label>
        <label className="settings-row">
          <input type="radio" name="export-format" data-testid="export-format-other" checked={preset === "other"} onChange={() => selectPreset("other")} />
          Other:
          <input
            type="text"
            data-testid="export-format-other-value"
            value={other}
            disabled={preset !== "other"}
            onChange={(event) => changeOther(event.target.value)}
          />
        </label>
        <label className="settings-row">
          Output path:
          <input
            type="text"
            data-testid="export-out-path"
            value={outPath}
            onChange={(event) => setOutPath(event.target.value)}
          />
        </label>
        {!formatValid && <p data-testid="export-format-invalid">Not a valid pandoc format.</p>}
        {notSaved !== null && <p data-testid="export-not-saved">{notSaved}</p>}
        {error !== null && <p data-testid="export-error">{error}</p>}
        {running && (
          <pre className="export-progress" data-testid="export-progress">
            {progress.join("\n")}
          </pre>
        )}
        <div className="settings-buttons">
          <button type="button" data-testid="export-cancel" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button type="button" data-testid="export-run" onClick={() => void runExport()} disabled={running || !formatValid}>
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
