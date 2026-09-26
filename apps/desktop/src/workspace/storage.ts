/**
 * The "last folder and file restored on launch" persistence (task 2.4's description) lives in the
 * webview's own `localStorage`, which survives a real app relaunch (a new OS process, the same
 * WebView2/WKWebView/WebKitGTK profile) without a new Rust command or IPC round trip — the IPC
 * surface (PRD §6.4) names no such command, and it is not needed: `open_folder` + `list_tree` +
 * `read_doc`, already in the surface, are everything a restore needs to call again.
 */

const KEY = "essaydown:lastWorkspace";

export type LastWorkspace = { folder: string; file: string | null };

function isLastWorkspace(value: unknown): value is LastWorkspace {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.folder === "string" &&
    (typeof candidate.file === "string" || candidate.file === null)
  );
}

/** `null` on first launch, on a cleared workspace, or on a corrupt/foreign value under this key. */
export function readLastWorkspace(): LastWorkspace | null {
  const raw = localStorage.getItem(KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isLastWorkspace(parsed) ? parsed : null;
}

export function writeLastWorkspace(next: LastWorkspace): void {
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function clearLastWorkspace(): void {
  localStorage.removeItem(KEY);
}
