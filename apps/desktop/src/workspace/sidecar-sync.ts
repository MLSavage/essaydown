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
  /**
   * The sidecar the choice was made against (the pane's own, as the save read it), and whether the
   * disk's sidecar won over it — then `sidecar` is the disk's, to be adopted by the pane's owner.
   */
  readonly basis: Sidecar;
  readonly adopted: boolean;
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
 * something this pane did not write: PRD §6.2 says the sidecar wins over the pane's copy, so the
 * disk's content is taken (and adopted by the pane's owner, {@link SidecarBaseline.wrote}), re-attached to `root`
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
    if (diskRaw !== knownRaw) {
      return { action: "write", sidecar: refresh(disk, root), basis: inMemory, adopted: true };
    }
  }
  return { action: "write", sidecar: refresh(inMemory, root), basis: inMemory, adopted: false };
}

/**
 * The owner of the pane's parsed sidecar. Since task 3.2 that is the document store: the Outline's
 * question and topic fields edit the sidecar through the store (one undo step each), so the store's
 * present sidecar is what every save writes, and a sidecar adopted from the disk has to land there
 * too or the next save would write the store's stale copy over it (DECISIONS #review-2-r1 U5,
 * backlog `[review-2-r1, sidecar baseline vs store]`).
 */
export interface SidecarOwner {
  /** The sidecar the document currently has. */
  current(): Sidecar;
  /** Make `sidecar` the document's sidecar; external state, so not an edit. */
  adopt(sidecar: Sidecar): void;
}

/**
 * The pane's sidecar baseline (tasks 2.23, 3.2, DECISIONS #review-2-r1 U5): the raw JSON text the
 * pane last read or wrote, moved in the same synchronous step as the parsed sidecar it stands for.
 * 2.19 moved the raw text after a write but built the next write from a stale sidecar, so the
 * second save after an external write found the disk equal to the raw baseline and wrote the stale
 * copy over the values it had just adopted. The parsed half lives in the {@link SidecarOwner}; this
 * holds the raw half and moves both in {@link wrote}.
 */
export interface SidecarBaseline {
  /**
   * `chooseSidecarForWrite` with this baseline's raw text. `inMemory` is the owner's sidecar as
   * the save read it, in the same synchronous step as the root it writes.
   */
  choose(diskRaw: string | null, root: Root, inMemory: Sidecar): SidecarWriteChoice;
  /**
   * After `write_sidecar` resolves: the bytes written become the raw baseline, and an adopted
   * disk sidecar becomes the owner's — unless the owner's sidecar moved since the choice (an
   * in-app edit made during the write), which is then kept and written by the save it scheduled.
   */
  wrote(raw: string, choice: SidecarWrite): void;
}

export function createSidecarBaseline(initialRaw: string | null, owner: SidecarOwner): SidecarBaseline {
  let raw = initialRaw;
  return {
    choose: (diskRaw, root, inMemory) => chooseSidecarForWrite(raw, diskRaw, inMemory, root),
    wrote: (nextRaw, choice) => {
      raw = nextRaw;
      if (choice.adopted && owner.current() === choice.basis) owner.adopt(choice.sidecar);
    },
  };
}
