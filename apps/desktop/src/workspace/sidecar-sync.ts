import type { Root } from "mdast";
import { parseSidecar, refresh, type Sidecar } from "@essaydown/core";

/**
 * The write-time half of the sidecar's autosave (task 2.19, DECISIONS #review-2-r0 U5): decides,
 * immediately before every sidecar write, whether the pane's own in-memory sidecar or the file
 * currently on disk is the one to write. `watch.rs` reports `.md` paths only, so a sidecar written
 * by another process between two saves is never seen by the file watcher — only a fresh read at
 * write time catches it.
 */
export interface SidecarWrite {
  readonly action: "write";
  readonly sidecar: Sidecar;
}

export interface SidecarSkip {
  readonly action: "skip";
  readonly error: unknown;
}

export type SidecarWriteChoice = SidecarWrite | SidecarSkip;

/**
 * `knownRaw` is the sidecar's raw JSON text as the pane last read or wrote it (null when it has
 * none); `diskRaw` is a fresh read of the file, taken immediately before this call. `inMemory` is
 * the pane's own sidecar, refreshed against `root` (the document as it stands at this save).
 *
 * Disk unchanged since `knownRaw` means nobody else touched the file since this pane last knew its
 * contents: the pane's own edit is current, and its in-memory sidecar wins. Disk changed to
 * something this pane did not write: PRD §6.2 says the sidecar wins over the pane's copy (this
 * build has no in-app sidecar edit to lose), so the disk's content is taken, re-attached to `root`
 * so its anchors resolve against the document as it stands now — not the stale in-memory copy from
 * `loadDocument`. Disk changed to something that does not parse is never adopted, and never
 * overwritten: the caller reports it and skips the write, leaving the file as the only copy of
 * whatever it holds.
 */
export function chooseSidecarForWrite(
  knownRaw: string | null,
  diskRaw: string | null,
  inMemory: Sidecar,
  root: Root,
): SidecarWriteChoice {
  if (diskRaw !== null) {
    let disk: Sidecar;
    try {
      disk = parseSidecar(JSON.parse(diskRaw));
    } catch (error) {
      return { action: "skip", error };
    }
    if (diskRaw !== knownRaw) return { action: "write", sidecar: refresh(disk, root) };
  }
  return { action: "write", sidecar: refresh(inMemory, root) };
}
