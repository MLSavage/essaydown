/**
 * Autosave and external-change handling for the one open document (task 2.5), as a pure state
 * machine over injected I/O and timers so every rule below is a vitest case (tests/
 * document-sync.test.ts) rather than a WebdriverIO timing.
 *
 * **What it tracks.** `known` is the text this module believes is on disk: what it last read or
 * last wrote. `dirty` means the editor holds an edit not yet written. The two together decide
 * everything:
 *
 * - An edit ({@link DocumentSync.edited}) schedules a save {@link SyncOptions.saveDelayMs} after
 *   the last one (PRD task 2.5: 500 ms). The save reads the disk first; if the disk is no longer
 *   `known`, someone else wrote since, and the save becomes a conflict instead of a write.
 * - A watcher report ({@link DocumentSync.changed}) is debounced by {@link SyncOptions.quietMs},
 *   then the file is read. The same text as `known` is this module's own write echoing back (or a
 *   touch), and is ignored. Shorter text is held for up to {@link SyncOptions.shrinkHoldMs} from
 *   the first shrink, because sync tools write by truncating and then rewriting; a report inside
 *   the hold re-reads, so truncate-then-rewrite settles on the rewritten text as one change. A
 *   settled change reloads silently when clean, and is a conflict when dirty.
 * - A conflict shows the 'Changed on disk' banner and suspends saving until the user picks
 *   {@link DocumentSync.keepMine} (write the editor's text over the disk) or
 *   {@link DocumentSync.reload} (take the disk's text, dropping the edit).
 */

export interface SyncIO {
  /** The document's current bytes on disk. */
  read(): Promise<string>;
  /** Write the editor's document (Markdown + sidecar); `text` is the Markdown being written. */
  write(text: string): Promise<void>;
}

export interface SyncTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface SyncCallbacks {
  /** The canonical Markdown of the editor's document, read at save time. */
  serialize(): string;
  /** A clean document's file changed on disk: replace the editor's document with `text`. */
  reloaded(text: string): void;
  /** The file changed on disk while the editor was dirty: show the banner. */
  conflicted(): void;
  /** `known` moved (a read, a reload, a write). */
  knownChanged(text: string): void;
  /** A read or write failed; the edit stays dirty. */
  failed(error: unknown): void;
}

export interface SyncOptions {
  readonly saveDelayMs: number;
  readonly quietMs: number;
  readonly shrinkHoldMs: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  saveDelayMs: 500,
  // Short enough that an external append is on screen well inside a second (the acceptance), long
  // enough to fold the several events one write raises (create, modify, rename) into one read.
  quietMs: 100,
  // "file shrinks then grows within 2 s" (task 2.5).
  shrinkHoldMs: 2000,
};

export interface DocumentSync {
  /** The editor's document changed. */
  edited(): void;
  /** The watcher reported this document. */
  changed(): void;
  /** Resolve a conflict by writing the editor's document over the disk. */
  keepMine(): Promise<void>;
  /** Resolve a conflict by taking the disk's document. */
  reload(): Promise<void>;
  /** Save now if dirty (before a rename or a switch), whatever the timer says. */
  flush(): Promise<void>;
  /** Stop every timer; later reports and edits are ignored. */
  dispose(): void;
  readonly dirty: boolean;
  readonly conflict: boolean;
}

export function createDocumentSync(
  initialText: string,
  io: SyncIO,
  callbacks: SyncCallbacks,
  timers: SyncTimers,
  options: SyncOptions = DEFAULT_SYNC_OPTIONS,
): DocumentSync {
  let known = initialText;
  let dirty = false;
  let conflict = false;
  let disposed = false;
  // Bumped on every edit, so a save that finishes after a later edit leaves the document dirty.
  let generation = 0;
  let saveTimer: unknown = null;
  let changeTimer: unknown = null;
  let holdStartedAt: number | null = null;

  const setKnown = (text: string): void => {
    known = text;
    callbacks.knownChanged(text);
  };

  const clearSave = (): void => {
    if (saveTimer !== null) timers.clearTimeout(saveTimer);
    saveTimer = null;
  };

  const clearChange = (): void => {
    if (changeTimer !== null) timers.clearTimeout(changeTimer);
    changeTimer = null;
  };

  const enterConflict = (): void => {
    clearSave();
    if (conflict) return;
    conflict = true;
    callbacks.conflicted();
  };

  const write = async (): Promise<void> => {
    const at = generation;
    const text = callbacks.serialize();
    const previous = known;
    // Known before the write lands, so the watcher's echo of this write already reads as ours.
    setKnown(text);
    try {
      await io.write(text);
    } catch (error) {
      setKnown(previous);
      callbacks.failed(error);
      return;
    }
    if (generation === at) dirty = false;
  };

  const save = async (): Promise<void> => {
    saveTimer = null;
    if (disposed || conflict || !dirty) return;
    let disk: string;
    try {
      disk = await io.read();
    } catch (error) {
      callbacks.failed(error);
      return;
    }
    if (disposed || conflict) return;
    if (disk !== known) {
      enterConflict();
      return;
    }
    await write();
  };

  const check = async (): Promise<void> => {
    changeTimer = null;
    if (disposed) return;
    let disk: string;
    try {
      disk = await io.read();
    } catch (error) {
      // A file that is gone mid-rewrite reads as a failure; the rewrite's own report re-checks.
      callbacks.failed(error);
      return;
    }
    if (disposed) return;
    if (disk === known) {
      holdStartedAt = null;
      return;
    }
    if (disk.length < known.length) {
      const now = timers.now();
      holdStartedAt ??= now;
      const left = holdStartedAt + options.shrinkHoldMs - now;
      if (left > 0) {
        changeTimer = timers.setTimeout(() => void check(), left);
        return;
      }
    }
    holdStartedAt = null;
    if (dirty || conflict) {
      enterConflict();
      return;
    }
    setKnown(disk);
    callbacks.reloaded(disk);
  };

  return {
    edited() {
      if (disposed) return;
      generation += 1;
      dirty = true;
      if (conflict) return;
      clearSave();
      saveTimer = timers.setTimeout(() => void save(), options.saveDelayMs);
    },
    changed() {
      if (disposed) return;
      clearChange();
      changeTimer = timers.setTimeout(() => void check(), options.quietMs);
    },
    async keepMine() {
      if (disposed) return;
      conflict = false;
      clearSave();
      await write();
    },
    async reload() {
      if (disposed) return;
      clearSave();
      let disk: string;
      try {
        disk = await io.read();
      } catch (error) {
        callbacks.failed(error);
        return;
      }
      conflict = false;
      dirty = false;
      generation += 1;
      setKnown(disk);
      callbacks.reloaded(disk);
    },
    async flush() {
      if (disposed || !dirty || conflict) return;
      clearSave();
      await save();
    },
    dispose() {
      disposed = true;
      clearSave();
      clearChange();
    },
    get dirty() {
      return dirty;
    },
    get conflict() {
      return conflict;
    },
  };
}
