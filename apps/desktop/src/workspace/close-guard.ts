import type { FlushResult } from "./document-sync";

/** What the window does once a close request has flushed the open document. */
export type CloseDecision = { action: "destroy" } | { action: "stay"; waits: string };

/**
 * The close barrier's decision (DECISIONS #review-2-r0 U2): the window closes only when the disk
 * holds the editor's document — `clean` (nothing was pending) or `saved` (the flush wrote it). On
 * `conflict` or `failed` the edit is still dirty, so the window stays open with the banner or the
 * error visible and a line saying why it did not close.
 */
export function decideClose(result: FlushResult): CloseDecision {
  if (result === "conflict") {
    return { action: "stay", waits: "Not closed: choose Reload or Keep mine on 'Changed on disk' first." };
  }
  if (result === "failed") return { action: "stay", waits: "Not closed: this document is not saved yet." };
  return { action: "destroy" };
}
